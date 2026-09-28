---
name: blender-modules
description: Multi-part Blender work structured as Manager > per-module worker agents with a separate critic. Use when a task has several objects or concerns (body + rig + paint, multi-object scenes) and the user wants modular, revertible runs.
---

# Blender Modules

Use this skill when a Blender task has **multiple objects or concerns** (e.g. "build a robot: body, head, armature, texture paint") or the user asks for modular/revertible work. A single-part quick change is still one small worker module — just do not split it into several — because the manager's write/edit gate blocks direct authoring either way, and a module is what makes the change revertible.

**Delegation is mandatory.** The main session (you) IS the MANAGER. You MUST spawn `blender-worker` and `blender-critic` subagents for every module. You must NOT write module scripts, run `blender_module_run`, render, or edit scene objects directly. Delegating to subagents saves context by keeping each agent focused on one task.

## Enabling delegation

Before spawning your **first worker or critic subagent**, call `subagents_enable` (no arguments) once. Fresh sessions do not have the `subagent` tool active until you enable it — spawning before enabling will fail or force a fallback to direct execution. If `subagents_enable` or `subagent` is not in your tool list at all, pi-subagents is not loaded in this app. Report that to the user and stop. Do not fall back to authoring the root `script.py` yourself: the session's write/edit gate blocks that path, and a direct `bash` write would bypass the module checkpointing that makes the work revertible.

## Roles and context budget

Spawn workers and critics as the **bundled agent types**, not generic ones: `blender-worker` (writes and runs module code) and `blender-critic` (read-only render judge). They ship with the extension, carry the right tool allowlist, and load it themselves — a generic `worker` has neither the blender tools nor the workspace skills, which is the most common cause of a stalled modular run.

- **Manager** = the main session (you). You hold the user's goal, the module breakdown, each module's **brief**, and each module's **report** and **critique**. You NEVER read module source code — that is the whole point: your context stays small. You MUST spawn subagents for all work; you plan, brief, and orchestrate only. The main session ALWAYS plays the manager role for multi-part Blender work — never do the work directly.
- **Worker** = one `blender-worker` subagent per module. It receives the brief + workspace + module name, authors/edits `modules/<name>/script.py`, runs it via `blender_module_run`, and returns a report. It owns its module's code.
- **Critic** = a `blender-critic` subagent (fresh context) per module per iteration. It judges how the result **looks** against the brief — vision on `modules/<name>/render.png` plus the report — and returns a critique. It does not edit anything.

If `blender-worker` / `blender-critic` are not offered by the subagent tool, the bundled agent directory is not being discovered: check `subagents.defaultExtensions` (or `subagents.defaultSubagentOnlyExtensions`) in settings — the children need the `vibe-blender` extension loaded to see these agent types and their blender tools.

Rules:
- Keep the brief **compact** (< ~20 lines): goal, exact object names in the scene, visual acceptance criteria, constraints (materials, colors, proportions), workspace path, module name, and which subagents (if any) it depends on.
- Keep the report **compact** (< ~20 lines): what was built/changed (object names + key parameters), script status (exit code, notable warnings), what render.png shows, open questions. No source code, no logs.
- Worker and critic must NOT paste `script.py` contents into their outputs. If the manager needs code detail, it says so and reads the file itself — one-off, not routine.
- **One module at a time per blend.** Modules share `model.blend`; concurrent `blender_module_run` calls would clobber each other's checkpoints. Run workers sequentially in the parent (await each before launching the next), or explicitly order dependent modules (body → head → rig → paint).
- Dependencies: a module that references other modules' objects (e.g. armature parenting to body) gets a brief that names those objects and states they must already exist.

## Module run loop (per module)

0. (Once, before the first module) Ensure delegation is enabled: `subagents_enable` (see above).
1. Manager writes the brief (in the subagent task text). Run `blender_bridge_status` first if you are unsure whether the live UI is up — the worker's first tool call will otherwise pay the cold-start cost blindly.
2. **Worker subagent** (`blender-worker`):
   1. (First run only) writes `modules/<name>/script.py` in the workspace — a self-contained bpy script that is **idempotent-safe**: it should create or modify its objects by name and skip/rebuild what it owns (guard with `bpy.data.objects.get(...)`), so re-runs don't duplicate.
   2. Calls `blender_module_run {workspace, moduleName, render: true}`. Every run writes its own checkpoint at `modules/<name>/runs/NN/pre-NN.blend` **before** executing, and the run is recorded in the workspace manifest (`moduleRuns`). A failed run records nothing and does not consume an iteration.
   3. On failure: read the error, fix `script.py`, re-run (max 3 self-fix attempts). If still failing, report the failure — do not revert by yourself unless the brief says so.
