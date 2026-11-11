# Verified modeling snippets

These are the small `bpy`/`bmesh` operations that make a generated model
renderable, exportable and comparable. They are written as snippets rather than
tools because each is three to six lines and belongs in the worker's script, but
each one is exercised against a real Blender by
`test/modeling-snippets.test.mjs`: a snippet that silently stops working is
worse than no snippet, because the worker believes it ran.

## Smooth shading

```python
mesh.shade_smooth()
# Blender 4.1+ only: smooths by angle instead of one global flag.
import math
bpy.ops.object.shade_smooth_by_angle(angle=math.radians(30))
```

Why: a low-poly curved surface with flat faces reads as faceted in every
render and makes a critic report geometry that is actually shading. Use the
angle form on hard-surface models: a global smooth flag rounds the edge of a
box.

## Apply transforms

```python
bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
```

Why: a non-unit object scale is baked into modifiers, bevel widths, cloth and
physics, and an exporter that writes the scale separately can disagree with
Blender's own preview. Applying rotation and scale (not location, which the
parent rig may own) makes the mesh coordinates the truth.

## Triangulate

```python
import bmesh
bm = bmesh.new()
bm.from_mesh(mesh)
bmesh.ops.triangulate(bm, faces=bm.faces[:])
bm.to_mesh(mesh)
bm.free()
```

Why: an n-gon can be convex in Blender and concave after export, so a game
engine triangulates it differently and a surface that rendered correctly in the
critic's image develops a visible crease. Triangulate before export; keep quads
while modeling.

## Weld by distance

```python
bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-4)
```

Why: two primitives that touch are two closed surfaces, not one watertight
mesh. A seam that looks welded renders with a visible crack under smooth
shading and breaks boolean/normal-map workflows. Weld only at coincident
vertices (`dist` around 0.1 mm); a larger distance collapses real detail.

## Unwrap

```python
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=1.15, island_margin=0.02)
bpy.ops.object.mode_set(mode="OBJECT")
```

Why: an exported asset without a UV layer cannot carry a texture, and a
procedural material generated in Blender does not survive the export. Smart
project is the deterministic fallback when the model has no authored seams;
`angle_limit` is in radians (66 degrees), not degrees.

## Recalculate normals

```python
bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
```

Why: mirrored or boolean-generated geometry can end up with inward-facing
normals. Blender's material preview often hides it; an export shows black
faces, and a backface-culled engine shows holes. Recalculate outward after
every topology-changing operation, not once at the end.
