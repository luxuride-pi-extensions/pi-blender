"""Density pass reports the geometry it actually left on the object."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender"))

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]
from sculpt_topology import ensure_density  # pyright: ignore[reportMissingImports]

checks = {}
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
obj = bpy.context.object
report = ensure_density(obj, [{"radius": 0.5}], subdivide=2)
checks["reported_faces_match"] = report["after"]["faces"] == len(obj.data.polygons)
checks["subdivision_added_faces"] = report["after"]["faces"] > report["before"]["faces"]
checks["cuts_recorded"] = report["cuts"] == 2

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
obj = bpy.context.object
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project()
bpy.ops.object.mode_set(mode="OBJECT")
report = ensure_density(obj, [{"radius": 0.5}], subdivide=0, voxel_size=0.08, decimate_to=300)
checks["uv_loss_reported"] = report["uvsSurvived"] is False
checks["decimate_reaches_target"] = report["after"]["faces"] <= 300
checks["counts_match_after_decimate"] = report["after"]["faces"] == len(obj.data.polygons)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=2)
obj = bpy.context.object
report = ensure_density(obj, [{"radius": 0.5}], subdivide=6, max_faces=100)
checks["cap_clamps"] = report["clamped"] is True and report["after"]["faces"] <= 100
checks["clamp_has_reason"] = any("cap" in reason for reason in report["reasons"])

print("PASS: density pass reports the geometry it leaves")
print(json.dumps({"ok": all(checks.values()), "checks": checks}))
if not all(checks.values()):
    raise SystemExit(1)
