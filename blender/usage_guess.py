"""Usage guess heuristic for unfamiliar Blender (.blend) files.

Evaluates signals across data-blocks headlessly (no live UI bridge lock needed):
- animation: actions, armatures, animated tracks/fcurves, constraints
- rendering: render engines (e.g. Cycles), output paths, compositor node trees, multiple cameras
- shading: materials, texture nodes, image textures, world shader trees
- procedural: geometry nodes modifiers, geometry node groups, procedural modifiers, drivers
- modeling: mesh geometry complexity, curves/surfaces, vertex groups, shape keys, with default cube check

Returns normalized score (0-100) and certainty (0-100) per category, plus contributing signals.
An empty signal set returns zeroed scores rather than a default guess.
"""

import json
import os
import sys

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]


def check_default_cube(mesh_objs):
    """Check if the scene meshes consist ONLY of Blender's default startup cube.

    Canonical default cube:
    - Exactly 1 mesh object named 'Cube' (or data named 'Cube')
    - 8 vertices, 6 polygons
    - Vertex coordinates (+-1, +-1, +-1)
    - No modifiers, no vertex groups, no shape keys
    """
    if len(mesh_objs) != 1:
        return False
    cube = mesh_objs[0]
    data = getattr(cube, "data", None)
    if data is None or not hasattr(data, "vertices") or not hasattr(data, "polygons"):
        return False
    if len(data.vertices) != 8 or len(data.polygons) != 6:
        return False
    if len(cube.modifiers) > 0 or len(cube.vertex_groups) > 0:
        return False
    if getattr(data, "shape_keys", None) is not None:
        return False
    # Check vertex positions around (+-1, +-1, +-1)
    for v in data.vertices:
        if any(abs(abs(c) - 1.0) > 1e-3 for c in v.co):
            return False
    return True


def evaluate_animation():
    signals = []
    actions = list(getattr(bpy.data, "actions", []))
    if actions:
        signals.append("actions")
        if any(len(getattr(a, "fcurves", [])) > 0 for a in actions):
            signals.append("action_keyframes")

    armatures = list(getattr(bpy.data, "armatures", []))
    if armatures:
        signals.append("armatures")
        if any(len(getattr(arm, "bones", [])) > 1 for arm in armatures):
            signals.append("skeletal_rig")

    animated_objs = [o for o in getattr(bpy.data, "objects", []) if getattr(o, "animation_data", None) is not None]
    if animated_objs:
        signals.append("animated_objects")
        if any(len(getattr(o.animation_data, "nla_tracks", [])) > 0 for o in animated_objs):
            signals.append("nla_tracks")

    for o in getattr(bpy.data, "objects", []):
        for c in getattr(o, "constraints", []):
            if c.type in ("IK", "TRACK_TO", "FOLLOW_PATH", "ACTION", "SPLINE_IK"):
                if "rigging_constraints" not in signals:
                    signals.append("rigging_constraints")
                break

    if not signals:
        return {"score": 0, "certainty": 0, "signals": []}

    score = 40
    certainty = 50

    if "actions" in signals or "action_keyframes" in signals:
        score = 75
        certainty = 80
        if "armatures" in signals or "skeletal_rig" in signals:
            score = 95
            certainty = 95
        elif "nla_tracks" in signals:
            score = 90
            certainty = 90
    elif "armatures" in signals or "skeletal_rig" in signals:
        score = 70
        certainty = 75
        if "rigging_constraints" in signals:
            score = 80
            certainty = 80
    elif "nla_tracks" in signals:
        score = 75
        certainty = 80
    elif "animated_objects" in signals:
        score = 60
        certainty = 65

    return {"score": min(100, score), "certainty": min(100, certainty), "signals": signals}


