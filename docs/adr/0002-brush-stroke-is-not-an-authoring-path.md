# 0002: `bpy.ops.sculpt.brush_stroke` is not an authoring path

- Status: rejected
- Date: 2026-11-11
- Measured with: Blender 4.2.3 LTS, Linux, `--factory-startup`, 482-vertex UV sphere, Draw brush at size 120

## Context

`bpy.ops.sculpt.brush_stroke(stroke=...)` is the only real brush operator in the
Python API. The sculpt design (`#60`) is built on hand-rolled, deterministic
stroke helpers in `blender/sculpt.py`. If the operator were a reliable
alternative, that design would be unnecessarily indirect. This record measures
the operator instead of assuming the answer.

The spike restored the sphere's vertex coordinates before every stroke, used the
same two-event stroke table, and hashed the mesh with the same scheme as
`blender/fingerprint.py`.

## Measurements

| Question | Result |
| --- | --- |
| Runs in a live window | Yes, but only with `temp_override(window, area, region, space_data)` from a `VIEW_3D` area. Returns `{'FINISHED'}`. |
| Runs headless (no window) | No. `RuntimeError: Operator bpy.ops.sculpt.brush_stroke.poll() failed, context is incorrect`. The normal execution path has no window, so this is the common case. |
| Identical input, identical output | No. Two process runs produced `b638cf17da068c1c` and `cd5c35846c8fac00`; repeated strokes inside one process produced `d84eaf6123edcb0b` and `469d38208ec784d2` from the same restored coordinates. |
| Settable dependencies | Only partially. The call needs a surface `location`, a non-zero brush size, and every stroke field (`mouse_event` as two floats, `x_tilt`, `y_tilt`); missing fields raise `TypeError`, and `location=(0,0,0)` returns `FINISHED` while changing nothing. Brush, symmetry and dyntopo are read from the sculpt session rather than the call, and the session's evaluated mesh is part of the input. |

A `{'FINISHED'}` result therefore proves neither that geometry changed nor that
the change is reproducible.

## Decision

Do not use `bpy.ops.sculpt.brush_stroke` as an authoring path, and never let its
output feed a module digest or `stateDigest`. Organic work uses the stroke-table
helpers in `blender/sculpt.py` and the density pass in
`blender/sculpt_topology.py`, which are headless and deterministic by
construction.

If the operator is ever exposed, it must remain opt-in, live-window-only, and
outside module runs. `unchangedSinceLastRun` cannot be trusted for a path whose
own output varies between identical runs, which is the failure
`blender/fingerprint.py` exists to prevent.

## References

- `blender/skills/blender-sculpt/SKILL.md` states the decision in its rules.
- `blender/sculpt.py` implements the alternative that this record keeps.
