---
name: blender-modules
description: Multi-part Blender work structured as Manager > per-module worker agents with a separate critic. Use when a task has several objects or concerns (body + rig + paint, multi-object scenes) and the user wants modular, revertible runs.
---

# Blender Modules

Use this skill when a Blender task has **multiple objects or concerns** (e.g. "build a robot: body, head, armature, texture paint") or the user asks for modular/revertible work. A single-part quick change is still one small worker module — just do not split it into several — because the manager's write/edit gate blocks direct authoring either way, and a module is what makes the change revertible.

**Delegation is mandatory.** The main session (you) IS the MANAGER. You MUST spawn `blender-worker` and `blender-critic` subagents for every module. You must NOT write module scripts, run `blender_module_run`, render, or edit scene objects directly. Delegating to subagents saves context by keeping each agent focused on one task.

## Delegation

`subagent` is already in your tool list in most sessions, and then the first spawn needs no setup at all. A session on a model that adds tools mid-conversation starts with `subagents_enable` active instead: call it once, with no arguments, before the first spawn — some providers surface the tool only on the following turn, so wait rather than retrying. If neither `subagent` nor `subagents_enable` is in your tool list, pi-subagents is not loaded in this app. Report that to the user and stop. Do not fall back to authoring the root `script.py` yourself: the session's write/edit gate blocks that path, and a direct `bash` write would bypass the module checkpointing that makes the work revertible.

## Roles and context budget

Spawn workers and critics as the **bundled agent types**, not generic ones: `blender-worker` (writes and runs module code) and `blender-critic` (read-only render judge). They ship with the extension, carry the right tool allowlist, and load it themselves — a generic `worker` has neither the blender tools nor the workspace skills, which is the most common cause of a stalled modular run.

- **Manager** = the main session (you). You hold the user's goal, the module breakdown, each module's **brief**, and each module's **report** and **critique**. You NEVER read module source code — that is the whole point: your context stays small. You MUST spawn subagents for all work; you plan, brief, and orchestrate only. The main session ALWAYS plays the manager role for multi-part Blender work — never do the work directly.
- **Worker** = one `blender-worker` subagent per module. It receives the brief + workspace + module name, authors/edits `modules/<name>/script.py`, and returns a report. It owns its module's code.
- **Script runner** = one `blender-script-runner` only when a watch window is open and more than one worker is authoring at once. It runs the queued module scripts one at a time against the live session and reports contamination. With no watch window, workers stage their own branches and the manager applies the batch once.
- **Merger** = one `blender-merger`, once, after every part exists, and only when the parts actually need joining.
- **Critic** = a `blender-critic` subagent (fresh context) per module per iteration. It judges how the result **looks** against the brief — vision on `modules/<name>/render.png` plus the report — and returns a critique. It does not edit anything.

If `blender-worker` / `blender-critic` are not offered by the subagent tool, the bundled agent directory is not being discovered: check `subagents.defaultExtensions` (or `subagents.defaultSubagentOnlyExtensions`) in settings — the children need the `pi-blender` extension loaded to see these agent types and their blender tools.

