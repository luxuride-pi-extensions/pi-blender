# Modeling Guide (Blender 4.2 LTS)

Core modeling principles, tools, topology best practices, and workflow conventions in Blender 4.2.

## Mesh Topology Fundamentals

### Quad-Dominant Topology
- For deformation and subdivision, clean quad meshes are essential. Quads subdivide predictably, deform cleanly along skeletal joints, and support continuous edge loops.
- Avoid n-gons (>4 sides) on deforming surfaces or curved geometry; they produce unpredictable triangulation, shading artifacts, and pinch points under subdivision surface modifiers.
- Triangles are acceptable on rigid, coplanar surfaces (e.g. mechanical parts, planar architectural walls), but avoid them across curved organic silhouettes.

### Poles and Edge Flow
- Standard vertices have 4 intersecting edges.
- **E-poles (5 edges)** and **N-poles (3 edges)** redirect edge loops and allow transitions between regions of different mesh density.
- Keep poles away from sharp bending hinges (e.g. elbows, knees, eyelid rims) where deformation stresses will produce pinching.

## Core Modeling Workflows

### Primitives to Form
1. Start from basic primitives (`primitive_cube_add`, `primitive_cylinder_add`, `primitive_uv_sphere_add`) matching the general volume and proportion of the target asset.
2. In Edit Mode, block primary volumes before detailing. Use `extrude_region_move` along primary axes to build limbs, necks, or extensions.
3. Use `loopcut_slide` to add supportive edge loops where forms change curvature.
4. Use `inset` on faces to create perimeter boundary loops before recessing or extruding details.

### Beveling and Edge Hardening
- Pure razor-sharp digital edges look artificial in physical lighting. Always add subtle bevels to catch specular highlights.
- Use the **Bevel Modifier** with `limit_method='ANGLE'` (threshold around 30 degrees) for non-destructive edge beveling.

### Smooth Shading & Normal Management in 4.2 LTS
- In Blender 4.1 and 4.2 LTS, the legacy Auto Smooth mesh toggle was replaced by modifier-based normal handling:
  - Add the **Smooth by Angle** modifier (or run `bpy.ops.object.shade_smooth()`).
  - Use `bpy.ops.mesh.normals_make_consistent(inside=False)` to ensure all face normal vectors point outward. Inconsistent normals cause flipped dark patches and inside-out boolean operations.