def evaluate_rendering():
    signals = []
    scene = getattr(bpy.context, "scene", None)
    if scene is None and len(getattr(bpy.data, "scenes", [])) > 0:
        scene = bpy.data.scenes[0]

    if scene is not None:
        # Engine
        engine = getattr(scene.render, "engine", "")
        if engine == "CYCLES":
            signals.append("cycles_render_engine")

        # Output path
        filepath = getattr(scene.render, "filepath", "")
        if filepath and filepath.strip() and filepath.strip() not in ("/tmp/", "/tmp\\", "//render/", "//renders/"):
            signals.append("custom_output_path")

        # Compositor
        comp_group = getattr(scene, "compositing_node_group", None)
        comp_tree = getattr(scene, "node_tree", None)
        active_comp = comp_group or comp_tree
        if active_comp is not None and len(getattr(active_comp, "nodes", [])) > 0:
            signals.append("compositor_nodes")

        # Multiple cameras or configured camera
        cameras = [o for o in getattr(bpy.data, "objects", []) if o.type == "CAMERA"]
        if len(cameras) > 1:
            signals.append("multiple_cameras")

        if scene.camera is not None and getattr(scene.camera, "data", None) is not None:
            cam_data = scene.camera.data
            if getattr(getattr(cam_data, "dof", None), "use_dof", False):
                signals.append("camera_depth_of_field")

        # Render passes
        for vl in getattr(scene, "view_layers", []):
            if any(getattr(vl, attr, False) for attr in ("use_pass_z", "use_pass_normal", "use_pass_diffuse_color", "use_pass_ambient_occlusion")):
                signals.append("render_passes")
                break

    if not signals:
        return {"score": 0, "certainty": 0, "signals": []}

    score = 40
    certainty = 50

    if "cycles_render_engine" in signals:
        if "custom_output_path" in signals or "compositor_nodes" in signals:
            score = 90
            certainty = 90
        else:
            score = 75
            certainty = 75
    elif "compositor_nodes" in signals:
        score = 80
        certainty = 85
    elif "custom_output_path" in signals:
        score = 70
        certainty = 75
    elif "camera_depth_of_field" in signals or "render_passes" in signals or "multiple_cameras" in signals:
        score = 60
        certainty = 65

    return {"score": min(100, score), "certainty": min(100, certainty), "signals": signals}


def evaluate_shading(is_default_cube):
    signals = []
    materials = [m for m in getattr(bpy.data, "materials", []) if m is not None]
    images = [img for img in getattr(bpy.data, "images", []) if getattr(img, "type", "") not in ("RENDER_RESULT", "COMPOSITING")]

    if images:
        signals.append("image_textures")

    # If the only materials are the default 'Material' or 'Dots Stroke' on a default cube,
    # do not treat them as custom shading.
    custom_materials = []
    for m in materials:
        if is_default_cube and m.name in ("Material", "Dots Stroke"):
            continue
        custom_materials.append(m)

    if len(custom_materials) > 1:
        signals.append("multiple_materials")

    has_texture_nodes = False
    has_complex_nodes = False
    for m in custom_materials:
        node_tree = getattr(m, "node_tree", None)
        if node_tree is not None:
            nodes = list(node_tree.nodes)
            if len(nodes) > 2:
                has_complex_nodes = True
            for n in nodes:
                if "TEX" in n.type:
                    has_texture_nodes = True
                    break

    if has_texture_nodes:
        signals.append("texture_nodes")
    if has_complex_nodes:
        signals.append("shader_node_trees")

    for m in custom_materials:
        if m.name not in ("Material", "Dots Stroke"):
            signals.append("named_materials")
            break

    scene = getattr(bpy.context, "scene", None)
    if scene and getattr(scene, "world", None) and getattr(scene.world, "node_tree", None):
        world_nodes = getattr(scene.world.node_tree, "nodes", [])
        if any(n.type in ("TEX_ENVIRONMENT", "TEX_IMAGE") for n in world_nodes):
            signals.append("world_environment")

    if not signals:
        return {"score": 0, "certainty": 0, "signals": []}

    score = 40
    certainty = 50

    if "image_textures" in signals or "texture_nodes" in signals:
        if "multiple_materials" in signals or "shader_node_trees" in signals:
            score = 90
            certainty = 90
        else:
            score = 80
            certainty = 85
    elif "shader_node_trees" in signals:
        score = 75
        certainty = 75
    elif "multiple_materials" in signals:
        score = 65
        certainty = 70
    elif "world_environment" in signals or "named_materials" in signals:
        score = 55
        certainty = 60

    return {"score": min(100, score), "certainty": min(100, certainty), "signals": signals}