Rules:
- Keep the brief **compact** (< ~20 lines): goal, exact object names in the scene, visual acceptance criteria, constraints (materials, colors, proportions), workspace path, module name, and which subagents (if any) it depends on.
- Keep the report **compact** (< ~20 lines): what was built/changed (object names + key parameters), script status (exit code, notable warnings), what render.png shows, open questions. No source code, no logs.
- Worker and critic must NOT paste `script.py` contents into their outputs. If the manager needs code detail, it says so and reads the file itself — one-off, not routine.
- **Authoring runs in parallel; execution does not run inside one session.** Workers writing separate `modules/<name>/script.py` files do not interfere, so spawn several in the same turn. With no watch window (the default) each worker stages its own headless branch with `blender_branch_run`, and you merge the staged branches in one conflict-checked `blender_branch_apply` pass. In a watch window every run shares one live Blender session behind a cross-process lock, so a second run blocks and then fails against a checkpoint computed before the first saved; there, hand the queue to one `blender-script-runner`. For a single-module change, keep the old shape (one worker, one critic) and do not add a runner for a queue of one.
- **Dependencies decide whether you can fan out.** If a module's brief assumes another module's objects already exist, those two cannot be spawned together. Fan out the independent modules; run the dependent ones in sequence after.
- **Scope every brief to one part.** Each worker brief must name the exact object names that worker OWNS, state that it must not modify/move/rename/delete anything else, and say which sibling parts it should expect to be absent. A brief that says "build the model" produces competing models in one blend.
- **Merging is a separate, later step.** Part workers do not join their work to anything. If the finished parts need one continuous surface, a single skin, or an armature bind, spawn `blender-merger` once after the parts exist; if they are already correct as separate objects with correct transforms and nobody asked for a join, do not spawn it.

## Module run loop (per module)

0. (Once, before the first module) Confirm `subagent` is in your tool list; if it is not, call `subagents_enable` once (see Delegation above).
1. Manager writes the brief (in the subagent task text). Run `blender_bridge_status` first if you are unsure whether the live UI is up — the worker's first tool call will otherwise pay the cold-start cost blindly.
2. **Worker subagents** (`blender-worker`, one per module — spawn several in the same turn when the parts are independent):
   1. (First run only) writes `modules/<name>/script.py` in the workspace — a self-contained bpy script that is **idempotent-safe**: it should create or modify its objects by name and skip/rebuild what it owns (guard with `bpy.data.objects.get(...)`), so re-runs don't duplicate. It touches only the object names its brief says it owns.
   2. Calls `blender_branch_run {workspace, moduleName, render: true}` to stage its branch — **unless a script-runner owns execution**. Every run writes its own checkpoint at `modules/<name>/runs/NN/pre-NN.blend` **before** executing, and the run is recorded in the workspace manifest (`moduleRuns`). A failed run records nothing and does not consume an iteration.
   3. On failure: read the error, fix `script.py`, re-run (max 3 self-fix attempts). If still failing, report the failure — do not revert by yourself unless the brief says so.
2b. **Script runner** (`blender-script-runner`, only when a watch window is open and more than one worker authored): gets the ordered queue of `{module, owns}` entries, runs each with `blender_module_run` in order against the live session, diffs the scene after each run, and reports contamination rather than repairing it. With no watch window, workers stage with `blender_branch_run` and the manager merges the batch once with `blender_branch_apply`; do not spawn a runner.
3. **Critic subagent** (`blender-critic`, fresh context, after the worker reports success):
   1. Gets the brief + the worker's report.
   2. Opens `modules/<name>/render.png` (read tool / image) and inspects the look against the acceptance criteria. May call `blender_scene_info {categories: ["objects","uv","textures","paintSettings","armatures"]}` for facts.
   3. Returns: PASS or FAIL, concrete visual issues (framing/perspective problems called out as "view problem" vs "object problem"), suggested next brief edits. No source code.
   4. The critic (not the manager) logs the verdict with `blender_log_critique`, so the score, view-adequacy judgment and next action land in `critique.log` next to the render they describe.
Loop rules (shared — keep byte-identical in every skill that runs the loop): run at most five critic iterations per module; the critic calls `blender_log_critique`; stop when the critic passes or the cap is reached. Before spending another run, call `blender_iteration_state`: an exhausted budget, two identical critiques, or an unchanged digest ends the loop. Present the result when the loop ends.

4. Manager decision:
   - PASS → mark module done; next module or present.
   - FAIL with "object problem" → send the worker a follow-up brief with the critic's issues (worker iterates on `script.py`, re-runs).
   - FAIL with "view problem" → do NOT re-render yourself. Spawn `blender-camera-aligner` with the view, the render, and (if any) the reference; it nests its own critics and returns a framing. Then re-spawn the critic against the new view.
   - Wrong direction → "view problem" or a bad approach → `blender_module_revert {workspace, moduleName, iteration?}`, then new brief.
   - Max 5 worker iterations per module per instruction; then escalate to the user with the report + critique.

