---
name: blender-live-state
description: The single source of truth for using the live Blender UI state (selection, active object, viewport, camera) in this workspace. Read before acting on "it", "this", the selected object, or the current view.
---

# Blender Live State

The live Blender UI is **one shared, mutable session**. Every `blender_*` tool call runs against it, in whatever state the user left it. These rules are the only live-state rules — other blender skills reference this file instead of repeating them.

## 1. One authoritative block per turn

Before an engaged turn, pi injects an **"Authoritative live Blender state"** block (Blend / Scene / Target / Viewport lines).

- If that block is present, it is the **only** current truth for present-tense UI state (selection, active object, viewport, camera, shading).
- Ignore older injected blocks in message history, earlier mentions of a selection, and your own earlier inferences. They describe the past, not now.
- If Blender changes *during* the turn (you switched mode, moved the camera, ran a module), the block is stale: call `blender_session_context` again before reasoning about "it".

## 2. When the block is missing or insufficient

The block can be absent (bridge busy or Blender not running) or too vague. If the block is **missing**, it says so explicitly: a paragraph starting `Live Blender state is UNAVAILABLE for this turn`. In that case:

- Assume **nothing** about selection, active object, viewport, or camera.
- Call `blender_session_context` before mutating.
- If that also fails, ask the user instead of guessing.
- If the state is available but the request is still ambiguous (several objects selected, no active object), state which target you resolved before mutating it.

Do not call `blender_session_context` when the authoritative block already resolves the target clearly — it costs a bridge round-trip and the live UI can only serve one request at a time.

## 3. One request at a time

The bridge serializes all requests through a lock. Two concurrent mutating calls do not "merge" — they interleave in one session and can corrupt state.

- Never run two module runs, or a module run and a render, concurrently.
- If a bridge call times out or reports a lock, call `blender_bridge_status` before retrying: it reports whether the UI is running, whether another request holds the slot, and how many requests are pending.
- A cold start (Blender not running) can take up to ~120 s. That is not a hang.

## 4. Live state vs the saved file: they are different tools, not different calls to one

This is the single most expensive confusion in this workspace, so it is worth stating as a rule rather than a preference.

| question | tool | why |
| --- | --- | --- |
| "what is selected", "update it", "what does Blender show now", "is my unsaved change there" | `blender_session_context` | reads the live UI |
| "what objects exist", "what materials are assigned", "what is the render resolution" | `blender_scene_info` | reads the last SAVED `model.blend`, in a separate background Blender |

`blender_scene_info` spawns a headless Blender on the workspace blend **as it was last written to disk**. It cannot see:

- a worker's edits that are still running,
- a change you just made in the UI but did not save,
- anything at all in a different blend than `model.blend`.

So "the scene info says the object is at the origin" and "I just moved it" are both true, and the second is newer. Asserting live state from scene info is not a close call — it is answering about a file that is one save behind.

The corollary when something looks wrong: check which tool you used before you check whether the model is wrong. If the question was about live state, re-read with `blender_session_context`; the numbers from `blender_scene_info` may be correct for the file and irrelevant to the screen.

## 5. Camera and view etiquette

- Treat user-created views/cameras as locked unless the user asks you to change them.
- For evaluation, create agent-owned views (`agent_eval_main`, `agent_eval_wide`, `agent_eval_detail`) and update them across iterations.
- Treat render perspective as part of the task: if framing hides the thing being judged, fix the view before judging the model.

## Tool semantics moved out of the schemas

The tool and parameter descriptions below are the full text that used to live in
`core/tools.ts`. The schema keeps each first sentence for tool selection; load
this skill when you need the precedence rules, failure modes and definitions.

### blender_execute_python

Copy a Blender Python script into a run directory, execute it inside the live bridge-enabled Blender session for the workspace, and persist the updated model.blend so the UI stays in sync. By default the run claims a numbered iteration slot; pass claimIteration=false for throwaway runs so it does not count as progress.

- **workspace** — Explicit workspace path for the Blender task.
- **script_path** — Path to the existing Blender Python script to snapshot and execute. Use the workspace root script.py.
- **saveBefore** — If true, copy the current model.blend into the iteration folder before execution.
- **saveAfter** — If true, save the updated Blender scene back to model.blend after execution.
- **claimIteration** — If false, run without claiming a numbered iteration_NN slot — the copied script and log still go to a private runs/ad-hoc/<id>/ directory, so nothing clobbers, but the run does not advance latestIteration. Use false for throwaway work such as a camera nudge or a one-off inspection, and true (the default) for a change you would describe as progress. Claiming every ad-hoc run makes the iteration numbers in critique.log stop corresponding to anything readable.
- **timeoutSeconds** — Execution timeout in seconds.
- **label** — Optional label for the iteration step.

