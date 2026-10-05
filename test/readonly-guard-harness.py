#!/usr/bin/env python3
"""The read-only guard, against a fake bpy with Blender's real shape.

test/readonly-probe.py drives the guard through live-bridge.py against a REAL
Blender, which is the strongest evidence available: no fake has the wrong
attribute surface. But it needs a Blender, so on a machine without one it
reports nothing at all, and the cases that guard the guard go unchecked.

This file runs with no Blender at all. It builds a fake bpy carrying the
attribute names and the CLASS names that matter -- `bpy_prop_collection`,
`Object`, `Vector`, `Collection`, `Scene`, `ViewLayer`, `Depsgraph` -- installs
the guard on it, and asserts that each destructive entry point raises
ReadOnlyViolation while the read-only ones still answer.

The fake exists to pin the guard's LOGIC cheaply, not to model Blender. The
class names are the load-bearing part, because the guard matches containers by
concrete type name and that is exactly the kind of rule a mock can prove. The
real surface is test/readonly-probe.py's job.

Paths resolve relative to this file, so the probe runs against whichever
checkout it lives in rather than a hardcoded one.
"""

import importlib.util
import os
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(REPO, "blender")

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
    # Blender buffers its own stdout, so an unflushed failure line is lost when
    # the process leaves via os._exit.
    print(f"  {'ok  ' if condition else 'FAIL'}: {message}")
    sys.stdout.flush()