def evaluate_procedural():
    signals = []
    objects = list(getattr(bpy.data, "objects", []))

    # Geometry nodes
    has_gn_mod = any(m.type == "NODES" for o in objects for m in getattr(o, "modifiers", []))
    if has_gn_mod:
        signals.append("geometry_nodes_modifier")

    gn_groups = [ng for ng in getattr(bpy.data, "node_groups", []) if getattr(ng, "type", "") == "GEOMETRY"]
    if gn_groups:
        signals.append("geometry_node_tree")

    # Procedural modifiers
    procedural_types = {"ARRAY", "BOOLEAN", "BEVEL", "CURVE", "DISPLACE", "MIRROR", "SCREW", "SOLIDIFY", "WIREFRAME", "REMESH", "WAVE"}
    proc_mods = [m for o in objects for m in getattr(o, "modifiers", []) if m.type in procedural_types]
    if proc_mods:
        signals.append("procedural_modifiers")
        if len(proc_mods) > 1:
            signals.append("modifier_stack")

    # Drivers
    has_drivers = False
    for o in objects:
        anim_data = getattr(o, "animation_data", None)
        if anim_data and len(getattr(anim_data, "drivers", [])) > 0:
            has_drivers = True
            break
    if has_drivers:
        signals.append("drivers")

    if not signals:
        return {"score": 0, "certainty": 0, "signals": []}

    score = 40
    certainty = 50

    if "geometry_nodes_modifier" in signals or "geometry_node_tree" in signals:
        if "modifier_stack" in signals or "drivers" in signals:
            score = 95
            certainty = 95
        else:
            score = 85
            certainty = 90
    elif "modifier_stack" in signals:
        score = 75
        certainty = 80
    elif "procedural_modifiers" in signals:
        score = 65
        certainty = 70
    elif "drivers" in signals:
        score = 60
        certainty = 65

    return {"score": min(100, score), "certainty": min(100, certainty), "signals": signals}


def evaluate_modeling(is_default_cube, mesh_objs):
    signals = []

    if is_default_cube or not mesh_objs:
        # Default cube alone or no meshes at all gives no modeling signals
        other_geo = [o for o in getattr(bpy.data, "objects", []) if o.type in ("CURVE", "SURFACE", "META", "FONT")]
        if other_geo:
            signals.append("curves_or_surfaces")
    else:
        signals.append("custom_mesh_geometry")
        if len(mesh_objs) > 1:
            signals.append("multiple_mesh_objects")

        total_verts = sum(len(getattr(m.data, "vertices", [])) for m in mesh_objs if hasattr(m, "data") and hasattr(m.data, "vertices"))
        if total_verts > 500:
            signals.append("dense_mesh_geometry")

        for m in mesh_objs:
            if getattr(m, "vertex_groups", None) and len(m.vertex_groups) > 0:
                if "vertex_groups" not in signals:
                    signals.append("vertex_groups")
            data = getattr(m, "data", None)
            if data is not None:
                if getattr(data, "shape_keys", None) is not None:
                    if "shape_keys" not in signals:
                        signals.append("shape_keys")
                if getattr(data, "uv_layers", None) and len(data.uv_layers) > 0:
                    if "uv_unwrapped" not in signals:
                        signals.append("uv_unwrapped")

    if not signals:
        return {"score": 0, "certainty": 0, "signals": []}

    score = 40
    certainty = 50

    if "dense_mesh_geometry" in signals or "shape_keys" in signals:
        score = 90
        certainty = 90
    elif "custom_mesh_geometry" in signals:
        if "multiple_mesh_objects" in signals or "uv_unwrapped" in signals:
            score = 80
            certainty = 85
        else:
            score = 70
            certainty = 75
    elif "curves_or_surfaces" in signals:
        score = 70
        certainty = 75

    return {"score": min(100, score), "certainty": min(100, certainty), "signals": signals}


def evaluate_usage():
    mesh_objs = [o for o in getattr(bpy.data, "objects", []) if o.type == "MESH"]
    is_default_cube = check_default_cube(mesh_objs)

    categories = {
        "animation": evaluate_animation(),
        "rendering": evaluate_rendering(),
        "shading": evaluate_shading(is_default_cube),
        "procedural": evaluate_procedural(),
        "modeling": evaluate_modeling(is_default_cube, mesh_objs),
    }

    # Derive primary guess (highest score * certainty, or null if all 0)
    best_cat = None
    best_weight = 0
    all_signals = []
    for name, cat in categories.items():
        all_signals.extend(cat["signals"])
        weight = cat["score"] * cat["certainty"]
        if weight > best_weight:
            best_weight = weight
            best_cat = name

    return {
        "categories": categories,
        "primaryGuess": best_cat,
        "allSignals": all_signals,
    }


def main():
    result = evaluate_usage()
    print("__PI_BLENDER_JSON_START__")
    print(json.dumps(result))
    print("__PI_BLENDER_JSON_END__")


if __name__ == "__main__":
    main()