## Routing: which agent, for which question

Worker and critic cover most work. Four situations need someone else — you still write the brief, never the code:

- **Measured structural fault** (floating, buried, rotated, intersecting, or "the handle is in the wrong place"): spawn `blender-diagnostician` with the symptom and object names. It returns real distances, angles, and signed penetrations. Put its numbers in the worker's next brief. Never estimate an offset yourself, and never ask a critic to infer one from a picture — a render shows that something is wrong, not by how much.
- **Wrong viewpoint rather than wrong geometry** (the reference shows a different side, the framing crops the part, the pose differs): spawn `blender-camera-aligner`. It never sees an image; it reads critic text verdicts and moves the camera until `View match: matched`. Do not spawn a critic to judge a view the aligner is still iterating on.
- **Asset handoff** (the user wants a reusable asset, not a scene): when the last module passes, spawn `blender-finalizer` ONCE. It applies scale/rotation transforms, resolves mirrored objects, sets origins, picks smooth vs flat shading, and normalizes names. Only after that: every later edit re-dirties what it applied. It does not export — the deliverable is `model.blend`.
- **The parts need joining** (one continuous surface, a single skin, an armature-bound character, one exportable object): spawn `blender-merger` ONCE after every part module has run. It authors `modules/merge/script.py`, reports whether a merge was needed at all, keeps the source parts unless told otherwise, and reports part problems rather than silently fixing geometry inside the merge.
- **Several references at once**: one `render.png` exists at a time, so the unit of work is a (view, reference) pair. Spawn one critic per pair, each seeing only its own render and its own reference, then reconcile the reports as text. A `not-comparable` verdict names the view it wants — that is a routing answer, not a failure.

Check the subject exists before dispatching any judge: `blender_scene_info {categories: ["objects"]}`. `reference-only` means it was never built; `different-subject` means the wrong image, and no camera fixes that.

## Revert semantics

- Every module run records `{name, iteration, checkpointPath, sequence}` in the manifest's `moduleRuns`, where `checkpointPath` is `modules/<name>/runs/NN/pre-NN.blend` — the blend **immediately before that specific run**.
- `blender_module_revert {workspace, moduleName}` restores the module's **latest recorded run**; pass `iteration: N` to restore an earlier one. It copies the checkpoint over `model.blend`, reloads the live session, and trims the manifest history to match.
- Modules share one `model.blend`, so a revert can destroy other modules' work. If runs *later* than the target also touched the blend, revert **refuses** with the list of affected modules; pass `force: true` only when you accept discarding them. It also reports `discardedLaterRuns` when it does proceed.
- After a revert, the worker's `script.py` is untouched (revert restores the blend, not the code) — the next run re-applies the fixed script.

## Manager report to the user

When all modules PASS (or the cap is hit), summarize per module: name, one-line outcome, PASS/FAIL, render path. Say whether a script-runner ran them or the workers ran their own, and report any contamination it found. Say whether a merge was needed and what it did, or that no merge was needed. Do not include code. Suggest the next instruction (e.g. "want me to paint the body next?").

Always include the live-state line in every brief: the worker and critic do NOT receive the manager's injected live Blender state block, so if the brief depends on "the selected object" or "the current view", state the concrete object/camera names explicitly (or tell the worker to resolve them with `blender_session_context` first).

## Example brief (worker)

```
You are a Blender module worker.
Workspace: outputs/robot
Module: body  (script: outputs/robot/modules/body/script.py)
Goal: build a low-poly robot torso + hips as one mesh "robot_body" at origin, ~1.2m tall torso, beveled boxy style, material "m_robot_body" (dark gray metal, roughness 0.35).
You own exactly one object: robot_body. Do not create, modify, move, rename or delete anything else — other workers own the other parts in parallel.
Accept: silhouette reads as a robot torso in a front render; no floating geometry; exactly one object named robot_body.
When done run blender_branch_run {workspace, moduleName: "body", render: true} and report in <20 lines (objects created, exit status, what render.png shows). No source code in the report.
```