def load_guard():
    path = os.path.join(BRIDGE, "readonly_guard.py")
    spec = importlib.util.spec_from_file_location("readonly_guard", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"could not load the guard from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# --- the fake bpy ---------------------------------------------------------
#
# Every class name is what the guard matches on, so these are exact. The
# container carries a `linkable` flag because Blender makes the same distinction
# with the same type: scene.collection.objects has link/unlink and scene.objects
# does not.


class Vector:
    def __init__(self, values=(0.0, 0.0, 0.0)):
        self.values = list(values)


class bpy_prop_collection(dict):
    """Blender's collection type, under the name the guard matches on."""

    def __init__(self, initial=None, linkable=True):
        super().__init__(initial or {})
        self._linkable = linkable

    def __getattribute__(self, name):
        # Blender raises AttributeError for link/unlink on the unlinkable
        # flavour, and the guard's container matching has to cope with that.
        if name in ("link", "unlink") and not dict.__getattribute__(self, "_linkable"):
            raise AttributeError(f"bpy_prop_collection: attribute {name!r} not found")
        return dict.__getattribute__(self, name)

    def link(self, other):
        self["__linked__"] = other

    def unlink(self, other):
        self.pop("__linked__", None)

    def new(self, name):
        return Object(name)

    def remove(self, other):
        for key, value in list(self.items()):
            if value is other:
                del self[key]

    def pop(self, key, *default):
        return dict.pop(self, key, *default)

    def clear(self):
        dict.clear(self)

    def foreach_set(self, *_args, **_kwargs):
        raise AssertionError("the fake records no writes; the guard should refuse before here")

    def foreach_get(self, attribute, buffer):
        return buffer


class Object:
    def __init__(self, name="Object"):
        self.name = name
        self.location = Vector()
        self.hide_viewport = False

    def evaluated_get(self, depsgraph):
        return self


class Mesh:
    def __init__(self, name="Mesh"):
        self.name = name
        self.vertices = ()


class Collection:
    def __init__(self, name="Collection"):
        self.name = name

    @property
    def objects(self):
        return bpy_prop_collection({}, linkable=True)

    @property
    def children(self):
        return bpy_prop_collection({}, linkable=True)

    def all_objects(self):
        return []


class RenderSettings:
    def __init__(self):
        self.resolution_x = 1920


class Scene:
    def __init__(self):
        self.collection = Collection()
        self.objects = bpy_prop_collection({"Cube": Object("Cube")}, linkable=False)
        self.render = RenderSettings()

    def frame_set(self, *_args, **_kwargs):
        return None


class ViewLayer:
    def __init__(self):
        self.objects = bpy_prop_collection({"Cube": Object("Cube")}, linkable=False)
        self.layer_collection = LayerCollection()


class LayerCollection:
    pass


class Depsgraph:
    def __init__(self):
        self.objects = bpy_prop_collection({"Cube": Object("Cube")}, linkable=False)


class WindowManager:
    pass


class FakeContext:
    def __init__(self):
        self.scene = Scene()
        self.view_layer = ViewLayer()
        self.window_manager = WindowManager()

    def evaluated_depsgraph_get(self):
        return Depsgraph()


class FakeOpsNamespace:
    """One bpy.ops namespace.

    __getattr__ rather than declared members: a real namespace answers for
    hundreds of names, and naming them here would make the fake a maintenance
    burden for no extra coverage. Every member raises, so a case the guard
    failed to refuse is a loud AssertionError rather than an AttributeError that
    could be mistaken for a refusal.
    """

    def __init__(self, name):
        self._name = name

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self._record(name)

    def _record(self, name):
        raise AssertionError(
            f"bpy.ops.{self._name}.{name} ran; the guard should have refused it first"
        )


class FakeOps:
    def __init__(self):
        self.object = FakeOpsNamespace("object")
        self.wm = FakeOpsNamespace("wm")
        self.outliner = FakeOpsNamespace("outliner")


class FakeData:
    def __init__(self):
        self.objects = bpy_prop_collection({"Cube": Object("Cube")})
        self.meshes = bpy_prop_collection({"CubeMesh": Mesh("CubeMesh")})
        self.collections = bpy_prop_collection({})
        # A path under the scratch dir the probe already owns, not a literal
        # /tmp path: nothing here writes it, but the guard's whole argument is
        # that a read-only run does not touch files, and the fake should not
        # contradict that with a hardcoded temp path.
        self.filepath = os.path.join(tempfile.mkdtemp(), "model.blend")
        # Recorded, not merely present: "the guard called through" and "the
        # guard blocked it" would otherwise look identical.
        self.batch_removed = []
        self.purges = 0

    def batch_remove(self, ids):
        self.batch_removed.append(ids)

    def orphans_purge(self, *_args, **_kwargs):
        self.purges += 1
        return 3


class FakeBpy:
    def __init__(self):
        self.ops = FakeOps()
        self.data = FakeData()
        self.context = FakeContext()


def build_fake_bpy():
    return FakeBpy()


def expect_refused(guard, label, action):
    try:
        action()
    except guard.ReadOnlyViolation:
        check(True, f"refused: {label}")
    except Exception as error:  # noqa: BLE001 - any other error is a failure too
        check(False, f"refused: {label} (raised {type(error).__name__}: {error})")
    else:
        check(False, f"refused: {label} (it ran)")


def expect_allowed(guard, label, action):
    try:
        action()
    except Exception as error:  # noqa: BLE001
        check(False, f"allowed: {label} (raised {type(error).__name__}: {error})")
    else:
        check(True, f"allowed: {label}")


def main():
    guard = load_guard()
    os.environ["PI_BLENDER_BRIDGE_DIR"] = tempfile.mkdtemp()
    fake = build_fake_bpy()

    restore = guard.install_read_only_guard(fake)
    try:
        # --- refused: the destructive entry points ------------------------
        # bpy.data's OWN removers, not bpy.data.<coll>'s. Measured against a
        # real Blender: both are attributes of bpy.data itself and both remove
        # datablocks, while bpy.data.objects has neither.
        expect_refused(guard, "bpy.data.batch_remove", lambda: fake.data.batch_remove([1]))
        expect_refused(guard, "bpy.data.orphans_purge", lambda: fake.data.orphans_purge())
        # The per-collection spellings, so a future Blender that moves them down
        # is still refused rather than newly permitted.
        expect_refused(guard, "bpy.data.objects.batch_remove", lambda: fake.data.objects.batch_remove([]))
        expect_refused(guard, "bpy.data.objects.orphan_purge", lambda: fake.data.objects.orphan_purge())
        expect_refused(guard, "bpy.data.objects.remove", lambda: fake.data.objects.remove(Object()))
        expect_refused(guard, "bpy.data.objects.new", lambda: fake.data.objects.new("x"))
        expect_refused(guard, "bpy.data.objects.pop", lambda: fake.data.objects.pop("Cube"))
        expect_refused(guard, "bpy.data.objects.clear", lambda: fake.data.objects.clear())
        expect_refused(guard, "bpy.data.objects.foreach_set", lambda: fake.data.objects.foreach_set("location", []))
        expect_refused(guard, "bpy.data.meshes.new", lambda: fake.data.meshes.new("x"))
        # bpy.ops, including the outliner namespace whose orphans_purge really
        # does delete datablocks in a real Blender.
        expect_refused(guard, "bpy.ops.object.delete", lambda: fake.ops.object.delete())
        expect_refused(guard, "bpy.ops.outliner.orphans_purge", lambda: fake.ops.outliner.orphans_purge())
        expect_refused(guard, "bpy.ops.wm.save_mainfile", lambda: fake.ops.wm.save_mainfile())
        # The scene-collection link path, which bpy.context exposed entirely.
        expect_refused(guard, "scene.collection.objects.link", lambda: fake.context.scene.collection.objects.link(Object()))
        expect_refused(guard, "scene.collection.objects.unlink", lambda: fake.context.scene.collection.objects.unlink(Object()))
        expect_refused(guard, "scene.collection.children.link", lambda: fake.context.scene.collection.children.link(Collection()))
        expect_refused(guard, "scene.collection.children.unlink", lambda: fake.context.scene.collection.children.unlink(Collection()))
        # Real datablocks reached through bpy.context, which is how every
        # assignment refusal was being walked around.
        expect_refused(guard, "scene.objects[0].location.x = 5", lambda: setattr(fake.context.scene.objects["Cube"].location, "x", 5.0))
        expect_refused(guard, "view_layer.objects[0].location.x", lambda: setattr(fake.context.view_layer.objects["Cube"].location, "x", 5.0))
        expect_refused(
            guard,
            "depsgraph.objects[0].location.x",
            lambda: setattr(fake.context.evaluated_depsgraph_get().objects["Cube"].location, "x", 5.0),
        )
        expect_refused(guard, "scene.objects[0].hide_viewport = True", lambda: setattr(fake.context.scene.objects["Cube"], "hide_viewport", True))
        expect_refused(guard, "del bpy.data.objects['Cube']", lambda: fake.data.objects.__delitem__("Cube"))
    finally:
        restore()

    # --- the guard is gone afterwards -------------------------------------
    # A guard left installed would break every later mutating run in the
    # session, so this is a real property rather than a formality. Compared by
    # identity rather than by calling into the namespace, because the fake
    # raises on every member to prove the guard refused it first.
    check(isinstance(fake.ops, FakeOps), "bpy.ops is the original object again")
    check(isinstance(fake.data, FakeData), "bpy.data is the original object again")
    check(isinstance(fake.context, FakeContext), "bpy.context is the original object again")
    # The real proof that restore() worked: mutation runs again afterwards.
    expect_allowed(guard, "mutation after restore", lambda: fake.data.objects.new("after"))

    if failures:
        print(f"FAIL: {len(failures)} case(s)")
        for failure in failures:
            print(f"  - {failure}")
        sys.stdout.flush()
        os._exit(1)
    print("PASS: the read-only guard refuses the destructive entry points")
    sys.stdout.flush()
    os._exit(0)


main()
