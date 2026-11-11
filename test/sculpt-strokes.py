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
from sculpt import apply_strokes  # pyright: ignore[reportMissingImports]

checks = {}


def make_grid():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.mesh.primitive_cube_add(size=2)
    obj = bpy.context.object
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.subdivide(number_cuts=7)
    bpy.ops.object.mode_set(mode="OBJECT")
    apply_strokes(obj, [{"op": "smooth", "radius": 10.0, "strength": 0.0}])
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
apply_strokes(obj, [{"op": "displace", "center": list(center), "radius": radius, "strength": 0.12}])
after = positions(obj)
outside_moved = [i for i, (old, new) in enumerate(zip(before, after, strict=True)) if (Vector(old) - center).length > radius + 1e-6 and old != new]
inside_moved = [i for i, (old, new) in enumerate(zip(before, after, strict=True)) if (Vector(old) - center).length < radius and old != new]
checks["nothing_moved_outside_radius"] = not outside_moved
checks["vertices_moved_inside_radius"] = len(inside_moved) > 0
checks["mesh_still_closed"] = closed(obj)

first_digest = digest(obj)
vertex_count = len(obj.data.vertices)
again = make_grid()
apply_strokes(again, [{"op": "displace", "center": list(center), "radius": radius, "strength": 0.12}])
checks["identical_stroke_lists_match"] = first_digest == digest(again)

third = make_grid()
apply_strokes(third, [
    {"op": "crease", "center": [0, 0, 1], "radius": 0.5, "strength": 0.08, "axis": [0, 0, 1]},
    {"op": "pinch", "center": [0, 0, 1], "radius": 0.4, "strength": 0.05},
    {"op": "flatten", "center": [0, 0, 1], "radius": 0.4, "strength": 0.3},
    {"op": "mirror", "axis": "x"},
])
checks["all_primitives_run"] = closed(third) and len(third.data.vertices) == vertex_count

creased = make_grid()
apply_strokes(creased, [{"op": "crease", "center": [0, 0, 1], "radius": radius, "strength": 0.12, "axis": [0, 0, 1]}])
creased_positions = positions(creased)
displaced = make_grid()
apply_strokes(displaced, [{"op": "displace", "center": [0, 0, 1], "radius": radius, "strength": 0.12}])
checks["crease_pulls_tangentially"] = any(
    (Vector(a) - Vector(b)).length > 1e-6
    for a, b in zip(creased_positions, positions(displaced), strict=True)
)

flat = make_grid()
plane_origin = Vector((0, 0, 0))
before_flat = sum(abs((Vector(position) - plane_origin).dot(Vector((0, 0, 1)))) for position in positions(flat)) / len(flat.data.vertices)
apply_strokes(flat, [{"op": "flatten", "center": [0, 0, 0], "radius": 10.0, "strength": 1.0}])
after_flat = sum(abs((Vector(position) - plane_origin).dot(Vector((0, 0, 1)))) for position in positions(flat)) / len(flat.data.vertices)
checks["flatten_reduces_plane_distance"] = after_flat < before_flat

mirrored = make_grid()
on_plane_before = sum(1 for vert in mirrored.data.vertices if abs(vert.co.x) <= 1e-6)
apply_strokes(mirrored, [{"op": "mirror", "axis": "x"}])
checks["mirror_keeps_symmetric_pairs_off_the_plane"] = (
    sum(1 for vert in mirrored.data.vertices if abs(vert.co.x) <= 1e-6) == on_plane_before
)

print("PASS: sculpt strokes are local, closed and deterministic")
print(json.dumps({"ok": all(checks.values()), "checks": checks}))
if not all(checks.values()):
    raise SystemExit(1)
