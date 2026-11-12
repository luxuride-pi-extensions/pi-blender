---
name: blender-create
description: Create a new Blender scene inside an explicit managed workspace.
---

# Blender Create

Use this skill when the user wants a brand-new Blender scene or object.

Workflow:
1. Call `blender_workspace_init` first with an explicit `workspace` when the user provides one, otherwise create a new workspace. The default `studio` template gives you a camera, a three-point light rig, and EEVEE at 1200x900, so a worker can model immediately.
2. Delegation is the next step: if `subagent` is not in your tool list, call `subagents_enable` (no arguments) once before dispatching anyone. Sessions that already have it delegate directly.
3. Inspect requirements before dispatching anyone. If references are attached, combine this with `blender-with-reference` and incorporate them into planning. If the user refers to "it", "this", the selected object, or the current view, follow the `blender-live-state` skill before choosing a target.
4. Check the subject exists before dispatching a judge: `blender_scene_info` with `categories: ["objects"]`. A reference may depict an object the scene has never had — that is a missing subject, not a modelling bug.
5. You are the MANAGER. Spawn a `blender-worker` per module and a fresh `blender-critic` per module per iteration. You never write bpy code yourself, never call `blender_module_run`, and never edit scene objects. The session's write/edit gate blocks that path by design, so a direct approach is a dead end — delegate first, without waiting to be asked.
6. For each new user instruction, run a worker-then-critic loop with at most 5 iterations: the worker authors and runs `modules/<name>/script.py`, the critic judges the render against the brief, and you decide whether to stop or issue a follow-up brief.
7. If the problem is the VIEWPOINT rather than the geometry — reference and render show the subject from different sides — spawn `blender-camera-aligner` instead of a critic. It nests its own critics and never sees an image.
8. When the build is an ASSET the user intends to hand off, spawn `blender-finalizer` once at the very end. It applies transforms, sets origins and shading, and normalizes names. Not before: every later edit re-dirties what it applied.
9. If a structural or spatial problem is suspected (floating, buried, rotated, intersecting), spawn `blender-diagnostician` with the symptom and object names, then put its measured numbers into the worker's next brief. Never guess an offset yourself, and never ask a critic to estimate one from a picture.
10. If the user is manually setting a viewport perspective, capture it with `blender_save_view`. Otherwise workers manage their own agent-owned evaluation views.
11. The score, view-adequacy judgment, and next action land in `$workspace/critique.log` next to the render they describe. Loop rules (shared — keep byte-identical in every skill that runs the loop): run at most five critic iterations per module; the critic calls `blender_log_critique`; stop when the critic passes or the cap is reached. Before spending another run, call `blender_iteration_state`: an exhausted budget, two identical critiques, or an unchanged digest ends the loop. Present the result when the loop ends.
12. Reuse the same explicit `workspace` across continuation turns.

Rules:
- Keep all Blender mutations inside the managed workspace, and delegate them to workers.
- Live state rules: see the `blender-live-state` skill. Use the authoritative block for this turn only; never infer current selection from history.
- When the request depends on the live Blender selection or active object, state what target you resolved before changing it.
- Base every new iteration on the critique from the previous render instead of changing unrelated parts.
- Treat render perspective as part of the task. If the current view hides important shape, proportion, or material problems, have the worker create or change saved views before the critic judges.
- Do not overwrite or repurpose user-created views or cameras unless the user explicitly asks. If you need a better evaluation angle, have the worker create a new agent-owned saved view/camera instead.
- If the user does not specify a render view, workers may manage agent-owned evaluation views such as `agent_eval_main`, `agent_eval_wide`, or `agent_eval_detail`, and update them across iterations based on render results.
- If the user specifies a render view or camera, treat it as locked unless the user explicitly asks to change it.
- One module at a time: modules share `model.blend` and one live Blender UI, so a parallel spawn queues behind the first and then times out.
- Mention the workspace path in your response so follow-up turns can keep using it.

## Tool semantics moved out of the schemas

The tool and parameter descriptions below are the full text that used to live in
`core/tools.ts`. The schema keeps each first sentence for tool selection; load
this skill when you need the precedence rules, failure modes and definitions.

### blender_export_asset

