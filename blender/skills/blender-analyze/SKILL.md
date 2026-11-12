---
name: blender-analyze
description: Inspect and render Blender workspaces without mutating them unless the user explicitly asks for changes.
---

# Blender Analyze

Use this skill when the user wants to understand an existing Blender scene.

Workflow:
1. Reopen the workspace with `blender_workspace_init` if needed.
2. Use `blender_scene_info` for structural inspection.
3. Use `blender_render` for visual inspection when an image would help answer the question.

Rules:
- Prefer inspection and rendering over mutation.
- Do not call `blender_execute_python` unless the user explicitly asks you to change the scene.
- Keep the response grounded in the inspected scene metadata and renders.

## Tool semantics moved out of the schemas

The tool and parameter descriptions below are the full text that used to live in
`core/tools.ts`. The schema keeps each first sentence for tool selection; load
this skill when you need the precedence rules, failure modes and definitions.

### blender_scene_info

Read the workspace blend file as it was last SAVED, and return its structure: scene content (objects, collections, materials, cameras, lights, render settings, UVs, armatures, textures, paint settings), single-object detail (object_detail), file health (missingFiles, linkedLibraries), or aggregate scene metrics (scene_stats). With `scene_stats`, object counts report Object data-blocks and instance counts report linked duplicates sharing data-blocks plus collection instances separately from unique data-blocks; polycounts and vertex totals reflect un-evaluated base mesh data before modifier stack evaluation; a multi-scene file reports a per-scene breakdown with the combined figure labelled total. Nothing unsaved in the open Blender is visible here — a worker's in-flight edits are not on disk yet, and a session that has changed something by hand has not saved it. This is the right tool for the SAVED STATE of a build ("what objects exist", "what materials are assigned"), for per-object detail ("what is this object's transform, parent, modifiers"), and for file-health diagnostics ("is this file broken", missing external asset files, direct and indirect linked library trees). For what the UI currently shows — the open file, the selection, the mode, the viewport, unsaved changes, or another session holding the same blend — use `blender_session_context`, which reads the live Blender and is the only source of truth for present-tense state. Prefer a narrow `categories` list such as `["objects"]`, `["materials"]`, `["cameras", "cameraSettings"]`, `["object_detail"]`, or `["missingFiles", "linkedLibraries"]`, or `["scene_stats"]` when you only need one or a few sections. Omit `categories` only when you truly need the full scene info payload. Read-only by construction (see docs/SAFETY.md for full guarantee boundary).

- **workspace** — Explicit workspace path for the Blender task.
- **categories** — Optional scene info categories to inspect. Pass one category to inspect only that section, or pass a short list for a subset. For paint/UV/rig work add `uv`, `textures`, `armatures`, and `paintSettings`. For single object detail add `object_detail` (requires `targetObject`). For blend-file health diagnostics without opening a window, add `missingFiles` (external references missing from disk) and `linkedLibraries` (direct and indirect linked library tree). Pass `scene_stats` for aggregate file metrics (object counts, instance counts, unique data-blocks, per-type breakdown, un-evaluated base mesh polycount/vertex totals, and per-scene render settings) without object detail. Pass `usage_guess` for an orientation heuristic over data-block signals. Content categories describe what is inside the scene; file-health categories report whether external references and link trees on disk are intact. These all describe the last SAVED blend file, not live UI state. Omit `categories` only when you need all available scene info sections.
- **targetObject** — Optional target object name when inspecting object detail in the saved blend file.

### blender_usage_guess

Inspect a saved .blend file headlessly (no live UI bridge lock needed) and guess what it is for. Evaluates signals across data-blocks for animation (actions, armatures), rendering (render engines, output paths, compositor), shading (materials, shader node trees, textures), procedural (geometry nodes, procedural modifiers), and modeling (mesh geometry complexity, curves, vertex groups, shape keys, with default cube check). Returns normalized score (0-100) and certainty (0-100) per category along with named contributing signals. If no signals are found in the file, returns zeroed scores rather than guessing a default.

