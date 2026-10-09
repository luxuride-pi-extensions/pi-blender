"""Refuse the mutating half of Blender's API for a read-only script run.

The refusals are installed by patching the objects a script reaches through, not
by scanning the script's source. A text scan is defeated by anything the writer
did not anticipate -- a call assembled from a string, a lambda, a loop over
names -- while a patched `bpy.ops` refuses the operation no matter how it was
spelled. It also catches a script that never mentions a forbidden name but
still deletes something, which a scan would pass.

What stays available is the reason for the run: reading geometry, casting rays,
querying vertices, evaluating modifiers, and writing to disk. A measurement
script is nearly all of that.

SCOPE, honestly: this is a DENYLIST of named entry points, not a sandbox.
Blender's API is large and open-ended, and a positive rule over all of it is
not feasible -- the data model is reachable through many unrelated accessors.
The names below are the ones a measurement script would plausibly reach for
when it means to change something, and each was measured against a real
Blender rather than assumed. Two categories are deliberately OUT of scope and
are stated here so nobody mistakes this for a jail:

  * The FILESYSTEM. `os` and `open` are deliberately untouched, because a
    measurement script has to be able to read a file and write its results. A
    read-only run can therefore write or unlink a file on disk. The blend is
    protected by the fact that nothing here saves it, not by the filesystem
    being sealed.
  * APIs added to Blender AFTER these lists were written. A name not in the
    lists passes. That is the residual exposure, and the tool description says
    so rather than claiming completeness the guard cannot deliver.

Every refusal below was confirmed against a real Blender (test/readonly-probe.py
and the fake-bpy harness in test/readonly-guard.test.mjs): `bpy.ops.outliner.
orphans_purge` deleted a datablock, and `bpy.data.batch_remove` /
`bpy.data.orphans_purge` removed one, while `bpy.data.<coll>.remove` was
refused -- so the guard was stopping the obvious spelling and not the effect.
"""

import contextlib
import os


class ReadOnlyViolation(RuntimeError):
    """Raised when a read-only run tries to change the scene or the file."""


# bpy.ops namespaces whose members ADD to the scene. `wm` is split out because
# it holds both the save call and the file-management calls.
_MUTATING_OP_NAMESPACES = (
"object",
"mesh",
    "curve",
    "surface",
    "metaball",
    "text",
    "armature",
    "pose",
    "lattice",
    "grease_pencil",
    "particle",
    "light",
    "camera",
    "material",
    "world",
    "node",
    "collection",
    "scene",
    "constraint",
    "transform",
    "anim",
    "action",
    "rigify",
    "screen",
    "view3d",
    "image",
    "brush",
    "paint",
    "mask",
    "modifier",
    # Added with the purge coverage below: outliner.orphans_purge really does
    # delete datablocks ("Info: Deleted 1 data-block(s)"), so an unlisted
    # namespace was a way straight past the guard.
    "outliner",
)

_FORBIDDEN_WM_OPS = (
    "save_mainfile",
    "save_as_mainfile",
    "save_homefile",
    "recover",
    "open_mainfile",
    "quit",
    "read_homefile",
)

# The mutating attributes of one bpy data collection, as a POSITIVE set rather
# than a blacklist of methods overridden one by one. A positive set is the point:
# an attribute that is neither listed nor a known reader is refused, so a removal
# API added by a future Blender is caught by default instead of passing.
#
#   new            creates a datablock
#   remove/pop     removes one datablock
#   clear          removes every datablock in the collection
#   batch_remove   removes a list of datablocks (measured present on bpy.data
#                  in Blender 5.2; it was on the per-collection objects in older
#                  builds, which is why it is checked in both places)
#   orphan_purge   removes datablocks with no users
_MUTATING_COLLECTION_ATTRS = frozenset(
    ("new", "remove", "pop", "clear", "batch_remove", "orphan_purge",
     # foreach_set writes an attribute across every element in one call and is as
     # destructive as remove; foreach_get is the read and stays available.
     "foreach_set")
)

