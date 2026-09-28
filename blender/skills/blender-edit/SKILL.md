---
name: blender-edit
description: Edit an existing Blender workspace or source blend with inspection before mutation.
---

# Blender Edit

Use this skill when the user wants to change an existing Blender scene.

Workflow:
1. Initialize or reopen the workspace with `blender_workspace_init`, passing `continueExisting: true` so it is not reinitialized from the template.
2. Enable delegation once with `subagents_enable` (no arguments). Fresh sessions do not have the subagent tool until you enable it.
3. Call `blender_scene_info` with `categories: ["objects"]` before dispatching anyone unless the request is trivial and local. You need the real object names to write a usable brief.
4. If the user refers to "it", "this", the selected object, the active object, or the current view, follow the `blender-live-state` skill before choosing a target.
5. You are the MANAGER. Spawn a `blender-worker` per module and a fresh `blender-critic` per module per iteration. You never write bpy code yourself, never call `blender_module_run`, and never edit scene objects. The session's write/edit gate blocks that path by design, so a direct approach is a dead end — delegate first, without waiting to be asked.
6. For each new user instruction, run a worker-then-critic loop with at most 5 iterations: the worker authors and runs `modules/<name>/script.py`, the critic judges the render against the brief, and you decide whether to stop or issue a follow-up brief.
7. If the complaint is a wrong side, wrong framing, or a reference from a different viewpoint, spawn `blender-camera-aligner` rather than a critic. It nests its own critics and never sees an image.
8. If a structural or spatial problem is suspected (floating, buried, rotated, intersecting), spawn `blender-diagnostician` with the symptom and object names, then put its measured numbers into the worker's next brief. Never guess an offset yourself, and never ask a critic to estimate one from a picture.
9. If the edit finishes an asset the user intends to hand off, spawn `blender-finalizer` once at the very end, after the last critic pass.
10. If the user is manually setting a viewport perspective, capture it with `blender_save_view`. Otherwise workers manage their own agent-owned evaluation views.
11. Each critic calls `blender_log_critique`, so the score, view-adequacy judgment, and next action land in `$workspace/critique.log` next to the render they describe. Present the result once the critic passes or the iteration cap is reached.
12. Reuse the same explicit `workspace` across continuation turns.

Rules:
- Keep `workspace` explicit in every Blender tool call, and delegate every mutation to a worker.
- Prefer small, reversible module edits over rebuilding the whole scene. A named module can be reverted with `blender_module_revert`; a root script cannot.
- Live state rules: see the `blender-live-state` skill. Use the authoritative block for this turn only; never infer current selection from history.
- When the request is ambiguous, state which active or selected object you resolved before dispatching a worker.
- Base each new iteration on the critique from the prior render.
- Treat camera/view management as part of the edit loop. If the current render angle is weak, have the worker save or update a better agent-owned view before the critic judges whether the edit worked.
- Do not modify user-created views or cameras unless the user explicitly asks. If the current views are insufficient, have the worker create a new agent-owned saved view/camera for evaluation.
- If the user does not specify a render view, workers may manage agent-owned evaluation views such as `agent_eval_main`, `agent_eval_wide`, or `agent_eval_detail`, and update them when renders show poor framing or miss important parts of the scene.
- If the user specifies a render view or camera, treat it as locked unless the user explicitly asks to change it.
- One module at a time: modules share `model.blend` and one live Blender UI, so a parallel spawn queues behind the first and then times out.
- Explain what changed and what remains unchanged.