- **workspace** — Optional workspace path containing model.blend to analyze. Relative paths resolve from current working directory. Either workspace or blendPath must be provided.
- **blendPath** — Optional direct path to a .blend file to analyze headlessly. Relative paths resolve from current working directory. Either workspace or blendPath must be provided.

### blender_object_detail

Read the workspace blend file as it was last SAVED, and return detailed inspection data for a single object: transforms (with non-uniform scale flag), modifier stack (marking viewport-disabled modifiers), material slots, mesh counts (vertices, edges, polygons/faces), parent and child relationships, and orphan/unlinked-to-scene status. Does not pull the entire scene; payload is bounded to the specified object. Reads the saved blend file headlessly, matching blender_scene_info.

- **workspace** — Explicit workspace path for the Blender task.
- **objectName** — Name of the object in the saved blend file to inspect.
- **targetObject** — Alias for objectName. Name of the object in the saved blend file to inspect.
- **name** — Alias for objectName. Name of the object in the saved blend file to inspect.

### blender_rank_assets

Rank a batch against ITSELF and return the best slice. An absolute threshold can say whether an asset is good enough; it can never say whether it is the best of a thousand, and the gap between the 60th and 95th percentile is invisible to a rubric that only ever sees one asset at a time. Reads critique.log's STRUCTURE (never its prose), keeps each module's latest judgement, ranks only presented assets judged from a usable view, and returns the top fraction best-first plus per-verdict counts and batch-level warnings. Use this before shipping a batch for training or curation: when rejects outnumber presents, the brief is usually wrong rather than the assets.

- **workspace** — Explicit workspace path for the Blender task.
- **topFraction** — Fraction of ELIGIBLE assets to keep, 0..1, default 0.1. A batch of 100 with a 0.1 slice returns the best 10. Always at least one asset is kept, so a batch of 3 returns its best rather than nothing.
- **minScore** — Score an asset must reach before it may be ranked at all, default 0. The verdict already gates on the present threshold; raise this only to keep borderline-but-presented assets out of a slice.

### blender_geometry_probe

Measure mesh/transform relationships in the workspace blend and return numbers: world-space bounds, thin/long principal axes and their angle to an expected axis, pair distance with an interpenetrating/in-contact/separated verdict, a scene-wide sweep for parts that ought to meet and do not — or that share a surface and will z-fight, mesh island counts, and non-manifold/loose/duplicate geometry counts. Read-only by construction — it never mutates or saves, claims no iteration, and is safe to call while a worker has a module mid-flight (see docs/SAFETY.md for full guarantee boundary and measurement pitfalls like coincident deepestPenetration). Use it instead of reasoning about placement: a floating or buried handle is a measured gap distance, not a guess. Works with no window: it then measures model.blend on disk headlessly. With a window open it measures the live session instead, including unsaved edits, and warns when the two differ.

