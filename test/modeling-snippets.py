"""Exercise the documented modeling snippets against real bpy/bmesh.

Each check asserts a geometry invariant, not that an operator returned
FINISHED: an operator can finish and do nothing.
"""

import json

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender)
import bmesh  # pyright: ignore[reportMissingImports]
import bpy  # pyright: ignore[reportMissingImports]

checks = {}


def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)


clear()
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.object
cube.scale = (2, 2, 2)
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
checks["apply_transform_scale_is_one"] = all(abs(v - 1) < 1e-6 for v in cube.scale)
checks["apply_transform_bakes_extent"] = abs(cube.dimensions.x - 2) < 1e-6

mesh = cube.data
bm = bmesh.new()
bm.from_mesh(mesh)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
checks["triangulate_all_triangles"] = all(len(f.verts) == 3 for f in bm.faces)
bm.to_mesh(mesh)
bm.free()

clear()
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.object
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.mesh.duplicate()
bpy.ops.object.mode_set(mode="OBJECT")
before = len(cube.data.vertices)
bm = bmesh.new()
bm.from_mesh(cube.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
bm.to_mesh(cube.data)
bm.free()
checks["weld_reduces_duplicate_vertices"] = len(cube.data.vertices) == before // 2

clear()
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8)
sphere = bpy.context.object
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
bpy.ops.object.mode_set(mode="OBJECT")
checks["unwrap_created_uv_layer"] = len(sphere.data.uv_layers) == 1

mesh = sphere.data
mesh.shade_smooth()
checks["smooth_shading_sets_polygons"] = all(p.use_smooth for p in mesh.polygons)

clear()
bpy.ops.mesh.primitive_cube_add(size=1)
cube = bpy.context.object
# Invert every face, then let recalc restore outward normals.
bm = bmesh.new()
bm.from_mesh(cube.data)
for face in bm.faces:
    face.normal_flip()
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
outward = all(face.normal.dot(face.calc_center_median()) > 0 for face in bm.faces)
bm.to_mesh(cube.data)
bm.free()
checks["recalc_normals_point_outward"] = outward

all_ok = all(checks.values())
print(json.dumps({"ok": all_ok, "checks": checks}))
if not all_ok:
    raise SystemExit(1)
print("PASS: the documented modeling snippets run and change the mesh")