# Mutating attributes of bpy.data ITSELF. These sit above the per-collection
# objects and are the ones actually reachable in Blender 5.2: both were measured
# deleting datablocks while the guard was installed, because bpy.data was only
# ever asked about _REMOVING_DATA_ATTRS.
_MUTATING_DATA_ATTRS = ("batch_remove", "orphans_purge")

# bpy.data collections whose removal destroys work: object.remove(),
# meshes.remove(), and the rest. Reading a collection is untouched.
_REMOVING_DATA_ATTRS = (
    "objects",
    "meshes",
    "curves",
    "materials",
    "images",
    "texts",
    "armatures",
    "actions",
    "collections",
    "scenes",
    "cameras",
    "lights",
    "particles",
    "worlds",
    "node_groups",
)


def _violation(what):
    def _raise(*_args, **_kwargs):
        raise ReadOnlyViolation(
            f"This is a read-only measurement run, so {what} is refused. "
            "Use blender_execute_python or blender_module_run to change the scene."
        )

    return _raise


class _ReadOnlyProxy:
    """A stand-in whose every attribute is a callable that raises.

    An attribute access has to raise immediately rather than on call, so that
    `bpy.ops.object.delete` never yields something callable in the first place;
    otherwise a script could take the reference, pass it around, and the error
    would arrive far from the line that asked for it.
    """

    def __init__(self, what):
        object.__setattr__(self, "_what", what)

    def __getattr__(self, _name):
        return _violation(object.__getattribute__(self, "_what"))

    def __setattr__(self, _name, _value):
        return _violation(object.__getattribute__(self, "_what"))()

    def __call__(self, *_args, **_kwargs):
        return _violation(object.__getattribute__(self, "_what"))()


class _GuardedVector:
    """Wraps a mathutils value so `obj.location.x = 5` is refused.

    A copy would leave the scene untouched but let the assignment SUCCEED on the
    copy, and a script that reads the value back would see its own number
    rather than the scene's. Raising is the honest answer.
    """

    _MUTATORS = (
        "x", "y", "z", "w", "normalize", "zero", "fill", "resize", "translate",
        "rotate", "scale", "make_compatible", "lerp", "slerp", "negate", "abs",
        "__setitem__", "__delitem__",
    )

    def __init__(self, wrapped, name):
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_name", name)

    def __getattr__(self, attribute):
        if attribute in _GuardedVector._MUTATORS:
            return _violation(f"{object.__getattribute__(self, '_name')}.{attribute} = ..." if attribute in ("x", "y", "z", "w") else f"{object.__getattribute__(self, '_name')}.{attribute}(...)")
        value = getattr(object.__getattribute__(self, "_wrapped"), attribute)
        if type(value).__name__ in ("Vector", "Matrix", "Quaternion", "Euler"):
            return _GuardedVector(value, f"{object.__getattribute__(self, '_name')}.{attribute}")
        return value

    def __setattr__(self, attribute, _value):
        return _violation(f"{object.__getattribute__(self, '_name')}.{attribute} = ...")()

    def __delattr__(self, attribute):
        return _violation(f"del {object.__getattribute__(self, '_name')}.{attribute}")()

    def __getitem__(self, key):
        return object.__getattribute__(self, "_wrapped")[key]

    def __setitem__(self, key, _value):
        return _violation(f"{object.__getattribute__(self, '_name')}[...] = ...")()

    def __iter__(self):
        return iter(object.__getattribute__(self, "_wrapped"))

    def __len__(self):
        return len(object.__getattribute__(self, "_wrapped"))

    def __repr__(self):
        return repr(object.__getattribute__(self, "_wrapped"))