- **workspace** — Explicit workspace path for the Blender task.
- **objects** — Object names to measure. Omit to probe every visible mesh in the scene — usually the right default, because a misplaced part is found by its relationship to the rest, and the culprit is often not yet known.
- **pairs** — Object-name pairs to measure against each other, e.g. `[["Mug", "MugHandle"]]`. Each pair yields the closest surface distance, penetration depth, per-object vertex-inside counts, a coincident-surface figure, bounding-box overlap, and a verdict. Omit to auto-pair when exactly two objects are given.
- **specifications** — Reference dimensions per object name, compared against what the scene actually measures. A bare integer is MILLIMETRES and a bare decimal is METRES, because a brief says `2400` and `2.4m` for the same ceiling; unitless-as-metres is not an option when a 1000x error renders identically. Naming dimensions implies the `scale` check.
- **checks** — Measurement families to run. Omit for all but the heaviest (`sculpt`), which runs only when named. `transform` catches unapplied/mirror scale; `axis` finds a ring's own axis and how far it is off the expected one; `pair` measures only the pairs you NAME; `joint` sweeps the whole scope for pairs nobody named — bounding boxes that overlap or come within 50mm while the surfaces are further apart than the tolerance — and is the check that finds a riser pipe modelled clear of the pipe it continues; it also reports `coincident-surface`, the two parts sharing a stretch of geometry that renders as z-fighting colour banding, which no verdict can see because a flush-laid panel is in contact and so is a clean one, and `buried`, a part swallowed whole by another, which is a correct render of a wrong model; `clearance` answers whether the room is USABLE — it samples the floor with a person-sized body, dilates every obstruction by that reach, and reports `islandCount` (free floor cut into pieces nobody can walk between) and `unreachableArea` (floor that reaches no edge at all), which is what catches a sofa laid wall to wall; it takes its room from the same `objects` you scope it to, so measure one room rather than the house; `path` asks whether the WALK between two points is longer than the line between them — pass `points` (door centres, the ends of a corridor) and it walks every pair over the same floor raster, walls included, and reports a `detour` ratio: 1.0 is a corridor, one bend is about 1.1–1.3, and a stair-step of several offset doors runs to 1.9 or more, which is the shape a render cannot show because from above it is still a house; `shape` reports self-symmetry, a radius profile along the mesh's own long axis, convexity and open edges — the defects a render cannot show; `topology` is the expensive one (bmesh pass per mesh) and is only needed when the shape itself is suspect, and its island count is what catches a mesh split into drifting pieces; `sculpt` reports self-intersections, minimum wall thickness, symmetry error, dihedral distribution and density against `densityCap` — the numbers that decide whether an organic surface reads as natural, which one render cannot show; it is opt-in because its BVH overlap scan is unbounded; `scale` needs `specifications` and compares each object against the reference dimensions your brief named.
- **symmetryAxis** — Axis the `sculpt` symmetry metric mirrors across, default `x` for bilateral symmetry. Independent of `expectedAxis`, which is the axis check's thin-direction alignment.
- **densityCap** — Face ceiling for the `sculpt` check's density budget, e.g. 50000. Naming a cap runs `sculpt` even when `checks` omits it. Omit to report vertex/face counts without judging them.
- **tolerance** — Contact distance in Blender units (default 0.002, i.e. 2 mm at default scale). Distances within tolerance report as `in-contact` rather than `separated`.
- **expectedAxis** — The axis a part's thin direction should align with — `Z` for a mug handle's ring axis, `Z` for a vertical stem. Omit to skip the alignment comparison.
- **body** — `clearance` and `path` only. Metres a person reaches — a sample is blocked when an obstruction comes within this. Default 0.25, which is what makes a 50 mm gap read as blocked and a 500 mm one as a doorway. Widen it to ask whether a wheelchair gets through, narrow it to ask whether anything does. Any other check ignores it.
- **points** — World `[x, y]` positions in metres a person is meant to travel between — door centres, the ends of a corridor, the foot of a stair. Passing these implies the `path` check. Every PAIR is walked, not just the ones you ordered: a house is short of doors and long of rooms, so the pair a designer forgot is the one that zig-zags. Each point snaps to the nearest free floor within a body's reach, so a door centre given beside its frame still resolves; one that lands on nothing is reported in `unresolved` rather than guessed at.
- **detour** — `path` only. The detour ratio above which a route counts as a zig-zag, default 1.45. A straight corridor is 1.0 and a single right-angle bend is about 1.1–1.3, which is why the default sits well above 1: real architecture bends, and the defect is the several-turn stair-step. Cannot go below 1.0 — the straight line is a lower bound on any walk.
- **cell** — `clearance` and `path` only. Metres, the sampling granularity, default 0.05. The effective stride is this widened to cover `body`, because a sample is stamped with a dilated box spanning `2 * body` — so `cell` alone does not set the resolution. Lower it for a fine question, and expect a proportionally larger sample count. The two checks share one raster, so the same scope and the same `cell` report the same `stride`.
- **timeoutMs** — Bridge timeout override in ms. Defaults to 120000 (4x the 30s round-trip) because a probe scales with scene size — raise it for a `topology` check on a heavy scene, lower it when you are probing a small object list and want a dead bridge to report sooner.