## Example brief (critic)

```
You are a Blender script runner. You own execution for this workspace; the workers only author scripts.
Workspace: outputs/robot
Queue, in order: [{module: "body", owns: ["robot_body"]}, {module: "head", owns: ["robot_head"]}, {module: "arm_l", owns: ["robot_arm_l"]}]
Record the scene with blender_scene_info {categories: ["objects"]} first, run each module with blender_module_run in the order given, and diff the scene after each run. Report contamination, do not repair it.
```

## Tool semantics moved out of the schemas

The tool and parameter descriptions below are the full text that used to live in
`core/tools.ts`. The schema keeps each first sentence for tool selection; load
this skill when you need the precedence rules, failure modes and definitions.

### blender_workspace_init

Create or reopen a managed Blender workspace with a persistent model.blend and workspace manifest, and auto-open that blend in the live Blender session when available. When sourceBlend is given, the source scene is adopted wholesale as model.blend: this discards the default studio template rig and camera (StudioCamera, StudioKey, StudioFill, StudioRim), so the workspace inherits whatever lighting and cameras exist in the source file, or has none if none were defined.

- **workspace** — Explicit workspace path. Relative paths resolve from the current working directory.
- **sourceBlend** — Optional source .blend file to copy into the workspace as the starting model.blend. WARNING: adopting an external source scene wholesale discards the default studio lighting rig (StudioKey, StudioFill, StudioRim) and studio camera; the workspace inherits the source file's existing lighting and cameras, or lacks them entirely if the source defined none.
- **template** — Workspace template. "studio" (recommended) starts an empty file with a camera, a three-point light rig, a neutral world and EEVEE at 1200x900, so the first worker can model immediately instead of building a shot first. "blank" saves Blender's startup file as-is, with no camera or lights. Ignored when sourceBlend is given, since adopting a source blend wholesale discards the studio rig/lighting.
- **continueExisting** — When true, require the workspace to exist already instead of creating a new one.

### blender_module_run

Run a workspace module: checkpoint model.blend as the run found it to modules/<name>/runs/NN/pre-NN.blend, execute modules/<name>/script.py, save the result, and optionally capture a render to modules/<name>/render.png for critique. The run is recorded in the workspace manifest (moduleRuns), so blender_module_revert knows exactly which state it restores. Use one module per object or concern in multi-part tasks. With a window open it runs in the live session (executionMode "live-session"); with none, it runs HEADLESSLY against a branch copy and merges the result back (executionMode "headless-apply"), which is the normal case since /blender no longer opens a window. A branch staged this way can be merged with other staged branches in one conflict-checked pass by blender_branch_apply, which the manager holds. A headless run reports stateDigest — a content hash of the objects this module owns — plus unchangedSinceLastRun, which is true when the previous run of this module produced the same digest. An iteration that changed nothing produces the same render as the last one, so re-rendering and re-critiquing it buys a verdict you already have: read that flag before spending a critic.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — Module name (lowercase letters, digits, dashes). Resolves to modules/<name>/script.py.
- **render** — Capture a live camera render to modules/<name>/render.png after the run.
- **view** — Optional saved view name, camera object name, or "active-camera" to render from. Defaults to the active camera.
- **cameraProfile** — Headless path only: use-case profile selecting the default camera plan: prop, character, hard_surface, interior, print, paint, or asset_pack. Defaults to prop; a live run reports that it ignored this.
- **frontAxis** — Headless path only. Which world axis the subject faces: -Y (default), +Y, -X or +X. Declared, not inferred; a wrong guess inverts every shot. A live run reports that it ignored this.
- **cameraShots** — Headless path only. Explicit shot list overriding the profile's default. The first shot is rendered. A live run reports that it ignored this.
- **frameSubject** — Headless path only. Frame the geometry this run touched (module) or the widened apply set including parents (apply). Defaults to apply; use module for a detail parented to a body. A live run reports that it ignored this.
- **cameraDistance** — Headless path only. Minimum camera distance; a larger subject still fits. Omit to fit the subject. A live run reports that it ignored this.
- **reviewSheet** — Also render the plan's other shots into modules/<name>/review.png and return the panel map. Implies render; the critic still receives one image.
- **direct** — Headless path only. Save model.blend in place instead of writing a branch and applying it, halving the Blender processes for a model no one else is editing. Other staged branches are not merged. Default false.
- **forceRender** — Headless path only. Render even when the content fingerprint says the script changed nothing, e.g. after changing a texture on disk. Default false.
- **forcePreflight** — Override a blocking preflight. The default marks the run `blocked`, skips the render and refuses apply; the override renders, applies, and records `preflightOverridden` in the manifest. Use only for a known false positive.
- **referenceId** — Reference id whose image is copied into this generation's comparison sheet (see blender_add_reference). Omit to compare current and previous only.
- **resolution.x** — Render width in pixels.
- **resolution.y** — Render height in pixels.
- **resolution.percentage** — Resolution percentage (default 100).
- **samples** — Sample count override for Cycles renders.
- **timeoutSeconds** — Execution timeout in seconds.

