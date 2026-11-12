import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "blender"))

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]  # noqa: E402, I001
# Frozen snapshot of the module under test, imported by path.
# pi-lens-ignore: ast-grep:unresolved-import-python
import export_asset  # pyright: ignore[reportMissingImports]  # noqa: E402, I001

checks = {}


def cube(name, location=(0, 0, 0), scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return obj


bpy.ops.wm.read_factory_settings(use_empty=True)
cube("Cube")
with tempfile.TemporaryDirectory() as tmp:
    path = os.path.join(tmp, "cube.glb")
    export_asset._run_export("glb", path, False, False)
    objects = [obj for obj in bpy.data.objects if obj.type == "MESH"]
    materials = [slot.material for obj in objects for slot in obj.material_slots if slot.material]
    gltf = export_asset._validate_export("gltf", "glb", path, objects, materials)
    checks["gltf_pass"] = gltf is not None and gltf["ok"] and any(c["name"] == "nodes" for c in gltf["checks"])
    print_ok = export_asset._validate_export("print", "stl", path, objects, materials)
    checks["closed_cube_print_pass"] = print_ok["ok"]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_plane_add()
    plane = bpy.context.object
    open_ = export_asset._validate_export("print", "stl", "unused", [plane], [])
    checks["open_plane_print_fails"] = not open_["ok"] and any(
        c["name"] == "manifold" and c["status"] == "fail" for c in open_["checks"]
    )

    bpy.ops.wm.read_factory_settings(use_empty=True)
    cube("A")
    cube("B", location=(0.5, 0, 0))
    overlap = export_asset._validate_export("print", "stl", "unused", list(bpy.data.objects), [])
    checks["overlap_print_fails"] = not overlap["ok"] and any(
        c["name"] == "selfIntersection" and c["status"] == "fail" for c in overlap["checks"]
    )

    bpy.ops.wm.read_factory_settings(use_empty=True)
    first = cube("A")
    cube("B", location=(0.5, 0, 0))
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = first
    bpy.ops.object.join()
    joined = export_asset._validate_export("print", "stl", "unused", [bpy.context.object], [])
    checks["joined_overlap_fails"] = not joined["ok"] and any(
        c["name"] == "selfIntersection" and c["status"] == "fail" for c in joined["checks"]
    )

    bpy.ops.wm.read_factory_settings(use_empty=True)
    cube("Scaled", scale=(1, 1, 2))
    scaled = export_asset._validate_export("print", "stl", "unused", [bpy.context.object], [])
    checks["unapplied_scale_warns"] = any(
        c["name"] == "scale" and c["status"] == "warn" for c in scaled["checks"]
    ) and scaled["ok"]

    engine = export_asset._validate_export("engine", "stl", "unused", [bpy.context.object], [])
    checks["engine_reports_checks"] = engine is not None and any(
        c["name"] == "textures" for c in engine["checks"]
    )
    checks["none_is_empty"] = export_asset._validate_export("none", "stl", "unused", [], []) is None

    bpy.ops.wm.read_factory_settings(use_empty=True)
    cube("Cube")
    with tempfile.TemporaryDirectory() as tmp:
        material = bpy.data.materials.new("Checked")
        material.use_nodes = True
        source = os.path.join(tmp, "source.png")
        image = bpy.data.images.new("Source", 8, 8)
        image.filepath_raw = source
        image.file_format = "PNG"
        image.save()
        texture = material.node_tree.nodes.new("ShaderNodeTexImage")
        texture.image = image
        principled = next(
            node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"
        )
        material.node_tree.links.new(texture.outputs["Color"], principled.inputs["Base Color"])
        bpy.context.object.data.materials.append(material)
        sidecar = os.path.join(tmp, "sidecar.gltf")
        export_asset._run_export("gltf", sidecar, False, False)
        document = export_asset._read_gltf_json(sidecar)
        uris = [image.get("uri") for image in document.get("images", []) if image.get("uri")]
        checks["gltf_has_sidecar"] = bool(uris)
        if uris:
            os.remove(os.path.join(tmp, uris[0]))
            missing = export_asset._validate_export("gltf", "gltf", sidecar, [bpy.context.object], [])
            checks["missing_sidecar_fails"] = any(
                c["name"] == f"image:{uris[0]}" and c["status"] == "fail" for c in missing["checks"]
            )

        bpy.ops.wm.read_factory_settings(use_empty=True)
        cube("Cube")
        default_stl = export_asset.handle_export(
            {"format": "stl", "outputDir": tmp, "name": "default"}, lambda request: None
        )
        checks["stl_default_validates"] = (
            default_stl["validation"] is not None
            and default_stl["validation"]["profile"] == "print"
            and default_stl["validation"]["ok"]
        )

    bad = False
    try:
        export_asset._validate_export("nonsense", "stl", "unused", [], [])
    except RuntimeError:
        bad = True
    checks["unknown_profile_rejected"] = bad

print(json.dumps({"module": "export-validation", "checks": checks}, indent=2))
if not all(checks.values()):
    raise SystemExit(1)
print("PASS: export validation profiles report glTF, print and engine facts")
