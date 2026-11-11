"""A deterministic studio rig, so a critic compares work and not lighting.

Every worker used to author its own lamps, which made two modules in one scene
incomparable: the critic was judging a lighting difference as a modelling one.
The rig is data, built into a reserved collection, and rebuilt from fixed values
so the same call produces the same read.

Nothing here is saved into the user's scene unless they save it themselves; the
caller decides whether the rig belongs in the deliverable.
"""

# pyright: reportMissingImports=false
# pi-lens-ignore: ast-grep:unresolved-import-python (Blender's own modules)
import bpy
from mathutils import Vector

STUDIO_COLLECTION = "Studio"
LEGACY_RIG_NAMES = {"StudioKey", "StudioFill", "StudioRim"}
RIG_PROPERTY = "pi_studio_rig"

# Fixed key/fill/rim geometry per rig. Values are deliberately unequal: a flat
# frontal read hides form, which is the failure the rig exists to prevent.
RIGS = {
    "studio": {
        "world": 0.04,
        "lights": (
            {"role": "key", "energy": 600.0, "size": 2.0, "location": (3.5, -3.5, 3.5)},
            {"role": "fill", "energy": 250.0, "size": 3.0, "location": (-4.0, -2.0, 2.0)},
            {"role": "rim", "energy": 400.0, "size": 1.5, "location": (0.0, 4.5, 3.0)},
        ),
    },
    "softbox": {
        "world": 0.08,
        "lights": (
            {"role": "key", "energy": 400.0, "size": 4.0, "location": (2.5, -3.0, 3.0)},
            {"role": "fill", "energy": 300.0, "size": 4.5, "location": (-3.0, -1.5, 2.5)},
            {"role": "rim", "energy": 200.0, "size": 2.0, "location": (0.0, 4.0, 2.5)},
        ),
    },
    "sun_dome": {
        "world": 0.8,
        "lights": (
            {"role": "key", "energy": 3.0, "size": 0.0, "location": (4.0, -4.0, 6.0)},
            {"role": "fill", "energy": 1.0, "size": 0.0, "location": (-4.0, -2.0, 3.0)},
            {"role": "rim", "energy": 2.0, "size": 0.0, "location": (0.0, 5.0, 4.0)},
        ),
    },
}


def _neutral_world(scene, strength):
    previous = {
        "replacedEnvironment": False,
        "previousStrength": None,
    }
    world = scene.world
    if world is None:
        world = bpy.data.worlds.new("PI_StudioWorld")
        scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    if background is None:
        background = world.node_tree.nodes.new("ShaderNodeBackground")
        background.name = "Background"
        output = world.node_tree.nodes.get("World Output")
        if output is None:
            output = world.node_tree.nodes.new("ShaderNodeOutputWorld")
            output.name = "World Output"
        world.node_tree.links.new(background.outputs["Background"], output.inputs["Surface"])
    previous["replacedEnvironment"] = bool(background.inputs["Color"].links)
    try:
        previous["previousStrength"] = float(background.inputs["Strength"].default_value)
    except (TypeError, ValueError):
        previous["previousStrength"] = None
    for link in list(background.inputs["Color"].links):
        world.node_tree.links.remove(link)
    background.inputs["Color"].default_value = (0.05, 0.05, 0.05, 1.0)
    background.inputs["Strength"].default_value = float(strength)
    return world, previous


def _aim(obj, target=(0.0, 0.0, 0.0)):
    direction = vector_difference(target, obj.location)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def vector_difference(target, location):
    # pi-lens-ignore: ast-grep:unresolved-import-python (mathutils is provided by Blender)
    from mathutils import Vector  # pyright: ignore[reportMissingImports]

    return Vector(target) - Vector(location)


def _clear_rig(collection):
    for obj in list(collection.objects):
        if obj.get(RIG_PROPERTY) or obj.name in LEGACY_RIG_NAMES:
            data = obj.data
            bpy.data.objects.remove(obj, do_unlink=True)
            if data is not None and data.users == 0 and isinstance(data, bpy.types.Light):
                bpy.data.lights.remove(data)


def _subject_bounds(scene):
    meshes = [obj for obj in scene.objects if obj.type == "MESH"]
    dimensions = [max(obj.dimensions) for obj in meshes]
    scale = max(1.0, max(dimensions) if dimensions else 1.0)
    if not meshes:
        return scale, (0.0, 0.0, 0.0)
    corners = [obj.matrix_world @ Vector(corner) for obj in meshes for corner in obj.bound_box]
    lo = [min(point[axis] for point in corners) for axis in range(3)]
    hi = [max(point[axis] for point in corners) for axis in range(3)]
    return scale, tuple((lo[axis] + hi[axis]) / 2.0 for axis in range(3))


def apply_studio_rig(kind="studio", film_transparent=False, world_strength=None):
    """Build the rig, replacing only this tool's previous lights.

    Idempotent: calling twice leaves three rig lights, not six. A user light is
    untouched even if it sits in the scene, because removal is keyed on the
    marker property, not on the collection.
    """
    preset = RIGS.get(kind)
    if preset is None:
        raise ValueError(f"unknown studio rig {kind!r}; expected one of {sorted(RIGS)}")
    scene = bpy.context.scene
    collection = bpy.data.collections.get(STUDIO_COLLECTION)
    if collection is None:
        collection = bpy.data.collections.new(STUDIO_COLLECTION)
        scene.collection.children.link(collection)
    _clear_rig(collection)

    strength = preset["world"] if world_strength is None else float(world_strength)
    _, worldChange = _neutral_world(scene, strength)
    scale, center = _subject_bounds(scene)
    for spec in preset["lights"]:
        name = f"PI_{kind}_{spec['role']}"
        light_data = bpy.data.lights.new(name, type="SUN" if kind == "sun_dome" else "AREA")
        light_data.energy = spec["energy"] * (scale * scale if kind != "sun_dome" else 1.0)
        if kind != "sun_dome":
            light_data.shape = "DISK"
            light_data.size = spec["size"] * scale
        light_data.color = (1.0, 1.0, 1.0)
        obj = bpy.data.objects.new(name, light_data)
        obj.location = tuple(center[axis] + spec["location"][axis] * scale for axis in range(3))
        obj[RIG_PROPERTY] = kind
        obj["pi_studio_role"] = spec["role"]
        collection.objects.link(obj)
        _aim(obj, target=center)

    scene.render.film_transparent = bool(film_transparent)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0
    scene.view_settings.gamma = 1.0
    return {
        "kind": kind,
        "collection": collection.name,
        "lightCount": sum(1 for obj in collection.objects if obj.get(RIG_PROPERTY)),
        "lights": [obj.name for obj in collection.objects if obj.get(RIG_PROPERTY)],
        "filmTransparent": bool(scene.render.film_transparent),
        "worldStrength": strength,
        "viewTransform": scene.view_settings.view_transform,
        "exposure": float(scene.view_settings.exposure),
        "subjectScale": round(scale, 4),
        "subjectCenter": [round(value, 4) for value in center],
        "world": worldChange,
    }
