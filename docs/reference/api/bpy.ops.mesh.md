# bpy.ops.mesh — Mesh Operators (Blender 4.2 LTS)

Operators for mesh generation, topology manipulation, UV unwrapping, and geometry editing.

## Operators

### bpy.ops.mesh.primitive_cube_add
```python
bpy.ops.mesh.primitive_cube_add(size=2.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
```
Construct a cube mesh primitive centered at location with width, depth, and height of `size`.

- `size` (float, default 2.0): Edge length of the cube.
- `calc_uvs` (boolean, default True): Generate default unwrapped UV coordinates.
- `enter_editmode` (boolean, default False): Immediately switch to Edit Mode after creation.
- `align` (enum in ['WORLD', 'VIEW', 'CURSOR'], default 'WORLD'): Coordinate system alignment.
- `location` (tuple of 3 floats, default (0.0, 0.0, 0.0)): World position.
- `rotation` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Euler orientation.
- `scale` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Initial object scale.

### bpy.ops.mesh.primitive_uv_sphere_add
```python
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
```
Construct a UV sphere mesh primitive.

- `segments` (int in [3, 100000], default 32): Number of vertical segment slices around the Z axis.
- `ring_count` (int in [3, 100000], default 16): Number of horizontal latitude rings from pole to pole.
- `radius` (float, default 1.0): Radius of the sphere in meters.
- `calc_uvs` (boolean, default True): Generate cylindrical/spherical unwrapped UVs.
- `enter_editmode` (boolean, default False): Switch to Edit Mode after adding geometry.
- `align` (enum in ['WORLD', 'VIEW', 'CURSOR'], default 'WORLD'): Coordinate system alignment.
- `location` (tuple of 3 floats, default (0.0, 0.0, 0.0)): World position.
- `rotation` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Euler orientation.
- `scale` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Initial object scale.

### bpy.ops.mesh.primitive_cylinder_add
```python
bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=1.0, depth=2.0, end_fill_type='NGON', calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
```
Construct a cylinder mesh primitive.

- `vertices` (int in [3, 100000], default 32): Number of vertices around perimeter.
- `radius` (float, default 1.0): Radius of circular cross-section.
- `depth` (float, default 2.0): Height along the local Z axis.
- `end_fill_type` (enum in ['NOTHING', 'NGON', 'TRIFAN'], default 'NGON'): How cap ends are closed.
- `calc_uvs` (boolean, default True): Calculate default UV coordinates.
- `enter_editmode` (boolean, default False): Enter Edit Mode upon creation.
- `align` (enum in ['WORLD', 'VIEW', 'CURSOR'], default 'WORLD'): Coordinate system alignment.
- `location` (tuple of 3 floats, default (0.0, 0.0, 0.0)): World position.
- `rotation` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Euler orientation.
- `scale` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Initial scale.

### bpy.ops.mesh.primitive_cone_add
```python
bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=1.0, radius2=0.0, depth=2.0, end_fill_type='NGON', calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
```
Construct a cone or truncated cone mesh primitive.

- `vertices` (int in [3, 100000], default 32): Number of vertices around perimeter.
- `radius1` (float, default 1.0): Radius of bottom circular base.
- `radius2` (float, default 0.0): Radius of top tip or circular cap (0 for pointed tip).
- `depth` (float, default 2.0): Height of cone along local Z axis.
- `end_fill_type` (enum in ['NOTHING', 'NGON', 'TRIFAN'], default 'NGON'): Cap fill type.

### bpy.ops.mesh.primitive_plane_add
```python
bpy.ops.mesh.primitive_plane_add(size=2.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
```
Construct a flat 2D square plane mesh with 4 vertices.

- `size` (float, default 2.0): Length of side.
- `calc_uvs` (boolean, default True): Generate UV coordinates.

### bpy.ops.mesh.primitive_circle_add
```python
bpy.ops.mesh.primitive_circle_add(vertices=32, radius=1.0, fill_type='NOTHING', calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
```
Construct a 2D circle mesh with optional interior surface.

- `vertices` (int in [3, 100000], default 32): Number of vertices along perimeter.
- `radius` (float, default 1.0): Radius of circle.
- `fill_type` (enum in ['NOTHING', 'NGON', 'TRIFAN'], default 'NOTHING'): Fill interior faces.

### bpy.ops.mesh.primitive_torus_add
```python
bpy.ops.mesh.primitive_torus_add(align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), major_segments=48, minor_segments=12, mode='MAJOR_MINOR', major_radius=1.0, minor_radius=0.25, abso_major_rad=1.25, abso_minor_rad=0.75, generate_uvs=True)
```
Construct a donut-shaped torus mesh primitive.