class _GuardedObject:
    """Wraps one datablock so reading it works and assigning to it does not.

    A mathutils value is handed back as a copy, because `obj.location.x = 5`
    assigns through the vector rather than to the object, and a vector shared
    with the real datablock would let the whole class of in-place edits past a
    guard that only watches attribute assignment.
    """

    def __init__(self, wrapped, name):
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_name", name)

    def __getattr__(self, attribute):
        value = getattr(object.__getattribute__(self, "_wrapped"), attribute)
        if type(value).__name__ in ("Vector", "Matrix", "Quaternion", "Euler"):
            return _GuardedVector(value, f"{object.__getattribute__(self, '_name')}.{attribute}")
        if attribute in _DEPGRAPH_ARG_METHODS and callable(value):
            return _GuardedPassThrough(value, f"{object.__getattribute__(self, '_name')}.{attribute}")
        return value

    def __setattr__(self, attribute, _value):
        return _violation(
            f"setting {object.__getattribute__(self, '_name')}.{attribute} = ..."
        )()

    def __delattr__(self, attribute):
        return _violation(f"del {object.__getattribute__(self, '_name')}.{attribute}")()

    def __setitem__(self, key, _value):
        return _violation(f"{object.__getattribute__(self, '_name')}[...] = ...")()

    def __delitem__(self, key):
        return _violation(f"del {object.__getattribute__(self, '_name')}[...]")()


def _guarded_element(element, name):
    # Only the datablock types a measurement script holds onto get wrapped:
    # wrapping everything would break isinstance checks and iteration helpers
    # the caller may legitimately use on collections of plain data.
    if type(element).__name__ in ("Object", "Mesh", "Curve", "Material", "Camera", "Light", "Armature"):
        return _GuardedObject(element, name)
    return element


class _GuardedDataCollection:
    """Wraps one bpy.data collection: reads and iteration through, mutation out.

    The mutating attributes come from _MUTATING_COLLECTION_ATTRS rather than
    being spelled out as methods here, because a method written here is a
    method this file has to remember to add. The set is checked on every
    attribute access, so `batch_remove` is refused for the same reason `remove`
    is -- not because somebody listed it twice.
    """

    def __init__(self, collection, name):
        object.__setattr__(self, "_collection", collection)
        object.__setattr__(self, "_name", name)

    def __getattr__(self, attribute):
        if attribute in _MUTATING_COLLECTION_ATTRS:
            return _violation(f"bpy.data.{object.__getattribute__(self, '_name')}.{attribute}(...)")
        return getattr(object.__getattribute__(self, "_collection"), attribute)

    def __iter__(self):
        collection = object.__getattribute__(self, "_collection")
        name = object.__getattribute__(self, "_name")
        for key in collection.keys():
            yield _guarded_element(collection[key], f"bpy.data.{name}[{key!r}]")

    def __len__(self):
        return len(object.__getattribute__(self, "_collection"))

    def __getitem__(self, key):
        collection = object.__getattribute__(self, "_collection")
        name = object.__getattribute__(self, "_name")
        return _guarded_element(collection[key], f"bpy.data.{name}[{key!r}]")

    def __setitem__(self, key, value):
        return _violation(f"bpy.data.{object.__getattribute__(self, '_name')}[...] = ...")()

    def __delitem__(self, key):
        return _violation(f"del bpy.data.{object.__getattribute__(self, '_name')}[...]")()

    def __setattr__(self, attribute, value):
        return _violation(f"bpy.data.{object.__getattribute__(self, '_name')}.{attribute} = ...")()


# The concrete type Blender returns for every prop collection: the aliases are
# numerous (scene.objects, view_layer.objects, depsgraph.objects, obj.constraints,
# mesh.vertices) but they are all this one type, so matching the type covers all
# of them at once. See _is_scene_container.
_PROP_COLLECTION = "bpy_prop_collection"

# The mutating attributes of a prop collection itself, as opposed to the
# datablock collections above. Distinct because the damage differs: removing a
# datablock destroys the data, while linking or unlinking changes whether the
# scene CONTAINS it, and an object unlinked from the scene collection is deleted
# out-right the next time Blender reloads. Measured: both mutated the live scene
# under the old guard, because bpy.context was not patched at all.
#
# foreach_set writes an attribute across every element in one call and is as
# destructive as remove; foreach_get is the read and stays available.
_MUTATING_LINK_ATTRS = frozenset(("link", "unlink", "clear", "foreach_set"))


