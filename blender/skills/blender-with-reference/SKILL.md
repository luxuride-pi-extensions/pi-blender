---
name: blender-with-reference
description: Use attached reference images or style cues while planning Blender work.
---

# Blender With Reference

Use this skill when the user supplies reference images or asks to match a style or shape cue.

Workflow:
1. Get the caption from `blender-reference-describer` before you register anything. It reads the image and returns `Subject`, `Viewpoint`, `Lighting`, `Palette`, a `Suggested view`, and a `Suggested caption` you can paste verbatim. This is not optional and not a formality: you have no image input, so a caption you compose is a guess, and a guess that is wrong about the SUBJECT produces a well-built model of the wrong thing which then reads as success to every agent downstream. Pass the user's own caption to the describer as a hypothesis; if it reports `Caption check: differs`, believe the describer and tell the user their description was off.
2. Register every reference with `blender_add_reference` using that caption. It copies the image into `<workspace>/references/` and records it in the manifest, so the reference cannot vanish mid-build and you can list the set. Keep the returned id and path for the briefs below.
3. Combine this skill with `blender-create` or `blender-edit` depending on whether the scene is new or existing.
4. Carry the describer's cues — silhouette, proportion, material, lighting — into each worker's brief.
5. Keep those cues visible in your plan.
6. If the user is framing a comparison manually or referring to the currently selected object or current view, follow the `blender-live-state` skill before choosing a target and viewpoint.
7. When viewpoint matters, have the worker update its agent-managed evaluation camera in its module script before execution, or capture a user-set viewport with `blender_save_view`. Better view alignment makes critique and iteration much more reliable.
8. Render and compare the result against the references after significant changes.
9. When critiquing a create/edit iteration, include reference mismatch details in the `issues` the critic logs to `blender_log_critique`, and use its `viewAdequacy` judgment to record when the current render view is too weak for a fair reference comparison.

Reference pairing — you cannot see images:
- You have no image-reading tool, so you never compare a render to a reference yourself. You choose the pairing and hand it to a critic as text; the critic is the only one who can test it. This is an enforced limit, not a habit: the manager's image reads are blocked by a gate, so a `.png` opened with `read` is refused outright. The only route to what a reference shows is `blender-reference-describer`.
- `blender_add_reference` returns the whole set of references in the workspace, so when the user adds a third image mid-build you can re-read the manifest rather than reconstructing which ones exist. Its `suggestedView` is your hypothesis, not a decision — a critic confirms or rejects it.
- For every reference, state its path, what the describer said it depicts, and which view you want. A reference with no stated subject is a wasted pairing — send it to the describer rather than guessing.
- A reference is both a worker input and a critic input. Give the worker the path so it can build toward it, and the critic the same path so it can judge against it.
- One `render.png` exists at a time, so the unit of work is a (view, reference) PAIR. For several references, spawn one critic per pair, each seeing only its own render and its own reference, then reconcile the reports yourself as text.
- Each critic has a budget of ONE render and ONE reference. Never ask one to cover two references.
- If a critic reports the pair is `not-comparable` because the viewpoint, crop, pose, scale, or subject differs, that is it answering your question, not failing. Use the view it names in `nextAction` to re-pair.
- When the mismatch is the VIEWPOINT rather than the geometry, spawn `blender-camera-aligner` instead. It iterates the camera against a reference using nested critics and never sees an image itself. Give it the describer's `Suggested view` and what it said the reference depicts.

Rules:
- Treat references as constraints for planning and evaluation.
- Do not claim exact visual matches without rendering and checking.
- Live state rules: see the `blender-live-state` skill. Use the authoritative block for this turn only; never infer current selection or viewpoint from history.
- If a reference must be compared against the live viewpoint, resolve the viewpoint first (live block, else `blender_session_context`), then render.
- Keep the same explicit `workspace` throughout the full iteration loop.
- Do not change user-created views or cameras just to match a reference. Have the worker create a new agent-owned saved view/camera when a better comparison angle is needed.
- If the user does not specify a render view, workers may manage agent-owned evaluation views and refine them across iterations so the render perspective better matches the reference or exposes important mismatches.
- If the user specifies a render view or camera, treat it as locked unless the user explicitly asks you to change it.