### blender_branch_run

Run a workspace module HEADLESSLY against its own private copy of model.blend (modules/<name>/branch.blend), then stage the result for a later blender_branch_apply. No live Blender session is touched and no bridge lock is taken, so several modules can run at once — the concurrency ceiling is the headless run budget, not the one live session. Reports exactly which objects and materials the script changed, which is what the apply uses to bring back only this module's work instead of reverting its siblings'. A failed run leaves model.blend untouched and there is nothing to revert.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — Module name (lowercase letters, digits, dashes). Resolves to modules/<name>/script.py.
- **render** — Render the BRANCH (not model.blend) to modules/<name>/render.png for critique. Defaults to true.
- **view** — Optional saved view name, camera object name, or "active-camera" to render from. Defaults to the active camera.
- **cameraProfile** — Headless path only: use-case profile selecting the default camera plan: prop, character, hard_surface, interior, print, paint, or asset_pack. Defaults to prop.
- **frontAxis** — Headless path only. Which world axis the subject faces: -Y (default), +Y, -X or +X. Declared, not inferred; a wrong guess inverts every shot.
- **cameraShots** — Headless path only. Explicit shot list overriding the profile's default. The first shot is rendered.
- **frameSubject** — Headless path only. Frame the geometry this run touched (module) or the widened apply set including parents (apply). Defaults to apply; use module for a detail parented to a body.
- **cameraDistance** — Headless path only. Minimum camera distance; a larger subject still fits. Omit to fit the subject.
- **reviewSheet** — Also render the plan's other shots into modules/<name>/review.png and return the panel map. Implies render; the critic still receives one image.
- **forceRender** — Headless path only. Render even when the content fingerprint says the script changed nothing, e.g. after changing a texture on disk. Default false.
- **forcePreflight** — Override a blocking preflight. The default marks the run `blocked`, skips the render and refuses apply; the override renders, applies, and records `preflightOverridden` in the manifest. Use only for a known false positive.
- **referenceId** — Reference id whose image is copied into this generation's comparison sheet (see blender_add_reference). Omit to compare current and previous only.
- **resolution.x** — Render width in pixels.
- **resolution.y** — Render height in pixels.
- **resolution.percentage** — Resolution percentage (default 100).
- **samples** — Sample count override for Cycles renders.
- **timeoutSeconds** — Execution timeout in seconds.

### blender_branch_apply
- **forcePreflight** — Override a blocking preflight. The default marks the run `blocked`, skips the render and refuses apply; the override renders, applies, and records `preflightOverridden` in the manifest. Use only for a known false positive.

