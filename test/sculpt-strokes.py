"""Prove the data-driven sculpt strokes are local, deterministic and closed."""

import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender"))
# pi-lens-ignore: ast-grep:unresolved-import-python
import bmesh  # pyright: ignore[reportMissingImports]
import bpy  # pyright: ignore[reportMissingImports]
from mathutils import Vector  # pyright: ignore[reportMissingImports]

# pi-lens-ignore: ast-grep:unresolved-import-python
from sculpt import apply_strokes

checks = {}


def make_grid():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=2)
    obj = bpy.context.object
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.subdivide(number_cuts=7)
    bpy.ops.object.mode_set(mode="OBJECT")
    apply_strokes(bpy, obj, [{"op": "smooth", "radius": 10.0, "strength": 0.0}])
    return obj


def positions(obj):
    return [tuple(round(value, 9) for value in vert.co) for vert in obj.data.vertices]


def digest(obj):
    return hashlib.sha256(json.dumps(positions(obj)).encode()).hexdigest()


def closed(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        return all(edge.is_manifold for edge in bm.edges)
    finally:
        bm.free()


obj = make_grid()
before = positions(obj)
center = Vector((0, 0, 1))
radius = 0.40
apply_strokes(bpy, obj, [{"op": "displace", "center": list(center), "radius": radius, "strength": 0.12}])
after = positions(obj)
outside_moved = [i for i, (old, new) in enumerate(zip(before, after, strict=True)) if (Vector(old) - center).length > radius + 1e-6 and old != new]
inside_moved = [i for i, (old, new) in enumerate(zip(before, after, strict=True)) if (Vector(old) - center).length < radius and old != new]
checks["nothing_moved_outside_radius"] = not outside_moved
checks["vertices_moved_inside_radius"] = len(inside_moved) > 0
checks["mesh_still_closed"] = closed(obj)

first_digest = digest(obj)
vertex_count = len(obj.data.vertices)
again = make_grid()
apply_strokes(bpy, again, [{"op": "displace", "center": list(center), "radius": radius, "strength": 0.12}])
checks["identical_stroke_lists_match"] = first_digest == digest(again)

third = make_grid()
apply_strokes(bpy, third, [
    {"op": "crease", "center": [0, 0, 1], "radius": 0.5, "strength": 0.08, "axis": [0, 0, 1]},
    {"op": "pinch", "center": [0, 0, 1], "radius": 0.4, "strength": 0.05},
    {"op": "flatten", "center": [0, 0, 1], "radius": 0.4, "strength": 0.3},
    {"op": "mirror", "axis": "x"},
])
checks["all_primitives_run"] = closed(third) and len(third.data.vertices) == vertex_count

print(json.dumps({"ok": all(checks.values()), "checks": checks}))
if not all(checks.values()):
    raise SystemExit(1)