3. **Critic subagent** (`blender-critic`, fresh context, after the worker reports success):
   1. Gets the brief + the worker's report.
   2. Opens `modules/<name>/render.png` (read tool / image) and inspects the look against the acceptance criteria. May call `blender_scene_info {categories: ["objects","uv","textures","paintSettings","armatures"]}` for facts.
   3. Returns: PASS or FAIL, concrete visual issues (framing/perspective problems called out as "view problem" vs "object problem"), suggested next brief edits. No source code.
   4. The critic (not the manager) logs the verdict with `blender_log_critique`, so the score, view-adequacy judgment and next action land in `critique.log` next to the render they describe.
4. Manager decision:
   - PASS → mark module done; next module or present.
   - FAIL with "object problem" → send the worker a follow-up brief with the critic's issues (worker iterates on `script.py`, re-runs).
   - FAIL with "view problem" → do NOT re-render yourself. Spawn `blender-camera-aligner` with the view, the render, and (if any) the reference; it nests its own critics and returns a framing. Then re-spawn the critic against the new view.
   - Wrong direction → "view problem" or a bad approach → `blender_module_revert {workspace, moduleName, iteration?}`, then new brief.
   - Max 3 worker iterations per module per instruction; then escalate to the user with the report + critique.

## Routing: which agent, for which question

Worker and critic cover most work. Four situations need someone else — you still write the brief, never the code:

- **Measured structural fault** (floating, buried, rotated, intersecting, or "the handle is in the wrong place"): spawn `blender-diagnostician` with the symptom and object names. It returns real distances, angles, and signed penetrations. Put its numbers in the worker's next brief. Never estimate an offset yourself, and never ask a critic to infer one from a picture — a render shows that something is wrong, not by how much.
- **Wrong viewpoint rather than wrong geometry** (the reference shows a different side, the framing crops the part, the pose differs): spawn `blender-camera-aligner`. It never sees an image; it reads critic text verdicts and moves the camera until `View match: matched`. Do not spawn a critic to judge a view the aligner is still iterating on.
- **Asset handoff** (the user wants a reusable asset, not a scene): when the last module passes, spawn `blender-finalizer` ONCE. It applies scale/rotation transforms, resolves mirrored objects, sets origins, picks smooth vs flat shading, and normalizes names. Only after that: every later edit re-dirties what it applied. It does not export — the deliverable is `model.blend`.
- **Several references at once**: one `render.png` exists at a time, so the unit of work is a (view, reference) pair. Spawn one critic per pair, each seeing only its own render and its own reference, then reconcile the reports as text. A `not-comparable` verdict names the view it wants — that is a routing answer, not a failure.

Check the subject exists before dispatching any judge: `blender_scene_info {categories: ["objects"]}`. `reference-only` means it was never built; `different-subject` means the wrong image, and no camera fixes that.

## Revert semantics

- Every module run records `{name, iteration, checkpointPath, sequence}` in the manifest's `moduleRuns`, where `checkpointPath` is `modules/<name>/runs/NN/pre-NN.blend` — the blend **immediately before that specific run**.
- `blender_module_revert {workspace, moduleName}` restores the module's **latest recorded run**; pass `iteration: N` to restore an earlier one. It copies the checkpoint over `model.blend`, reloads the live session, and trims the manifest history to match.
- Modules share one `model.blend`, so a revert can destroy other modules' work. If runs *later* than the target also touched the blend, revert **refuses** with the list of affected modules; pass `force: true` only when you accept discarding them. It also reports `discardedLaterRuns` when it does proceed.
- After a revert, the worker's `script.py` is untouched (revert restores the blend, not the code) — the next run re-applies the fixed script.

## Manager report to the user

When all modules PASS (or the cap is hit), summarize per module: name, one-line outcome, PASS/FAIL, render path. Do not include code. Suggest the next instruction (e.g. "want me to paint the body next?").

Always include the live-state line in every brief: the worker and critic do NOT receive the manager's injected live Blender state block, so if the brief depends on "the selected object" or "the current view", state the concrete object/camera names explicitly (or tell the worker to resolve them with `blender_session_context` first).

## Example brief (worker)

```
You are a Blender module worker.
Workspace: outputs/robot
Module: body  (script: outputs/robot/modules/body/script.py)
Goal: build a low-poly robot torso + hips as one mesh "robot_body" at origin, ~1.2m tall torso, beveled boxy style, material "m_robot_body" (dark gray metal, roughness 0.35).
Accept: silhouette reads as a robot torso in a front render; no floating geometry; exactly one object named robot_body.
Do not modify other objects. When done run blender_module_run {workspace, moduleName: "body", render: true} and report in <20 lines (objects created, exit status, what render.png shows). No source code in the report.
```

## Example brief (critic)

```
You are a Blender module critic. Do not edit anything.
Workspace: outputs/robot, module: body.
Brief: <the worker brief above>
Worker report: <the worker report>
Look at outputs/robot/modules/body/render.png. Judge ONLY: does it look like the brief asks for? List concrete visual issues; label each "object" or "view". Verdict PASS or FAIL + one-line reasoning.
```