- `major_segments` (int in [3, 256], default 48): Segments around main ring.
- `minor_segments` (int in [3, 256], default 12): Segments around cross-section tube.
- `major_radius` (float, default 1.0): Distance from center to tube center.
- `minor_radius` (float, default 0.25): Radius of tube cross-section.

### bpy.ops.mesh.primitive_monkey_add
```python
bpy.ops.mesh.primitive_monkey_add(size=2.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
```
Construct Suzanne the monkey test geometry.

### bpy.ops.mesh.subdivide
```python
bpy.ops.mesh.subdivide(number_cuts=1, smoothness=0.0, ngon=True, quadcorner='STRAIGHT_CUT', fractal=0.0, fractal_along_normal=0.0, seed=0)
```
Subdivide selected edges and faces in Edit Mode.

- `number_cuts` (int in [1, 1000], default 1): Number of cuts added per edge.
- `smoothness` (float in [0.0, 1.0], default 0.0): Smooth vertices toward spherical curvature.
- `ngon` (boolean, default True): Allow n-gon creation on boundary cuts.

### bpy.ops.mesh.extrude_region_move
```python
bpy.ops.mesh.extrude_region_move(MESH_OT_extrude_region=None, TRANSFORM_OT_translate=None)
```
Extrude selected face/edge region and initiate interactive or programmatic translation transform.

### bpy.ops.mesh.bevel
```python
bpy.ops.mesh.bevel(offset_type='OFFSET', offset=0.0, offset_pct=0.0, segments=1, profile=0.5, affect='EDGES', clamp_overlap=False, loop_slide=True, mark_seam=False, mark_sharp=False, material=-1, harden_normals=False, face_strength_mode='NONE', miter_outer='SHARP', miter_inner='SHARP', spread=0.1)
```
Edge and vertex bevel operator for rounding or chamfering selected mesh components.

- `offset` (float, default 0.0): Amount to offset bevel faces.
- `segments` (int in [1, 1000], default 1): Number of segments in the bevel profile.
- `affect` (enum in ['VERTICES', 'EDGES'], default 'EDGES'): Whether to bevel vertices or edges.
- `clamp_overlap` (boolean, default False): Prevent beveled geometry from intersecting existing edges.

### bpy.ops.mesh.loopcut_slide
```python
bpy.ops.mesh.loopcut_slide(MESH_OT_loopcut=None, TRANSFORM_OT_edge_slide=None)
```
Insert an edge loop cut across quad rings and slide along existing edge rails.

### bpy.ops.mesh.inset
```python
bpy.ops.mesh.inset(use_boundary=True, use_even_offset=True, use_relative_offset=False, use_edge_rail=False, thickness=0.0, depth=0.0, use_outset=False, use_select_inset=False, use_individual=False, use_interpolate=True)
```
Inset selected polygonal faces inward with optional depth extrusion.

- `thickness` (float, default 0.0): Distance inset faces are pushed inward from boundary.
- `depth` (float, default 0.0): Perpendicular displacement outward or inward along face normal.
- `use_individual` (boolean, default False): Inset each face individually rather than as a merged island.

### bpy.ops.mesh.normals_make_consistent
```python
bpy.ops.mesh.normals_make_consistent(inside=False)
```
Recalculate face normals of selected faces to point consistently outward (or inward if `inside=True`).

### bpy.ops.mesh.select_all
```python
bpy.ops.mesh.select_all(action='TOGGLE')
```
Change selection state of all mesh elements in Edit Mode ('SELECT', 'DESELECT', 'INVERT', 'TOGGLE').

### bpy.ops.mesh.delete
```python
bpy.ops.mesh.delete(type='VERT')
```
Delete selected mesh elements ('VERT', 'EDGE', 'FACE', 'ONLY_FACE', 'EDGE_FACE').

### bpy.ops.mesh.fill
```python
bpy.ops.mesh.fill(use_beauty=True)
```
Fill a boundary loop of selected edges with triangles.

### bpy.ops.mesh.quads_convert_to_tris
```python
bpy.ops.mesh.quads_convert_to_tris(quad_method='BEAUTY', ngon_method='BEAUTY')
```
Triangulate selected polygonal faces.

### bpy.ops.mesh.tris_convert_to_quads
```python
bpy.ops.mesh.tris_convert_to_quads(face_threshold=0.698132, shape_threshold=0.698132)
```
Merge adjacent pairs of coplanar triangles into quads.

### bpy.ops.mesh.separate
```python
bpy.ops.mesh.separate(type='SELECTED')
```
Separate selected geometry into a new Object ('SELECTED', 'MATERIAL', 'LOOSE').
