# Modifiers Guide (Blender 4.2 LTS)

Overview of non-destructive modifiers, evaluation order, and configuration best practices in Blender 4.2.

## Evaluation Stack Order

Modifiers execute sequentially from top to bottom of the object's modifier stack. The output geometry of each modifier becomes the input geometry of the next:

1. **Mirror Modifier**: Place first in the stack so procedural modeling works symmetrically across the origin plane. Ensure `use_clip=True` and `use_mirror_merge=True` so center-line vertices stay welded.
2. **Generative / Deconstructive Modifiers**: Boolean, Array, Solidify, Bevel.
3. **Deformation Modifiers**: Armature modifier or Curve modifier. Deforming a lower-density mesh before subdivision is significantly more performant than deforming millions of subdivided polygons.
4. **Subdivision Surface (Subsurf)**: Place near or at the very end of the stack. Subsurf rounds out and smooths the final evaluated geometry.

## Essential Modifiers

### Subdivision Surface (SubsurfModifier)
- Evaluates Catmull-Clark subdivision surfaces.
- Keep viewport `levels` at 1 or 2 for responsive interactivity; set `render_levels` to 2 or 3 for final high-fidelity production rendering.
- Avoid setting viewport levels above 3 unless necessary, as polygon counts scale by $4^N$.

### Mirror (MirrorModifier)
- Mirrors geometry across local X, Y, or Z axis.
- Clipping prevents vertices near the mirror plane from being pulled apart or overlapping.
- `merge_threshold` welds boundary seam vertices together seamlessly.

### Boolean (BooleanModifier)
- Evaluates constructive solid geometry: Difference, Union, Intersect.
- **Exact Solver**: Handles coplanar faces, overlapping coplanar coplanar shells, and manifold solids with high precision.
- **Fast Solver**: High-performance solver best suited for simple non-intersecting shapes.
- Requirements for clean booleans: Both operands should be closed, 2-manifold meshes with consistent outward-pointing normals.

### Bevel (BevelModifier)
- Rounds edges without destructively altering underlying base mesh topology.
- Combine with `limit_method='ANGLE'` (default 30°) or vertex groups for localized edge chamfering.
- Enable `harden_normals=True` to eliminate shading gradient artifacts across adjacent flat faces.

### Solidify (SolidifyModifier)
- Adds uniform wall thickness to single-sided sheet meshes or open shells (e.g. clothing, pottery, architectural walls).
- Enable `use_even_offset=True` to maintain constant wall thickness through corners.

### Array (ArrayModifier)
- Duplicates geometry in regular linear or offset increments.
- Combine with an empty reference object (`use_object_offset=True`) to create radial circular arrays (e.g. gear teeth, spokes, stairs).