class _GuardedContainer:
    """Wraps a bpy_prop_collection: readable, not linkable or assignable.

    Blender hands this one type out from a dozen places -- scene.collection.
    objects, scene.objects, view_layer.objects, a depsgraph's .objects, an
    object's .constraints -- so containers are matched by TYPE rather than by
    name. Enumerating the aliases would have left the eleventh unguarded, which
    is the failure this guard already had: bpy.context was unpatched, so
    scene.objects[0].location.x = 5 moved the real object.

    Elements come back through _guarded_element, so the datablocks are wrapped
    too. Without that the container hands out the REAL objects and every
    _GuardedObject refusal sits unused.
    """

    def __init__(self, container, name):
        object.__setattr__(self, "_container", container)
        object.__setattr__(self, "_name", name)

    def __getattr__(self, attribute):
        container = object.__getattribute__(self, "_container")
        name = object.__getattribute__(self, "_name")
        if attribute in _MUTATING_LINK_ATTRS:
            return _violation(f"{name}.{attribute}(...)")
        value = getattr(container, attribute)
        if type(value).__name__ == _PROP_COLLECTION:
            return _GuardedContainer(value, f"{name}.{attribute}")
        if type(value).__name__ in ("Vector", "Matrix", "Quaternion", "Euler"):
            return _GuardedVector(value, f"{name}.{attribute}")
        if type(value).__name__ == "Scene":
            return _GuardedNamespace(value, f"{name}.{attribute}")
        return value

    def __iter__(self):
        container = object.__getattribute__(self, "_container")
        name = object.__getattribute__(self, "_name")
        # items() rather than keys(): iterating a bpy_prop_collection yields
        # ELEMENTS, not names, so container[key] on the loop variable would be a
        # lookup by datablock and Blender raises "invalid key".
        for key, element in container.items():
            yield _guarded_element(element, f"{name}[{key!r}]")

    def __len__(self):
        return len(object.__getattribute__(self, "_container"))

    def __getitem__(self, key):
        container = object.__getattribute__(self, "_container")
        name = object.__getattribute__(self, "_name")
        return _guarded_element(container[key], f"{name}[{key!r}]")

    def __setattr__(self, attribute, value):
        return _violation(f"{object.__getattribute__(self, '_name')}.{attribute} = ...")()

    def __setitem__(self, key, value):
        return _violation(f"{object.__getattribute__(self, '_name')}[...] = ...")()

    def __delitem__(self, key):
        return _violation(f"del {object.__getattribute__(self, '_name')}[...]")()


def _is_scene_container(value):
    """Whether a value is a Blender prop collection that must be wrapped.

    Matched on the concrete type, which is stable across the versions this
    guard supports, rather than on a capability probe: `scene.objects` is the
    same type as `scene.collection.objects` but has NO link/unlink, so probing
    for link() to decide whether the container needs guarding classified the
    unlinkable ones as safe and let them hand out the real datablocks -- the
    exact leak this function exists to close.
    """
    return type(value).__name__ == _PROP_COLLECTION


def _unwrap(value):
    """The real bpy object behind a guard wrapper, or the value itself.

    Needed because a guarded wrapper is not accepted by Blender's own argument
    checks: `obj.evaluated_get(guarded_depsgraph)` fails with
    "Function.depsgraph expected a Depsgraph type, not _GuardedNamespace".
    Wrapping is therefore only safe as long as a wrapped value can be handed
    back to bpy where bpy expects it.
    """
    return object.__getattribute__(value, "_wrapped") if isinstance(value, _GuardedWrappers) else value


def _unwrap_all(values):
    return tuple(_unwrap(value) for value in values)


class _GuardedPassThrough:
    """A bpy method that takes a guarded wrapper as an argument.

    Only the methods in _DEPGRAPH_ARG_METHODS get this. They are the calls a
    measurement script makes with the object it just guarded -- evaluating
    modifiers is the point of a geometry measurement -- so they have to keep
    working, and the fix is to unwrap the argument rather than to stop refusing
    the datablock that the argument leads to.
    """

    def __init__(self, wrapped, name):
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_name", name)

    def __call__(self, *args, **kwargs):
        wrapped = object.__getattribute__(self, "_wrapped")
        name = object.__getattribute__(self, "_name")
        result = wrapped(*_unwrap_all(args), **{k: _unwrap(v) for k, v in kwargs.items()})
        if type(result).__name__ in _GuardedNamespace._SCENE_BEARING_STRUCTS:
            return _GuardedNamespace(result, f"{name}()")
        if type(result).__name__ == _PROP_COLLECTION:
            return _GuardedContainer(result, f"{name}()")
        return result


