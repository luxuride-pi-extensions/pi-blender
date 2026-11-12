import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "blender"))

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]
# Frozen snapshot of the module under test, imported by path.
# pi-lens-ignore: ast-grep:unresolved-import-python
import export_asset  # pyright: ignore[reportMissingImports]

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
    cube("Scaled", scale=(1, 1, 2))
    scaled = export_asset._validate_export("print", "stl", "unused", [bpy.context.object], [])
    checks["unapplied_scale_warns"] = any(
        c["name"] == "scale" and c["status"] == "warn" for c in scaled["checks"]
    ) and scaled["ok"]

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