Apply staged branch runs into model.blend in one locked pass, in the order their branch runs were staged. The whole batch is pre-flighted first, merged by one headless Blender process and saved once, so concurrent module runs cannot interleave through a half-applied fan-out. A module whose datablocks are contested by another STAGED branch is REPORTED AND SKIPPED, never auto-merged: its changes stay in its own branch blend and the apply says which modules and which object conflicted, because silently picking a winner is how a half-built asset gets presented as finished. A branch whose blend is missing from disk is reported in `missing` and does not stop the rest of the batch. Each successful apply is recorded as a module run, so blender_module_revert can restore the state it replaced.

- **workspace** — Explicit workspace path for the Blender task.
- **modules** — Module names to apply, in any order — they are applied in the order their branch runs were staged. Every one must have a staged branch run.
- **timeoutSeconds** — Timeout for the whole apply batch in seconds.

### blender_module_revert

Revert model.blend to a module's recorded pre-run checkpoint and reload it in the live Blender session. Uses the manifest's moduleRuns history, so it reverts the exact state before that run. Refuses when later module runs also modified the blend (pass force: true to accept discarding them). The reload DISCARDS any unsaved changes currently open in the live Blender UI, so save unrelated work in the UI before reverting.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — Module name to revert.
- **iteration** — Revert this specific recorded run instead of the module's latest one.
- **force** — Allow the revert even though later module runs also mutated the blend.

### blender_log_critique

Append a structured critique entry to the workspace critique.log using the 0-12 Blender iteration rubric: five 0-2 craft axes plus a 0-2 category-validity axis, a 0-2 view adequacy that gates whether the judgement counts at all, and an optional rejectReason. Resolves a verdict (continue / present / reject) and records it, so blender_rank_assets can select across a batch without re-reading prose.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — The module this critique judged. Names the part the render shows, and keeps each module's 5-iteration budget its own rather than shared across a fan-out.
- **iteration** — Optional iteration number, for a run whose number differs from the workspace's latest. Omit it and the latest is used.
- **accuracy** — Accuracy score from 0 to 2.
- **geometry** — Geometry and proportions score from 0 to 2.
- **materials** — Materials and appearance score from 0 to 2.
- **completeness** — Completeness score from 0 to 2.
- **quality** — Quality score from 0 to 2.
- **validity** — Is this a valid instance of the CATEGORY at all -- does it read as a mug, not as a well-formed object carrying a brief's worth of mug features? Separate from accuracy, which asks whether it matches its brief. Zero means the category is not satisfied, and no amount of polish recovers that.
- **viewAdequacy** — Can the asset be judged FROM this render? 2 = the whole subject and its silhouette are visible, 1 = partly occluded or ambiguous, 0 = the render does not show the subject. Scored because it gates the JUDGEMENT, not the asset: an ugly render of a good mesh is still a good sample, but a render that cannot show the object makes every other score meaningless, so an unusable view never presents.
- **viewNote** — Free text on the framing, coverage, or perspective, kept because the score cannot say why.
- **issues** — Concrete problems found in the current render or scene.
- **nextAction** — Either a fix to attempt next, or "present to user" when the result is good enough.
- **rejectReason** — Reject the asset outright, whatever it scored. Use this when the ATTEMPT was wrong -- the category is unsatisfiable from this brief, or the structure is fundamentally not what was asked for -- rather than merely unpolished. Distinct from a low score on purpose: a scored failure is a finished attempt worth keeping the record of, and this says it should never have been made.

### blender_iteration_state

What this module's iteration loop already knows, derived from the manifest and critique.log rather than from anyone's memory. Read it BEFORE spending a run or a fresh critic: it reports the per-module iteration budget, the last run and its content digest, the last verdict with its six axis scores, blocking subset, issues and next action, whether the last briefed fix actually changed the content, the probe facts already recorded, and a waste guard that names the specific condition under which another render would tell you nothing new. A loop that has lost its budget to a context fold is a loop that runs forever; this is where the budget lives. Read-only.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — The module to report on. One model's history cannot be summarised for all of them, and the budget, digest and waste guard are all per-module.

