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
    """Wraps one bpy.data collection: reads and iteration through, removal out."""

    def __init__(self, collection, name):
        object.__setattr__(self, "_collection", collection)
        object.__setattr__(self, "_name", name)

    def __getattr__(self, attribute):
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

    def remove(self, *_args, **_kwargs):
        return _violation(f"bpy.data.{object.__getattribute__(self, '_name')}.remove(...)")()

    def pop(self, *_args, **_kwargs):
        return _violation(f"bpy.data.{object.__getattribute__(self, '_name')}.pop(...)")()

    def clear(self, *_args, **_kwargs):
        return _violation(f"bpy.data.{object.__getattribute__(self, '_name')}.clear(...)")()

    def new(self, *_args, **_kwargs):
        return _violation(f"bpy.data.{object.__getattribute__(self, '_name')}.new(...)")()


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
            if name in _REMOVING_DATA_ATTRS:
                return _GuardedDataCollection(getattr(original_data, name), name)
            return getattr(original_data, name)

        def __setattr__(self, name, value):
            return _violation(f"bpy.data.{name} = ...")()

        def __delattr__(self, name):
            return _violation(f"del bpy.data.{name}")()

    bpy_module.data = _Data()
    restores.append(lambda: setattr(bpy_module, "data", original_data))

    def restore():
        for undo in restores:
            with contextlib.suppress(Exception):
                undo()

    return restore


@contextlib.contextmanager
def read_only_run(bpy_module):
    """Run a block with mutation refused, restoring bpy however the block ends."""
    restore = install_read_only_guard(bpy_module)
    try:
        yield
    finally:
        restore()
