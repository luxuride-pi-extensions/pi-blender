---
name: blender-sculpt
description: Shape organic surfaces from deterministic stroke data, add topology budgets, and judge the result with measured sculpt metrics.
---

# Blender Sculpt

Use this skill when the request is organic surface work — rounding a shoulder,
softening a cloth edge, thinning a fin, adding a lumpy rock, or repairing
symmetry — rather than construction from primitives. A sculpt is **data**, not a
brush session: the same stroke table must produce the same vertices, or the
module's digest and `unchangedSinceLastRun` stop meaning anything.

The manager still never writes module code. Put the stroke intent in the
worker's brief (object, region, radius, strength, axis, symmetry) and let the
`blender-worker` author `modules/<name>/script.py` with the helpers below.

## Workflow

1. Inspect with `blender_scene_info` (`objects`, plus `uv` when the part already
   has texture coordinates). A displacement stroke on a six-face cube has
   nowhere to move, so note the existing vertex count.
2. Brief the worker to run `blender_geometry_probe {checks: ["topology"]}` on
   the part before a destructive pass: a mesh that already has boundary or
   non-manifold edges is not a closed solid, and a thickness metric on it is
   meaningless. The worker holds the probe; the manager does not.
3. Brief the worker with the stroke table and the density budget. It calls
   `ensure_density` first, then `apply_strokes`, and reports the counts and the
   stroke report.
4. Stage the module (`blender_branch_run`). After the batch apply, brief the
   worker to run `blender_geometry_probe {checks: ["sculpt"], densityCap:
   <brief's cap>}` on the applied part and report it; the manager reads the
   metrics, not only the render:
   - `selfIntersections.pairs > 0` — a stroke folded the surface through itself.
     Reduce strength or radius before the next iteration.
   - `minWallThickness.distance` below the print/brief minimum — the displacement
     pushed two walls together. `minWallThickness.openFaces > 0` means the part was
     not closed and the thickness number does not describe it.
   - `symmetry.rms` above the brief's tolerance — a mirrored half drifted, or a
     stroke was applied on one side only.
   - `density.withinBudget === false` — the mesh grew past the cap; decimate or
     lower the subdivision target rather than shipping a slow asset.
5. Critic and loop as usual (`blender-modules`): the critic judges the render,
   the probe numbers decide whether the surface is physically sound. A pretty
   render with a self-intersection is still a failed iteration.

## Stroke table

See `docs/SCULPT.md` for the full field list and a worked example. The short
version:

```python
from sculpt import apply_strokes
from sculpt_topology import ensure_density

ensure_density(obj, strokes, max_faces=200_000, decimate_to=40_000)
report = apply_strokes(obj, strokes)
```

Operations: `displace`/`inflate`, `grab`, `crease`, `pinch`, `flatten`,
`smooth`/`smooth_laplacian`, `mirror`. Coordinates are object-local, `radius` is
the falloff radius, and `strength` scales the stroke's displacement: the
maximum for `displace`, a factor on `offset` for `grab`, and a blend weight for
the shaping strokes.

## Rules

- The object must be in `OBJECT` mode when the stroke table runs; `apply_strokes`
  refuses edit or sculpt mode. A live paint session can leave the viewport in
  `SCULPT`, so switch back before the next module.
- Never use `bpy.ops.sculpt.brush_stroke`: it needs a viewport, a cursor and a
  depsgraph, so it is neither headless nor deterministic.
- Do not apply the subdivision as a live modifier; the exported mesh would
  differ from the rendered one.
- Report `uvsSurvived` from `ensure_density`. A voxel remesh destroys UVs and
  that must be a stated trade-off, not a discovery after export.
- One sculpt module at a time: it owns the object's vertex positions, so a
  parallel module editing the same object would fight it.
- If the brief is "make it look hand-made", say what that means in numbers
  (lump radius, asymmetry tolerance, wall minimum). A critic cannot score
  "hand-made" from one image, and the probe cannot measure it either.
