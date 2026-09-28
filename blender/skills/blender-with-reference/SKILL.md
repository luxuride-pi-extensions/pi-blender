---
name: blender-with-reference
description: Use attached reference images or style cues while planning Blender work.
---

# Blender With Reference

Use this skill when the user supplies reference images or asks to match a style or shape cue.

Workflow:
1. Register every reference with `blender_add_reference` before using it. It copies the image into `<workspace>/references/` and records it in the manifest, so the reference cannot vanish mid-build and you can list the set. The `caption` is required: you cannot read the image yourself, so the caption is the only thing the worker and critic will know about it. Keep the returned id and path for the briefs below.
2. Combine this skill with `blender-create` or `blender-edit` depending on whether the scene is new or existing.
3. Extract the most important shape, composition, material, and lighting cues from the references, and carry them into each worker's brief.
4. Keep those cues visible in your plan.
5. If the user is framing a comparison manually or referring to the currently selected object or current view, follow the `blender-live-state` skill before choosing a target and viewpoint.
6. When viewpoint matters, have the worker update its agent-managed evaluation camera in its module script before execution, or capture a user-set viewport with `blender_save_view`. Better view alignment makes critique and iteration much more reliable.
7. Render and compare the result against the references after significant changes.
8. When critiquing a create/edit iteration, include reference mismatch details in the `issues` the critic logs to `blender_log_critique`, and use its `viewAdequacy` judgment to record when the current render view is too weak for a fair reference comparison.

Reference pairing — the manager cannot see images:
- The session's write gate blocks the manager from reading image files, so you never compare a render to a reference yourself. You choose the pairing and hand it to a critic as text; the critic is the only one who can test it.
- `blender_add_reference` returns the whole set of references in the workspace, so when the user adds a third image mid-build you can re-read the manifest rather than reconstructing which ones exist. Its `suggestedView` is your hypothesis, not a decision — a critic confirms or rejects it.
- For every reference, state its path, what it depicts, and which view you want. A reference with no stated subject is a wasted pairing — ask the user rather than guessing.
- A reference is both a worker input and a critic input. Give the worker the path so it can build toward it, and the critic the same path so it can judge against it.
- One `render.png` exists at a time, so the unit of work is a (view, reference) PAIR. For several references, spawn one critic per pair, each seeing only its own render and its own reference, then reconcile the reports yourself as text.
- Each critic has a budget of ONE render and ONE reference. Never ask one to cover two references.
- If a critic reports the pair is `not-comparable` because the viewpoint, crop, pose, scale, or subject differs, that is it answering your question, not failing. Use the view it names in `nextAction` to re-pair.
- When the mismatch is the VIEWPOINT rather than the geometry, spawn `blender-camera-aligner` instead. It iterates the camera against a reference using nested critics and never sees an image itself.

Rules:
- Treat references as constraints for planning and evaluation.
- Do not claim exact visual matches without rendering and checking.
- Live state rules: see the `blender-live-state` skill. Use the authoritative block for this turn only; never infer current selection or viewpoint from history.
- If a reference must be compared against the live viewpoint, resolve the viewpoint first (live block, else `blender_session_context`), then render.
- Keep the same explicit `workspace` throughout the full iteration loop.
- Do not change user-created views or cameras just to match a reference. Have the worker create a new agent-owned saved view/camera when a better comparison angle is needed.
- If the user does not specify a render view, workers may manage agent-owned evaluation views and refine them across iterations so the render perspective better matches the reference or exposes important mismatches.
- If the user specifies a render view or camera, treat it as locked unless the user explicitly asks you to change it.