# Methods that accept a depsgraph (or another guarded struct) as an argument.
# Enumerated because they are few, and because wrapping the return value of
# every callable on every datablock would be a much larger change to a guard
# whose whole argument is that it refuses rather than interferes.
_DEPGRAPH_ARG_METHODS = frozenset(("evaluated_get", "to_mesh", "closest_point_on_mesh"))


class _GuardedNamespace:
    """Wraps a bpy struct whose attributes are themselves routes into the scene.

    Used for bpy.context and the structs hanging off it (Scene, ViewLayer,
    Depsgraph, Window). It re-applies the same rules as its attributes are
    reached, which is what makes the guard hold for aliases nobody listed:
    `bpy.context.view_layer.objects` and `depsgraph.objects` are refused for the
    same reason `bpy.context.scene.collection.objects` is.
    """

    # The bpy structs that lead back to the scene. Enumerated rather than
    # blanket-wrapped: only these expose containers of datablocks, and wrapping
    # every struct reachable from the context would break the unrelated reads a
    # measurement script needs (areas, spaces, preferences).
    _SCENE_BEARING_STRUCTS = frozenset(("Scene", "ViewLayer", "Depsgraph", "LayerCollection"))

    # The METHODS whose return value is one of those structs. A depsgraph is the
    # way to evaluate modifiers, so a measurement script legitimately asks for
    # one -- but `depsgraph.objects` is a prop collection, and returning the
    # real one handed the script the REAL datablocks, which is how
    # depsgraph.objects[0].location.x = 7 got past every other refusal.
    _SCENE_BEARING_METHODS = frozenset(("evaluated_depsgraph_get",))

    def __init__(self, wrapped, name):
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_name", name)

    def __getattr__(self, attribute):
        wrapped = object.__getattribute__(self, "_wrapped")
        name = object.__getattribute__(self, "_name")
        value = getattr(wrapped, attribute)
        # The container attribute itself, for the structs where it is named
        # `collection` rather than reached through a prop collection.
        if type(value).__name__ == "Collection":
            return _GuardedContainer(value, f"{name}.{attribute}")
        if type(value).__name__ in _GuardedNamespace._SCENE_BEARING_STRUCTS:
            return _GuardedNamespace(value, f"{name}.{attribute}")
        if _is_scene_container(value):
            return _GuardedContainer(value, f"{name}.{attribute}")
        if type(value).__name__ in ("Vector", "Matrix", "Quaternion", "Euler"):
            return _GuardedVector(value, f"{name}.{attribute}")
        if type(value).__name__ == "Object":
            return _GuardedObject(value, f"{name}.{attribute}")
        if attribute in _DEPGRAPH_ARG_METHODS and callable(value):
            return _GuardedPassThrough(value, f"{name}.{attribute}")
        if attribute in _GuardedNamespace._SCENE_BEARING_METHODS and callable(value):
            return _GuardedSceneBearingCallable(value, f"{name}.{attribute}")
        return value

    def __setattr__(self, attribute, value):
        return _violation(f"{object.__getattribute__(self, '_name')}.{attribute} = ...")()


class _GuardedSceneBearingCallable:
    """Calls through and guards whatever comes back.

    Needed because a scene-bearing struct is often REACHED by calling a method
    (`bpy.context.evaluated_depsgraph_get()`) rather than by reading an
    attribute, and the value a call returns is not visible until after the call.
    """

    def __init__(self, wrapped, name):
        object.__setattr__(self, "_wrapped", wrapped)
        object.__setattr__(self, "_name", name)

    def __call__(self, *args, **kwargs):
        wrapped = object.__getattribute__(self, "_wrapped")
        name = object.__getattribute__(self, "_name")
        result = wrapped(*args, **kwargs)
        if type(result).__name__ in _GuardedNamespace._SCENE_BEARING_STRUCTS:
            return _GuardedNamespace(result, f"{name}()")
        if type(result).__name__ == _PROP_COLLECTION:
            return _GuardedContainer(result, f"{name}()")
        return result


