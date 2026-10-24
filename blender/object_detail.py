"""
Object detail read for a single object in a saved blend file.

Inspects an object by name and returns:
- transform (location, rotation_euler, scale, is_non_uniform_scale)
- modifier stack (name, type, show_viewport, show_render, settings summary -- marking viewport-disabled modifiers)
- material slots (material names, slot index)
- mesh statistics (vertices, edges, polygons/faces)
- parenting (parent name, children names)
- scene linkage (is_linked_to_scene, is_orphan)

Reads the saved blend headlessly. Payload is bounded to the specified object.
"""
import json
import sys

# Provided by Blender's own runtime, not by anything installed here.
# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]


def maybe_vector(value):
    if value is None:
        return None
    return [float(c) for c in value]


def summarize_modifier_settings(mod):
    summary = {}
    mtype = mod.type
    if mtype == "SUBSURF":
        summary["levels"] = getattr(mod, "levels", None)
        summary["render_levels"] = getattr(mod, "render_levels", None)
        summary["subdivision_type"] = str(getattr(mod, "subdivision_type", "CATMULL_CLARK"))
    elif mtype == "BEVEL":
        summary["width"] = getattr(mod, "width", None)
        summary["segments"] = getattr(mod, "segments", None)
        summary["profile"] = getattr(mod, "profile", None)
    elif mtype == "SOLIDIFY":
        summary["thickness"] = getattr(mod, "thickness", None)
        summary["offset"] = getattr(mod, "offset", None)
    elif mtype == "MIRROR":
        summary["use_axis"] = [bool(a) for a in getattr(mod, "use_axis", [])]
        summary["mirror_object"] = mod.mirror_object.name if getattr(mod, "mirror_object", None) else None
    elif mtype == "BOOLEAN":
        summary["operation"] = str(getattr(mod, "operation", ""))
        summary["solver"] = str(getattr(mod, "solver", ""))
        summary["object"] = mod.object.name if getattr(mod, "object", None) else None
    elif mtype == "ARMATURE":
        summary["object"] = mod.object.name if getattr(mod, "object", None) else None
    elif mtype == "ARRAY":
        summary["count"] = getattr(mod, "count", None)
        summary["fit_type"] = str(getattr(mod, "fit_type", ""))
    elif mtype == "DECIMATE":
        summary["decimate_type"] = str(getattr(mod, "decimate_type", ""))
        summary["ratio"] = getattr(mod, "ratio", None)
    elif mtype == "REMESH":
        summary["mode"] = str(getattr(mod, "mode", ""))
        summary["voxel_size"] = getattr(mod, "voxel_size", None)
    elif mtype == "WIREFRAME":
        summary["thickness"] = getattr(mod, "thickness", None)
    else:
        for p in mod.rna_type.properties:
            if not p.is_readonly and p.identifier not in (
                "name", "show_viewport", "show_render", "show_in_editmode",
                "show_on_cage", "show_expanded", "is_active"
            ):
                try:
                    val = getattr(mod, p.identifier, None)
                    if isinstance(val, (int, float, str, bool)):
                        summary[p.identifier] = val
                    if len(summary) >= 6:
                        break
                except Exception:
                    pass
    return summary


def get_object_detail(name):
    obj = bpy.data.objects.get(name)
    if not obj:
        raise RuntimeError(f"Object '{name}' not found in blend file.")

    loc = maybe_vector(obj.location)
    rot = maybe_vector(obj.rotation_euler)
    sca = maybe_vector(obj.scale)
    is_non_uniform = not (abs(sca[0] - sca[1]) < 1e-5 and abs(sca[1] - sca[2]) < 1e-5) if sca else False

    is_linked = bool(obj.name in bpy.context.scene.objects)
    is_orphan = not is_linked

    modifiers = []
    for mod in obj.modifiers:
        mod_settings = summarize_modifier_settings(mod)
        is_vp_disabled = not bool(mod.show_viewport)
        modifiers.append({
            "name": mod.name,
            "type": mod.type,
            "show_viewport": bool(mod.show_viewport),
            "show_render": bool(mod.show_render),
            "showViewport": bool(mod.show_viewport),
            "showRender": bool(mod.show_render),
            "is_viewport_disabled": is_vp_disabled,
            "isViewportDisabled": is_vp_disabled,
            "viewport_disabled": is_vp_disabled,
            "settings": mod_settings,
            "settings_summary": mod_settings,
        })

    slots = []
    for idx, s in enumerate(obj.material_slots):
        mat_name = s.material.name if s.material else None
        slots.append({
            "slot_index": idx,
            "slotIndex": idx,
            "material_name": mat_name,
            "materialName": mat_name,
        })

    mesh_stats = None
    if obj.type == "MESH" and obj.data:
        mesh = obj.data
        mesh_stats = {
            "vertices": len(mesh.vertices),
            "edges": len(mesh.edges),
            "polygons": len(mesh.polygons),
            "faces": len(mesh.polygons),
        }

    parent_name = obj.parent.name if obj.parent else None
    children_names = [child.name for child in obj.children]

    return {
        "name": obj.name,
        "type": obj.type,
        "is_linked_to_scene": is_linked,
        "isLinkedToScene": is_linked,
        "is_orphan": is_orphan,
        "isOrphan": is_orphan,
        "users": int(obj.users),
        "transform": {
            "location": loc,
            "rotation_euler": rot,
            "rotationEuler": rot,
            "scale": sca,
            "is_non_uniform_scale": is_non_uniform,
            "isNonUniformScale": is_non_uniform,
        },
        "location": loc,
        "rotation_euler": rot,
        "rotationEuler": rot,
        "scale": sca,
        "is_non_uniform_scale": is_non_uniform,
        "isNonUniformScale": is_non_uniform,
        "parent": parent_name,
        "parent_name": parent_name,
        "parentName": parent_name,
        "children": children_names,
        "children_names": children_names,
        "childrenNames": children_names,
        "modifiers": modifiers,
        "material_slots": slots,
        "materialSlots": slots,
        "materials": [s["material_name"] for s in slots if s["material_name"]],
        "mesh": mesh_stats,
        "mesh_statistics": mesh_stats,
        "meshStatistics": mesh_stats,
        "vertices": mesh_stats["vertices"] if mesh_stats else None,
        "edges": mesh_stats["edges"] if mesh_stats else None,
        "polygons": mesh_stats["polygons"] if mesh_stats else None,
        "faces": mesh_stats["faces"] if mesh_stats else None,
    }


def main():
    payload = {}
    if "--" in sys.argv:
        try:
            payload = json.loads(sys.argv[sys.argv.index("--") + 1])
        except Exception:
            pass

    target_name = (
        payload.get("objectName")
        or payload.get("targetObject")
        or payload.get("name")
        or payload.get("object_name")
    )
    if not target_name:
        if bpy.context.view_layer.objects.active:
            target_name = bpy.context.view_layer.objects.active.name
        elif len(bpy.data.objects) > 0:
            target_name = bpy.data.objects[0].name
        else:
            raise RuntimeError("No object specified and no objects exist in the blend file.")

    detail = get_object_detail(target_name)
    print("__PI_BLENDER_JSON_START__")
    print(json.dumps(detail))
    print("__PI_BLENDER_JSON_END__")


if __name__ == "__main__":
    main()