### blender_session_context

Read the LIVE Blender session: the open blend path, active scene, current mode, active object, selected objects, viewport state, unsaved changes, and whether another pi session holds the same blend. This is the only source of truth for present-tense Blender state — for 'what is selected', 'update it', 'render from what I'm looking at', or any claim about what Blender currently shows. `blender_scene_info` is NOT that: it reads the last SAVED blend file, so it never sees a worker's in-flight edits or a change made by hand and not saved. Call it before mutating anything. Read-only by construction (see docs/SAFETY.md for full guarantee boundary).

- **workspace** — Optional workspace path to compare against the live Blender session. Relative paths resolve from the current working directory.
- **include** — Optional live session categories to include. Omit to return the full live Blender session context.

### blender_window_layout

Read the live Blender UI window layout, screens, areas, space types, active object, and selection as JSON (zero image token cost), or capture a byte-capped screenshot downscaled with system pixel_size awareness. Any screenshot capture is byte-capped at 500 KB (512,000 bytes) and downscaled honoring context.preferences.system.pixel_size. Window-only: reports layout: null and captured: false with a reason instead of failing when no watch window is open.

- **workspace** — Optional workspace path for the Blender task. Relative paths resolve from the current working directory.
- **format** — Output format: 'json' for zero-cost layout description (default), or 'image' for a byte-capped screenshot.
- **screenshot** — Whether to capture a screenshot (default false). When true, downscales and byte-caps the image at 500 KB.
- **as_image** — Alias for screenshot: true.
- **as_json** — Return layout and selection as JSON only, asserting no image payload (default true).
- **area_type** — Optional Blender area type to screenshot (e.g. 'VIEW_3D', 'OUTLINER', 'PROPERTIES'). If omitted or 'window', captures the entire window.
- **max_bytes** — Maximum file size in bytes for the downscaled screenshot (default 512,000 = 500 KB).
- **output_path** — Optional file path where the screenshot PNG will be written.

### blender_save_view

Save a named render view in the workspace manifest. With source=active-camera, capture the current live Blender UI viewport into a dedicated camera object; otherwise bind the view to an existing camera object. source=active-camera photographs what the UI currently shows, including unsaved edits, so with no window open it reports savedView:null with a reason rather than failing — binding the view to a camera name works headlessly and is the right source when there is no window. Nothing is written to the manifest when the capture is skipped, so a later render cannot pick up a view bound to a camera that was never created.

- **workspace** — Explicit workspace path for the Blender task.
- **name** — Saved view name to store in the workspace manifest.
- **source** — Either "active-camera" to capture the current Blender UI view, or a camera object name already present in the scene.
- **camera_name** — Optional dedicated camera object name to use when source is "active-camera". Defaults to the saved view name.

### blender_render

Render the workspace blend file and write outputs into the current iteration. Use renderMethod=`live` for viewport renders and renderMethod=`background` for normal headless scene renders. Live renders default to camera-based framing with viewportShading=`material-preview`; switch to viewSource=`current-view` only when the user explicitly wants the raw current viewport. Live viewport renders disable overlays automatically so grids, axes, and other viewport clutter are not captured. Background renders are camera-based and use renderEngine overrides such as `eevee`, `cycles`, or `workbench` instead of viewport shading modes.

- **workspace** — Explicit workspace path for the Blender task.
- **view** — Optional saved view name, camera name, or "active-camera".
- **samples** — Optional Cycles sample count override.
- **outputName** — Output image file name. Defaults to render.png.
- **renderMethod** — How to execute the render. `live` uses the open Blender UI viewport. `background` uses a headless scene render. Defaults to `live`.
- **viewSource** — How to choose the framing. `camera` uses the saved view, explicit camera, or active camera. `current-view` uses the raw current viewport in the live Blender UI. Defaults to `camera`.
- **viewportShading** — Viewport shading mode for live renders only. Defaults to `material-preview`. `solid` uses Workbench-style viewport shading. `rendered` uses the scene render engine interactively.
- **renderEngine** — Optional render engine override for background renders only. Omit to keep the scene's current engine.
- **async** — If true, dispatch the render as a deferred non-blocking job and return immediately with a job handle ({ jobId, state: 'running' }), releasing bridge.lock.

### blender_set_mode

