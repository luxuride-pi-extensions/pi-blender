---
name: blender-create
description: Create a new Blender scene inside an explicit managed workspace.
---

# Blender Create

Use this skill when the user wants a brand-new Blender scene or object.

Workflow:
1. Call `blender_workspace_init` first with an explicit `workspace` when the user provides one, otherwise create a new workspace. The default `studio` template gives you a camera, a three-point light rig, and EEVEE at 1200x900, so a worker can model immediately.
2. Enable delegation once with `subagents_enable` (no arguments). Fresh sessions do not have the subagent tool until you enable it.
3. Inspect requirements before dispatching anyone. If references are attached, combine this with `blender-with-reference` and incorporate them into planning. If the user refers to "it", "this", the selected object, or the current view, follow the `blender-live-state` skill before choosing a target.
4. Check the subject exists before dispatching a judge: `blender_scene_info` with `categories: ["objects"]`. A reference may depict an object the scene has never had — that is a missing subject, not a modelling bug.
5. You are the MANAGER. Spawn a `blender-worker` per module and a fresh `blender-critic` per module per iteration. You never write bpy code yourself, never call `blender_module_run`, and never edit scene objects. The session's write/edit gate blocks that path by design, so a direct approach is a dead end — delegate first, without waiting to be asked.
6. For each new user instruction, run a worker-then-critic loop with at most 5 iterations: the worker authors and runs `modules/<name>/script.py`, the critic judges the render against the brief, and you decide whether to stop or issue a follow-up brief.
7. If the problem is the VIEWPOINT rather than the geometry — reference and render show the subject from different sides — spawn `blender-camera-aligner` instead of a critic. It nests its own critics and never sees an image.
8. When the build is an ASSET the user intends to hand off, spawn `blender-finalizer` once at the very end. It applies transforms, sets origins and shading, and normalizes names. Not before: every later edit re-dirties what it applied.
9. If a structural or spatial problem is suspected (floating, buried, rotated, intersecting), spawn `blender-diagnostician` with the symptom and object names, then put its measured numbers into the worker's next brief. Never guess an offset yourself, and never ask a critic to estimate one from a picture.
10. If the user is manually setting a viewport perspective, capture it with `blender_save_view`. Otherwise workers manage their own agent-owned evaluation views.
11. Each critic calls `blender_log_critique`, so the score, view-adequacy judgment, and next action land in `$workspace/critique.log` next to the render they describe. Present the result once the critic passes or the iteration cap is reached.
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