### blender_image_probe

Measure a rendered PNG numerically instead of judging it by eye: subject pixel bounds and coverage, mean subject colour, an nx-by-ny mean-luma grid, silhouette row occupancy, edge sharpness, dominant subject colours, clipped fractions and luma percentiles over the subject. Read-only by construction, and it needs no live Blender — the pixels are the whole input, so any read-only role can use it (see docs/SAFETY.md for full guarantee boundary). Use it to check a visual suspicion before asserting it: 'the part is bare' is a colour fraction, 'the arms are hidden behind the body' is a row-occupancy pattern, and 'the render is too dark to judge' is a mean luma.

- **workspace** — Explicit workspace path for the Blender task.
- **path** — Path to the PNG to measure, e.g. `modules/<name>/render.png`. Relative paths resolve against the workspace root.
- **background** — The image's background colour as three 0..1 values (r, g, b). Defaults to black. This is a property of the shot, so read it from the render settings or the world rather than guessing from a corner pixel — a wrong value makes the background read as subject and empties the measurement.
- **tolerance** — Per-channel 0..1 tolerance for calling a pixel background (default 0). Raise it for a noisy or film-grain background, or for an antialiased edge that should count as subject.
- **grid** — Luma grid resolution as [nx, ny] (default [8,8], maximum 32 per side). Each cell is the mean luma of the subject pixels inside it, and null where there are none — a null cell means the subject does not reach that part of the frame.
- **paletteLimit** — How many dominant subject colours to report (default 6, 0 disables).

### blender_montage

Render several preset views of one subject and tile them into a single labelled sheet, plus the individual panels at full size. Two families of preset, chosen per view name. ORBIT presets (front, three-quarter, …) frame the subject's bounding sphere at one fixed distance, so every panel frames identically and a difference between panels is the geometry rather than the camera. INTERIOR presets (interior-corner, interior-doorway, …) stand inside the subject at eye height — a room has no silhouette to orbit, and a 6x4x2.8m room has a bounding-sphere radius of 3.9m, so every orbit panel of it photographs the outside of a wall. Use it when one angle cannot answer the question — a silhouette that might be hiding a limb, a shape that reads as symmetric from the front and wrong from three-quarter, a room that reads as cluttered from one corner and open from another, a critic that keeps calling something vague. Name the views; do not ask for views. Read-only with respect to the file it photographs: resolution, filepath, scene camera and viewport are restored, and the temporary cameras are removed. Works with no window: it then renders each panel headlessly from model.blend.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — Module the sheet belongs to. Written to modules/<name>/montage.png, with panel-N-<view>.png beside it.
- **views** — Preset view names. Orbit: front, back, left, right, top, bottom, three-quarter, three-quarter-left, three-quarter-high, profile-left, profile-right, front-high. Interior: interior-corner, interior-corner-left, interior-corner-right, interior-elevated, interior-doorway, interior-low. An unknown name is refused with the list rather than approximated. Two to four views make a useful sheet; one view is a render with extra steps.
- **subject** — Objects to frame. Defaults to every visible mesh, which frames the whole build. Pass names when one module is the subject and the rest of the scene is context.
- **columns** — Sheet columns. Default 1 for up to two views, otherwise 2. A 2x2 sheet of four panels is the most a critic can resolve before the panels get downsampled.
- **panelResolution.x** — Panel width in pixels (default 900).
- **panelResolution.y** — Panel height in pixels (default 700).
- **timeoutMs** — Bridge timeout override in ms. Defaults to four times the single-render budget, because this is one render per panel.
- **async** — If true, dispatch the montage as a deferred non-blocking job and return immediately with a job handle ({ jobId, state: 'running' }), releasing bridge.lock.

### blender_compare