Export the workspace blend to an interchange format: glb or gltf (materials, scene graph, modifiers applied) or obj (geometry, UVs, materials) or stl. This is what makes the asset leave Blender at all -- .blend is not an interchange format and no training pipeline reads it. Works headlessly. Pass `objects` to export a named subset, which is how you keep the studio rig out of a dataset. Read-only with respect to model.blend: the exporter writes a new file and never saves back.

- **workspace** — Explicit workspace path for the Blender task.
- **format** — glb (default, single file), gltf (separate .bin and textures), obj, or stl. USD is not offered because no exporter is guaranteed present in a stock Blender build.
- **objects** — Names to export, when given. Omit for the whole blend. Naming the asset's own objects is how a studio camera and three lights stay out of the dataset.
- **outputDir** — Directory for the exported file. Defaults to the blend's own directory.
- **name** — Base filename, without extension. Defaults to the blend's name. Sanitised, since it usually comes from a prompt.
- **animations** — Include animation data (glTF only). Default false.
- **allowUnfinalized** — Export a build that has not reached finalized. The build contract refuses an earlier export otherwise, because an intermediate state is not the asset.
- **validationProfile** — Validation to run on the written file. gltf (default) checks nodes, meshes, accessors and images; print checks manifold edges, self-intersection, winding and unit scale; engine checks texture size and material count; none skips it.

### blender_import_asset

Import an external 3D asset (obj, stl, gltf/glb, fbx) into the workspace blend. Checkpoints the workspace blend before importing so partial imports are cleanly revertible. Guards against path traversal and sanitizes asset names. Probes format and add-on support (e.g. FBX), reporting missing capabilities as explicit results rather than tracebacks. Returns a post-import report detailing imported objects, non-uniform scale checks, and principal axes.

- **workspace** — Explicit workspace path for the Blender task.
- **path** — Path to the 3D asset file to import (obj, stl, gltf, glb, or fbx).
- **format** — Format of the asset: obj, stl, gltf, glb, or fbx. If omitted, inferred from file extension.
- **name** — Optional asset name or object name prefix. Sanitized against invalid characters.
- **allowedPaths** — Allowed directories or file paths for source assets to guard against traversal. Defaults to the workspace directory and current working directory.

### blender_add_reference

Register a reference image with a workspace. Copies the image into <workspace>/references/ and records it in the manifest so it can be listed, addressed by a stable id in briefs, and handed to a critic that cannot read images. The `caption` is required and is the only description of the image available to the worker and critic, because the manager is blocked from reading image files.

- **workspace** — Explicit workspace path for the Blender task.
- **path** — Path to an existing image file on disk. It is COPIED into the workspace references/ directory, so later moves or deletions of the original do not break pending work. Supported: .png .jpg .jpeg .gif .webp .bmp
- **url** — HTTPS image URL on a CC0 host (cdn.polyhaven.com or dl.polyhaven.org), downloaded once and then copied in. Use blender_reference_search to find one. Pass either path or url, not both.
- **license** — Licence stated by the source, e.g. CC0-1.0. Recorded in the manifest.
- **credit** — Credit line required or recommended by the source. Recorded in the manifest.
- **caption** — What this image depicts, in one or two sentences: the subject, the angle it is shot from, and anything a worker or critic would need to judge against it. Required — you cannot read the image yourself, so this text is the only thing that will convey its contents.
- **id** — Stable id to address this reference by in briefs, e.g. 'front' or 'three-quarter'. Defaults to the file's name without its extension. Adding a reference whose id is taken stores it as <id>-2 rather than overwriting, so earlier verdicts stay reproducible.
- **suggestedView** — Optional saved view or camera name you believe this reference should be compared against. The pairing is a hypothesis: a critic will report whether the two images are actually comparable, and name the view it would prefer if not.

### blender_reference_search

Search CC0 reference catalogues (Poly Haven models/textures/HDRI, ambientCG materials) and return metadata, licence, credit and a preview URL. It does not download anything: choose a candidate and pass its preview URL to blender_add_reference, which fetches it once, records provenance and copies it into the workspace.

- **query** — Words to match against the asset name, id and tags.
- **source** — Catalogue to search. Default polyhaven.
- **kind** — Poly Haven asset type. Default model.
- **limit** — Maximum candidates (1–24, default 8).