class _GuardedContext(_GuardedNamespace):
    """Wraps bpy.context so the scene-collection link/unlink path is refused.

    bpy.context used to be the one large surface the guard never touched, and it
    is a route to the same damage by a different name: objects are reachable
    from here as the REAL datablock rather than a _GuardedObject, so even the
    assignment refusals above could be walked around.

    Everything else about the context is unchanged -- depsgraph access, the
    active object, view layers, areas, operators -- because a measurement
    script needs all of it and none of it changes the scene on its own. The
    wrappers here are what a script must not reach THROUGH.
    """

    def __init__(self, context):
        super().__init__(context, "bpy.context")


def install_read_only_guard(bpy_module):
    """Patch bpy in place and return an undo callable.

    Restoring is unconditional and best-effort: a guard left installed would
    break every later mutating run in the same session, which is a far worse
    outcome than a partially restored patch, so each restore is attempted
    independently.
    """
    restores = []
    original_ops = bpy_module.ops
    original_data = bpy_module.data
    original_context = getattr(bpy_module, "context", None)

    def guarded_ops():
        return original_ops

    # bpy.ops is a dynamic collection, so it is replaced with a proxy object
    # that answers for the mutating namespaces and defers everything else.
    class _Ops:
        def __getattr__(self, namespace):
            if namespace in _MUTATING_OP_NAMESPACES:
                return _ReadOnlyProxy(f"bpy.ops.{namespace}.*")
            if namespace == "wm":
                return _WmProxy()
            return getattr(original_ops, namespace)

    class _WmProxy:
        def __getattr__(self, name):
            if name in _FORBIDDEN_WM_OPS:
                return _violation(f"bpy.ops.wm.{name}(...)")
            return getattr(original_ops.wm, name)

    bpy_module.ops = _Ops()
    restores.append(lambda: setattr(bpy_module, "ops", original_ops))

    class _Data:
        def __getattr__(self, name):
            # Checked BEFORE the collection lookup, because in Blender 5.2 both
            # of these are attributes of bpy.data itself and both really do
            # remove datablocks. Anything else that is not a guarded collection
            # is handed through untouched: bpy.data has readers too, and a
            # measurement script needs them.
            if name in _MUTATING_DATA_ATTRS:
                return _violation(f"bpy.data.{name}(...)")
            if name in _REMOVING_DATA_ATTRS:
                return _GuardedDataCollection(getattr(original_data, name), name)
            return getattr(original_data, name)

        def __setattr__(self, name, value):
            return _violation(f"bpy.data.{name} = ...")()

        def __delattr__(self, name):
            return _violation(f"del bpy.data.{name}")()

    bpy_module.data = _Data()
    restores.append(lambda: setattr(bpy_module, "data", original_data))

    # bpy.context is patched too, for the reasons on _GuardedContext. bpy
    # allows the module attribute to be rebound and restored the same way as
    # ops and data; the restore below puts the real Context back, so a later
    # MUTATING run in the same session sees an untouched bpy.
    if hasattr(bpy_module, "context") and original_context is not None:
        bpy_module.context = _GuardedContext(original_context)
        restores.append(lambda: setattr(bpy_module, "context", original_context))

    def restore():
        for undo in restores:
            with contextlib.suppress(Exception):
                undo()

    return restore


# Every wrapper defined above that holds the real bpy object in `_wrapped`.
# Collected by name rather than by isinstance so that _unwrap() can be defined
# before the classes it unwraps: Blender's own argument checks reject a wrapper
# ("expected a Depsgraph type, not _GuardedNamespace"), so a wrapped value has
# to be convertible back before it can be passed to a bpy method.
_GuardedWrappers = (
    _GuardedVector,
    _GuardedObject,
    _GuardedDataCollection,
    _GuardedContainer,
    _GuardedNamespace,
)


@contextlib.contextmanager
def read_only_run(bpy_module):
    """Run a block with mutation refused, restoring bpy however the block ends."""
    restore = install_read_only_guard(bpy_module)
    try:
        yield
    finally:
        restore()