Render the PREVIOUS generation of a subject beside the current one on a single labelled sheet, so a regression is visible. Each panel is labelled with which ITERATION it is (the baseline is the run before this module's latest, the current one is the latest; pass baselineLabel/currentLabel to say otherwise), and the two panels of one view sit side by side, which is what makes the sheet a comparison rather than a pair of pictures. Both generations are framed from the UNION of their extents, so the camera is identical in every panel and a difference between two panels of the same view is geometry — framing each generation on its own extent would make a part that grew read as a camera change. The baseline is rendered again from the checkpoint the earlier run started from (a checkpoint IS that generation's state, so no kept render is needed); pass baselineBlendPath to compare against a named earlier iteration instead. Two runs is the minimum: with only one there is no previous generation, and a sheet of identical pairs would read as proof of stability. Views are the same preset names as blender_montage. The baseline is a file on disk, never the session's own state: it is opened, rendered, and the workspace blend put back, so a comparison never replaces what you are looking at. A baseline missing subjects you named is reported as missingSubjects rather than rendered as an absence. Works with no window: both generations then render headlessly.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — Module whose two generations are compared. Defaults the baseline from this module's run history, and writes modules/<name>/compare.png.
- **baselineBlendPath** — The generation to compare against — normally a checkpoint under modules/<name>/runs/NN/. Defaults to the run immediately before this module's latest one. Refused outright when there is none, because a sheet of one generation wearing a comparison's labels invites reading the build as an improvement over nothing.
- **baselineLabel** — What to call the baseline in every panel label. Default its iteration number when the baseline came from run history, and BEFORE when you named the path yourself.
- **currentLabel** — What to call the current generation. Default AFTER.
- **views** — Preset view names, same as blender_montage. Two to four make a readable sheet; with columns 2 each view's two generations sit adjacent, so the reading order IS the comparison.
- **subject** — Objects to frame and compare. Defaults to every visible mesh. Pass names when one module is the subject and the rest of the scene is context.
- **columns** — Sheet columns. Default 2, so a view's two generations sit side by side.
- **panelResolution.x** — Panel width in pixels (default 900).
- **panelResolution.y** — Panel height in pixels (default 700).
- **timeoutMs** — Bridge timeout override in ms. Defaults to eight times the single-render budget: this renders every panel twice and opens a second blend.
- **async** — If true, dispatch the compare as a deferred non-blocking job and return immediately with a job handle ({ jobId, state: 'running' }), releasing bridge.lock.

### blender_get_python_api_docs

Look up authoritative documentation and signatures from the Blender 4.2 LTS Python API reference for a specific identifier (e.g. bpy.types.Modifier, bpy.ops.mesh.primitive_uv_sphere_add, bpy.data.objects) or list matching identifiers and submodules when ending with a wildcard * (e.g. bpy.ops.mesh.*, bpy.types.*). Offline and fast; does not require a running Blender instance or bridge lock.

- **identifier** — The bpy identifier to look up (e.g. 'bpy.types.Modifier', 'bpy.ops.mesh.primitive_uv_sphere_add'), or a wildcard query (e.g. 'bpy.ops.mesh.*', 'bpy.types.*') to list available members.

### blender_search_api_docs

Perform full-text search across the curated Blender 4.2 LTS Python API reference corpus (bpy.types, bpy.ops, bpy.data, bpy.context, bpy.props). Returns matching API signatures, descriptions, and parameter definitions. Offline and fast; does not require a running Blender instance or bridge lock.

- **query** — Search query string to match against Blender 4.2 LTS API reference (types, operators, signatures, properties).
- **limit** — Maximum number of search results to return (default 10).

### blender_search_manual_docs

Perform full-text search across curated Blender 4.2 LTS user manual excerpts covering modeling, modifiers, rigging, shading, render, and geometry nodes. Returns matching topics, explanations, and workflows. Offline and fast; does not require a running Blender instance or bridge lock.

- **query** — Search query string to match against Blender 4.2 LTS user manual excerpts (modeling, modifiers, rigging, shading, render, geometry nodes).
- **limit** — Maximum number of search results to return (default 10).
