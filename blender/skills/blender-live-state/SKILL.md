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