### blender_record_iteration_fact

Persist one MEASURED fact about this module so it survives the critic that measured it, a context fold, and a crash. A fact without a record is re-measured by every fresh critic, which is how a loop spends three renders learning that the handle is the wrong thickness. Record what the probe actually returned and the tool that returned it, so the next critic can re-check the number rather than trusting a sentence. Re-recording the same statement updates it rather than duplicating it; the newest 24 facts per module are kept. Read blender_iteration_state to see what is already known before measuring anything.

- **workspace** — Explicit workspace path for the Blender task.
- **moduleName** — The module the fact is about.
- **statement** — The measured finding itself, as a checkable sentence: "The handle is 12mm across, under the 18mm a hand needs". Not "the handle looks thin" -- that is a judgement, and the critic makes those.
- **source** — Which tool produced it, with the identifying detail: "blender_geometry_probe, Mug vs MugHandle pair distance", "blender_image_probe, modules/mug/render.png". A fact with no source is an assertion.
- **iteration** — The run the measurement belongs to. Defaults to nothing; supply it when the fact came from a specific run.

### blender_job_status

Check the state, execution progress, and result of a deferred background Blender job (such as a long render, montage, or compare dispatched with async: true). Reports state ('running', 'completed', 'failed' or 'cancelled') along with timestamps and full result payload, failure error or cancellation reason.

- **jobId** — The unique job identifier returned when the deferred job was dispatched.

### blender_workspace_prune

Report or remove old iteration renders that no module's newest render and no current critique depends on. With includeCheckpoints/includeBranches it also reports old whole-file checkpoints over the global budget and applied branch copies, each with exact files and bytes. Dry run by default: nothing is deleted until `dryRun: false`. Copied references are counted and never deleted, because nothing here can prove one is unused. The newest AND previous checkpoint of every module are always kept: compare and revert both need them. This runs outside the module loop on purpose: a run must not delete the evidence a critic is reading.

- **workspace** — Explicit workspace path.
- **dryRun** — Report what would be removed without deleting anything. Defaults to true.
- **keepIterations** — How many of the newest iterations to keep. Default 2, minimum 1.
- **includeCheckpoints** — Also plan old run checkpoints over the global budget, keeping each module's newest and previous generation.
- **includeBranches** — Also plan applied branch copies whose checkpoint is the revert subject.

### blender_job_cancel

Cancel a deferred Blender job that is still running (render, montage or compare dispatched with async: true). The job is recorded as cancelled with the reason and its work is aborted when this process started it: a local process is stopped, and a queued live-viewport request is withdrawn best effort. A request the live UI already picked up cannot be interrupted. A completed or failed job is reported as such; cancelling an already-cancelled job returns its record.

- **jobId** — The unique job identifier returned when the deferred job was dispatched.
- **reason** — Why the job is being cancelled, stored on the record so a later reader knows this was a decision, not a crash.

### blender_build_status

Read the build contract's current stage and history. The stage advances only when the extension observes the work: a branch run stages, a batch apply merges, a logged critique critiques, and the finalizer advances to finalized with evidence. Export refuses a build that never reached finalized unless allowUnfinalized is passed.

- **workspace** — Explicit workspace path for the Blender task.

### blender_build_advance

Advance the build contract to a stage the extension cannot observe by itself, with evidence. The finalizer uses it to move a merged, critiqued build to finalized; intake/planned may be recorded by the manager. A second finalize is a duplicate record rather than a second build; the export gate still refuses an unfinalized export.

- **workspace** — Explicit workspace path for the Blender task.
- **stage** — Stage to record. Normally finalized.
- **evidence** — What was checked or produced for this stage.
- **actor** — Who performed it. Defaults to blender-manager.
