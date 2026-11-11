# Sculpting with stroke data

Organic shapes — a rounded shoulder, a sagging cloth edge, a thinned fin — are
the part primitives and booleans do not reach. `blender/sculpt.py` adds them as
**data**: a list of strokes applied with `bmesh`/`mathutils` math. The same list
produces the same vertex positions on every machine, which is what keeps
`stateDigest` and `unchangedSinceLastRun` meaningful. Interactive brush strokes
cannot do that: they depend on a viewport, a cursor and a depsgraph.

Use it from a module script (Blender puts the assets directory on `sys.path`):

```python
from sculpt import apply_strokes
from sculpt_topology import ensure_density

strokes = [
    # Round the top of the shoulder.
    {"op": "displace", "center": [0.0, 0.0, 1.0], "radius": 0.45, "strength": 0.08},
    # Tighten the ridge along Z.
    {"op": "crease", "center": [0.0, 0.0, 1.0], "radius": 0.30, "strength": 0.05, "axis": [0, 0, 1]},
    # Take the lumpiness back out without touching the rest of the mesh.
    {"op": "smooth_laplacian", "center": [0.0, 0.0, 1.0], "radius": 0.35, "strength": 0.4, "iterations": 2},
    # Keep a symmetric character symmetric after every stroke.
    {"op": "mirror", "axis": "x"},
]

# A six-face cube has nowhere to round; a stroke needs vertices to move.
ensure_density(bpy.context.object, strokes, max_faces=200_000, decimate_to=40_000)
report = apply_strokes(bpy, bpy.context.object, strokes)
print(report)
```

Coordinates are object-local. `center` defaults to the mesh bounding-box
centre. `radius` is the falloff radius in the same units; `strength` is the
maximum displacement, not a multiplier of the radius. `mirror` pairs vertices
by nearest mirrored position, so it is a symmetry *repair*, not a duplicate.

## Operations

| `op` | Effect |
| --- | --- |
| `displace` / `inflate` | Move along vertex normals (or an explicit `direction`) inside the radius. |
| `grab` | Move by `offset`, weighted by falloff. |
| `crease` | Normal displacement plus a tangential pull toward `axis`. |
| `pinch` | Like `crease`, with the tangential term stronger. |
| `flatten` | Project vertices toward the plane through `center` with `normal`. |
| `smooth` / `smooth_laplacian` | Iterative neighbour averaging, masked by falloff. |
| `mirror` | Average each vertex with its nearest mirror partner across `axis`. |

## Density

`ensure_density(obj, strokes, max_faces=500_000, subdivide="auto", voxel_size=None, decimate_to=None)`
derives a target edge length from the largest stroke radius (radius / 6),
subdivides toward it, optionally voxel-remeshes and optionally decimates. It
returns before/after vertex and face counts, `uvsSurvived`, `clamped` and the
reasons, so a critic reads numbers rather than guessing from a render. A voxel
remesh destroys UVs; that is reported, not discovered after export. A request
above `max_faces` is clamped to the largest subdivision that fits, and an
unexpected overshoot raises rather than saving a mesh that will slow every later
stage.

Do not build these on `bpy.ops.sculpt.brush_stroke`, and do not apply the
subdivision as a live modifier: the exported mesh would differ from the one that
was rendered.