Switch the live Blender viewport/object mode for a workspace blend, enabling texture paint, vertex/weight/face paint, sculpt, pose, edit-armature, or UV editing. Supported modes: OBJECT, POSE, EDIT_MESH, EDIT_ARMATURE, SCULPT, TEXTURE_PAINT, VERTEX_PAINT, WEIGHT_PAINT, FACE_PAINT, and UV (enters edit mode and turns on the viewport UV editor overlay). Paint modes require a MESH object, POSE/EDIT_ARMATURE require an ARMATURE object. Use this before/after authoring paint or rig changes in script.py so the user sees the correct workspace in the live UI. A viewport mode is a statement about a UI, so with no window open this reports switched:false and a reason instead of failing: the paint is applied as bpy data either way and nothing about the asset depends on this. Authoring does not need a window — blender_module_run and blender_branch_run work headlessly.

- **workspace** — Explicit workspace path for the Blender task.
- **mode** — Target viewport/object mode. UV enters edit mode with the UV editor overlay enabled.
- **objectName** — Optional object to act on. Defaults to the active object. Paint modes need a MESH, POSE/EDIT_ARMATURE need an ARMATURE.

### blender_switch_workspace

Switch the active workspace tab in the live Blender window by workspace name (e.g. 'Layout', 'Modeling', 'Sculpting', 'UV Editing', 'Shading', 'Animation', 'Rendering', 'Compositing', 'Geometry Nodes', 'Scripting') or by contained editor space_type (e.g. 'VIEW_3D', 'NODE_EDITOR', 'IMAGE_EDITOR', 'SEQUENCE_EDITOR'). This changes what editor and layout the user is currently looking at in the live UI. Window-only: this is a statement about the live UI window, so when no /blender-watch window is open this reports switched: false with an explicit reason rather than throwing.

- **workspace** — Explicit workspace path for the Blender task.
- **workspaceName** — Name of workspace tab to switch to (e.g. 'Layout', 'Modeling', 'Shading', 'Geometry Nodes', 'Scripting').
- **spaceType** — Editor space type to switch to (e.g. 'VIEW_3D', 'NODE_EDITOR', 'IMAGE_EDITOR', 'SEQUENCE_EDITOR'). Finds the first workspace containing an area of this type.

### blender_focus_view

Center and frame the 3D viewport on a named object in the live Blender window. Focuses the view on the object's geometry (view_selected). Window-only: this is a statement about the live 3D viewport, so when no /blender-watch window is open this reports moved: false with an explicit reason rather than throwing.

- **workspace** — Explicit workspace path for the Blender task.
- **objectName** — Name of the target object (or object data) to frame and focus in the 3D viewport.

### blender_bridge_status

Check whether the live Blender bridge can serve a request right now: is the UI running, is another request holding the single live-Blender slot, how many requests are pending, how many headless Blender runs may execute concurrently on this machine, and how many are open RIGHT NOW across this session's workers. Use it before a long or mutating batch, or when a bridge call timed out, instead of guessing or burning another timeout. The open count is the one to read mid-fan-out: the budget says what is permitted, not what your workers already spent. A /blender-watch window is reported apart from the runs, because it is not one of them.

- **workspace** — Optional workspace path to report alongside the bridge state.

### blender_read_only_python

Run a Python measurement script in the LIVE Blender scene and get its stdout back, with mutating bpy operations refused by the bridge itself — bpy.ops, bpy.data and bpy.data.<collection> removal (including batch_remove and orphans_purge), linking or unlinking in the scene collection, assigning to an object or its vectors, and saving. It never mutates, saves, or claims an iteration. This exists because a question like 'is the tights the visible surface' is one raycast, and answering it any other way means eyeballing a render. A refusal comes back as `refused: true` naming the operation, which is an answer, not a failure: rewrite the script to ask a question that does not need the change. Print what you measured; the return value is whatever you printed. Two honest limits: this guards bpy, NOT the filesystem, so a read-only script may still read and write files with `os` and `open` — do not use it on anything you would mind losing. And it is a denylist of named entry points rather than a sandbox, so a bpy API this tool does not know about is not refused; see docs/SAFETY.md for the full guarantee boundary. If a measurement needs to change the scene, use blender_execute_python or blender_module_run. Works with no window: the script then runs headlessly against model.blend. With a window open it runs against the live session instead, so it can see unsaved edits.

- **workspace** — Explicit workspace path for the Blender task.
- **script** — The Python to run, as text. Inline rather than a path on purpose: a read-only role has no `write` tool, so a path-only API would make the tool unusable for exactly the role that needs it, and would push it toward asking a worker to author its own evidence.
- **timeoutMs** — Bridge timeout override in ms for the script itself.
