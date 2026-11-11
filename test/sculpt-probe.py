#!/usr/bin/env python3
"""Assert the sculpt-quality probe on meshes whose answers are known."""

import importlib.util
import os
import sys
import tempfile

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
    print(f"  {'ok  ' if condition else 'FAIL'}: {message}")
    sys.stdout.flush()


bridge_dir = tempfile.mkdtemp(prefix="pi-blender-sculpt-")
os.environ["PI_BLENDER_BRIDGE_DIR"] = bridge_dir
spec = importlib.util.spec_from_file_location(
    "live_bridge",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender", "live-bridge.py"),
)
assert spec is not None
bridge = importlib.util.module_from_spec(spec)
assert spec is not None and spec.loader is not None
spec.loader.exec_module(bridge)
sculpt = bridge._probe_sculpt


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


# Two overlapping cubes, joined: non-adjacent faces cross each other.
reset()
bpy.ops.mesh.primitive_cube_add(size=1)
a = bpy.context.object
bpy.ops.mesh.primitive_cube_add(size=1, location=(0.5, 0, 0))
b = bpy.context.object
b.select_set(True)
a.select_set(True)
bpy.context.view_layer.objects.active = a
bpy.ops.object.join()
report = sculpt(a, 8)
check(report["selfIntersections"]["pairs"] > 0, "overlapping cubes report self-intersections")
check(report["density"]["withinBudget"] is False, "a cap of 8 faces is exceeded")
check(report["density"]["faces"] > 8, "reported face count matches the joined mesh")

# A cube with one vertex pulled out: mirror error is visible.
reset()
bpy.ops.mesh.primitive_cube_add(size=1)
c = bpy.context.object
c.data.vertices[0].co.x += 0.4
report = sculpt(c, None)
check(report["symmetry"]["rms"] > 0.02, "an asymmetric vertex raises the mirror RMS")
check(report["symmetry"]["max"] > 0.05, "the asymmetric vertex is the maximum error")

# A thin slab: the inward ray finds the far side at the slab thickness.
reset()
bpy.ops.mesh.primitive_cube_add(size=1)
d = bpy.context.object
d.scale = (1.0, 1.0, 0.02)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
report = sculpt(d, None)
thickness = report["minWallThickness"]["distance"]
check(thickness is not None and 0.015 < thickness < 0.025, f"thin slab thickness is {thickness}")

# A plane has no inside: those faces are counted, not reported as zero.
reset()
bpy.ops.mesh.primitive_grid_add(x_subdivisions=2, y_subdivisions=2, size=1)
plane = bpy.context.object
report = sculpt(plane, None)
check(report["minWallThickness"]["openFaces"] > 0, "an open surface reports faces with no inward hit")

if failures:
    print("FAIL: sculpt probe")
    sys.stdout.flush()
    os._exit(1)
print("PASS: sculpt probe reports folds, walls, symmetry and density")
sys.stdout.flush()
os._exit(0)
