# Safety, Boundaries, and Tool Annotations

This document describes the safety model, execution boundaries, and MCP tool annotations across all 23 `blender_*` tools in `pi-blender`.

## Tool Annotations

`pi-blender` tools declare MCP-style tool annotations (`ToolAnnotations`):
- `readOnlyHint`: whether the tool performs only read operations without altering scene data or writing new workspace files.
- `destructiveHint`: whether the tool mutates state destructively (e.g. overwriting/modifying `model.blend`, applying branches, or reverting checkpoints).
- `idempotentHint`: whether repeated calls with identical arguments leave system state unchanged.
- `openWorldHint`: local definition: `true` if the tool interacts with the live Blender process or external environment; `false` for workspace-file-only operations.

### Local Definition of openWorldHint

In `pi-blender`:
- **`openWorldHint: true`**: The tool interacts with an open-ended external runtime: either the live interactive Blender process (via the live bridge socket/polling mechanism), the active viewport, or host machine processes.
- **`openWorldHint: false`**: The tool performs workspace-file-only operations (reading or writing workspace manifests, disk-based `.blend` checkpoints, references, or critique logs headlessly).

---

## Disposition of blender_read_only_python

`blender_read_only_python` is annotated with:
```typescript
annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
}
```

### Rationale

1. **Why `readOnlyHint: false`**:
   The live bridge intercepts mutating `bpy` operations through an in-process denylist (blocking `bpy.ops`, object vector/matrix modifications, datablock removals, collections linking/unlinking, and `save_as_mainfile`). However, `blender_read_only_python` runs arbitrary Python bytecode in the Blender environment. Python scripts retain access to built-in modules (`os`, `sys`, `pathlib`, `open`, etc.) and can read or mutate the host filesystem or communicate over networks.
   Annotating `blender_read_only_python` as `readOnlyHint: true` would falsely assure client permission gates and CI security policies that execution has no side effects. The honest disposition is `readOnlyHint: false`.

2. **Why `destructiveHint: false`**:
   Within the Blender scene graph itself, mutating `bpy` operations are refused by the bridge with `refused: true`. It does not overwrite `model.blend` or discard scene state.

---

## Complete Tool Annotations Matrix

| Tool Name | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Notes |
|:---|:---:|:---:|:---:|:---:|:---|
| `blender_workspace_init` | `false` | `false` | `true` | `true` | Initializes workspace files; auto-opens in live Blender session. |
| `blender_execute_python` | `false` | `true` | `false` | `true` | Mutates scene in live Blender session and updates `model.blend`. |
| `blender_session_context` | `true` | `false` | `true` | `true` | Reads live UI state (selection, mode, open blend). |
| `blender_scene_info` | `true` | `false` | `true` | `false` | Reads saved `model.blend` on disk headlessly; workspace-file-only. |
| `blender_save_view` | `false` | `false` | `true` | `true` | Captures viewport/camera view and writes to manifest. |
| `blender_render` | `false` | `false` | `false` | `true` | Renders viewport or background; writes render image files. |
| `blender_module_run` | `false` | `true` | `false` | `true` | Mutates workspace module and `model.blend` in live/headless Blender. |
| `blender_branch_run` | `false` | `true` | `false` | `false` | Headless execution against isolated private `branch.blend`; workspace-file-only. |
| `blender_branch_apply` | `false` | `true` | `false` | `true` | Merges staged branch into `model.blend` and reloads live UI. |
| `blender_module_revert` | `false` | `true` | `false` | `true` | Reverts `model.blend` checkpoint and reloads live UI, discarding unsaved edits. |
| `blender_set_mode` | `false` | `false` | `true` | `true` | Switches viewport mode (OBJECT, EDIT, SCULPT, etc.) in live UI. |
| `blender_log_critique` | `false` | `false` | `false` | `false` | Appends critique entry to `critique.log`; workspace-file-only. |
| `blender_rank_assets` | `true` | `false` | `true` | `false` | Reads and ranks `critique.log`; workspace-file-only. |
| `blender_iteration_state` | `true` | `false` | `true` | `false` | Queries manifest and critique history; workspace-file-only. |
| `blender_record_iteration_fact` | `false` | `false` | `true` | `false` | Records measured fact in manifest; workspace-file-only. |
| `blender_export_asset` | `true` | `false` | `false` | `false` | Headless export to glb/gltf/obj/stl; read-only w.r.t `model.blend`. |
| `blender_add_reference` | `false` | `false` | `false` | `false` | Copies reference image to workspace directory and updates manifest. |
| `blender_bridge_status` | `true` | `false` | `true` | `true` | Inspects live Blender bridge and process status. |
| `blender_geometry_probe` | `true` | `false` | `true` | `true` | Non-mutating BVH geometric measurements; queries live session when open. |
| `blender_image_probe` | `true` | `false` | `true` | `false` | Pixel measurements on rendered PNG; workspace-file-only. |
| `blender_read_only_python` | `false` | `false` | `false` | `true` | Guards `bpy` in live scene, but has un-sandboxed filesystem access. |
| `blender_montage` | `false` | `false` | `false` | `true` | Multi-angle orbit/interior renders tiled to disk; interacts with live session. |
| `blender_compare` | `false` | `false` | `false` | `true` | Side-by-side generational comparison renders; interacts with live session. |
