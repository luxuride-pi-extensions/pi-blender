---
name: blender-paint
description: Paint textures, UVs, vertex/weight colors, and pose armatures in a Blender workspace using bpy data plus the correct viewport modes.
---

# Blender Paint

Use this skill when the user wants texture paint, UV painting/UV layout, vertex paint, weight paint, face paint, sculpting, or bone/rig work (pose, edit armature) in a Blender workspace.

Core idea: Blender's paint strokes are interactive UI actions and cannot be driven reliably by scripts. Instead, **apply the paint result as bpy data** (image pixels, UV layer coordinates, vertex color layers, vertex group weights, bone transforms), then **switch the live viewport into the matching paint mode** with `blender_set_mode` so the user sees the correct workspace and can refine by hand.

Workflow:
1. Initialize or reopen the workspace with `blender_workspace_init` and keep `workspace` explicit in every call.
2. Enable delegation once with `subagents_enable` (no arguments), then inspect first with `blender_scene_info` using the relevant categories:
   - `uv` — per-mesh UV layers (name, active, sync, hasData), vertex groups, color attributes.
   - `textures` — every material image node with image name, file path, size, and whether it holds pixel data.
   - `armatures` — bone hierarchy with head/tail positions and `useDeform` flags.
   - `paintSettings` — active object, current mode, active material, its image texture nodes, and color attributes.
3. You are the MANAGER. You do not write bpy code and you do not call `blender_set_mode`. The session's write/edit gate blocks direct authoring by design, so a direct approach is a dead end — delegate first, without waiting to be asked. You keep the step 2 readouts so the brief carries real layer, group, and bone names instead of guesses.
4. Spawn a `blender-worker` for the paint module. It owns `modules/<name>/script.py` and runs it with `blender_module_run`, which saves after execution. Hand it the category readouts above, the target object, the mode, and the measured intent.
5. The worker creates the missing paint data in its module script:
   - **Texture paint**: ensure the material's Image Texture node references a `bpy.data.images.new(...)` image with known `size`; write pixels via `image.pixels` (RGBA, row-major, bottom-to-top) or load/`filepath_raw` + `image.reload()`.
   - **UV paint / UV layout**: edit `mesh.uv_layers.active.data[loop_index].uv` directly; create missing layers with `mesh.uv_layers.new()`. Verify the layer `hasData` after execution.
   - **Vertex paint**: write `mesh.color_attributes` (create with `mesh.color_attributes.new(name, type='FLOAT_COLOR', domain='POINT')`), setting `layer.data[i].color`.
   - **Weight paint**: use `obj.vertex_groups` — `group.add([index], weight, 'REPLACE'|'ADD'|'MULTIPLY')`; inspect existing group names from `blender_scene_info` `uv`/`paintSettings` first.
   - **Bones / rig**: in rest space edit `armature.bones[i].head`/`.tail`; in pose space edit `pose_bones[i].location/.rotation_quaternion` or `pose_bones[i].matrix`. Respect `useDeform` — only deform bones should receive weights.
6. The worker is responsible for setting the live viewport into the paint context with `blender_set_mode`:
   - texture paint → `TEXTURE_PAINT`, vertex paint → `VERTEX_PAINT`, weight paint → `WEIGHT_PAINT`, face paint → `FACE_PAINT`, sculpt → `SCULPT`, UV work → `UV` (enters edit mode with the viewport UV editor overlay on), pose → `POSE`, rig editing → `EDIT_ARMATURE`.
   - Pass `objectName` when the target is not the active object. Paint modes require a MESH; `POSE`/`EDIT_ARMATURE` require an ARMATURE — the tool returns an error otherwise.
   - With no watch window open the call reports `switched: false` and a `reason`. That is not a failure and not a reason to stop: the paint is bpy data and is already applied, so continue to the critic and mention in the report that the viewport was not switched, so the user can open `/blender-watch` and look at it themselves.
7. Spawn a fresh `blender-critic`. It renders with `blender_render` (live, material-preview) to verify: painted textures/vertex colors should be visible on the model; for UV layout, render is optional but for weight paint a quick render or `blender_scene_info` re-check of vertex groups is enough. It then reports and logs its verdict, and you decide whether to stop or issue a follow-up brief (max 5 iterations, exactly like the blender-edit skill): score accuracy/geometry/materials/completeness/quality 0-2 each plus view adequacy. Remember the critic's one-image budget: it gets ONE render and at most ONE reference, so a paint pass that needs several angles costs several fresh critics.

Rules:
- Do not attempt to simulate interactive brush strokes in bpy; only write data.
- Always create or verify the paint target data (image, UV layer, color attribute, vertex group, bone) in the same script run before writing into it.
- Image pixel writes use straight RGBA floats in [0,1]; remember `image.update()` after bulk pixel assignment before saving.
- After UV or texture edits that changed material images, save the image out to the workspace (`image.filepath_raw` under `$workspace` + `image.save()` or `image.save_as()`) when the user needs the file, and note the path in the result.
- Leave the viewport in the paint mode the user asked for (or OBJECT if they did not care) as the final step of the turn.
- When bone work is requested, the worker reports the bone count and any bones that were skipped because `useDeform` is false.
- One module at a time: the paint worker, any other module, and the critic's render all share `model.blend` and one live Blender UI, so run them in sequence.
- Paint is additive and hard to judge from a single angle. If the user says a painted area "looks wrong", suspect the viewpoint before suspecting the pixels, and send it to `blender-camera-aligner`.
