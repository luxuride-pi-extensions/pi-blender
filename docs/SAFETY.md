# Safety, Read-Only Guarantees, and Boundary Model

This document specifies the safety and read-only guarantees in `pi-blender`: what each guarantee layer actually covers, what it does not cover, how recoverability replaces sandboxing on mutating paths, and which measurement pitfalls callers must account for.

Neither an agent nor a server operator should over-trust or under-trust these boundaries:
- **Do not over-trust `blender_read_only_python`**: It is a denylist of named mutating Blender entry points, **not a sandbox**. It guards `bpy` operations; it does **not** guard the filesystem (`os` and `open` remain untouched), and it is not an OS container or security jail.
- **Do not under-trust mutating paths**: `blender_execute_python` and `blender_module_run` are unguarded arbitrary Python execution, but their safety derives from an architectural **recoverability model** (per-run checkpoints, branch isolation, and revert workflows), not from runtime prevention.
- **Do not blindly trust every geometric measurement**: Certain metrics have mathematical limitations (such as `deepestPenetration` on coincident coplanar surfaces) where callers must read designated alternatives (`coincidentSurface`).

---

## The Three Guarantee Layers

```
+-------------------------------------------------------------------------------+
| Layer 1: Runtime Guarded Scripting (blender_read_only_python)                 |
| - Patches bpy in Blender process (denylist of ops, collection removal, saves) |
| - Refusals return structured { refused: true, ... }                           |
| - Filesystem is UNGUARDED (os, open untouched)                                |
+-------------------------------------------------------------------------------+
| Layer 2: Read-Only by Construction (probes & context tools)                   |
| - blender_geometry_probe, blender_image_probe,                                |
|   blender_session_context, blender_scene_info                                 |
| - Build BVHs, cast rays, sample PNG buffers, read coordinates; never save     |
+-------------------------------------------------------------------------------+
| Layer 3: Unguarded Authoring Paths (execute & module runs)                    |
| - blender_execute_python, blender_module_run, blender_branch_run              |
| - Plainly UNGUARDED arbitrary Python execution                                |
| - Mitigation is RECOVERABILITY (checkpoints, branches, revert), not prevention|
+-------------------------------------------------------------------------------+
```

### Layer 1: Runtime Guarded Scripting (`blender_read_only_python`)

`blender_read_only_python` runs inline Python scripts against a live or headless Blender instance to compute ad-hoc measurements (e.g. raycasting or querying custom vertex attributes) without authoring permanent scene changes.

#### Enforcement Mechanism
Enforced inside the Blender Python process via `blender/readonly_guard.py` by monkeypatching the objects a script reaches through:
1. **`bpy.ops`**: Mutating operator namespaces (`object`, `mesh`, `curve`, `armature`, `transform`, `outliner`, etc.) are intercepted with proxy callables that raise `ReadOnlyViolation`.
2. **Window Manager Save & Quit Ops**: `bpy.ops.wm.save_mainfile`, `save_as_mainfile`, `save_homefile`, `recover`, `open_mainfile`, and `read_homefile` are blocked.
3. **`bpy.data` and Data Collections**:
   - `batch_remove` and `orphans_purge` on `bpy.data` are refused.
   - Mutating collection attributes (`new`, `remove`, `pop`, `clear`, `batch_remove`, `orphan_purge`, `foreach_set`) on `bpy.data.<collection>` (objects, meshes, materials, collections, scenes, etc.) are blocked.
4. **Vector & Transform Mutation**: `_GuardedVector` wraps mathutils vector, matrix, quaternion, and euler properties so assignments like `obj.location.x = 5`, `obj.rotation_euler.z += 1`, or in-place calls like `vec.normalize()` raise `ReadOnlyViolation` instead of silently updating an in-memory copy.
5. **Scene Linking**: Unlinking or linking objects to collections is blocked.

When a violation occurs, the bridge catches `ReadOnlyViolation` and returns:
```json
{
  "refused": true,
  "stdout": "REFUSED: the script asked for an operation that would change the scene.\n..."
}
```
This is treated as structured feedback ("your measurement required a change"), not an unhandled crash.

#### Honest Boundaries and Limitations
- **Denylist, Not a Sandbox**: The guard operates on a denylist of known mutating entry points. Blender's C/Python API surface is vast. Any unlisted internal attribute or API added in future Blender releases may bypass the guard.
- **Filesystem is NOT Guarded**: The standard Python library is untouched. `os`, `sys`, `pathlib`, `shutil`, and `open()` are completely unrestricted. A script run via `blender_read_only_python` can read, create, modify, or delete files on disk accessible to the process.
- **Not a Multi-Tenant Security Boundary**: Server operators must never execute untrusted user code through `blender_read_only_python` assuming process isolation. True security isolation requires OS-level sandboxing (Flatpak sandbox, Docker container, or namespaces).

---

### Layer 2: Read-Only by Construction Probes & Context Inspection

The inspection tools are read-only by design and construction:
- `blender_geometry_probe`: Measures bounds, principal axes, surface gaps, clearances, and topology. It builds temporary BVH trees and raycasts in memory, samples floor rasters, and inspects coordinates. It never adds objects, mutates geometry, or saves `.blend` files.
- `blender_image_probe`: Decodes and analyzes PNG files in pure Node.js. It does not interact with Blender at all.
- `blender_session_context`: Queries live Blender state via read-only property inspection (active file, scene, mode, selection, viewport) through the bridge.
- `blender_scene_info`: Reads saved `.blend` metadata on disk or structural data from the live bridge without modifying scene data.

#### Guarantees
- These tools never mutate scene geometry or project files.
- They claim no iteration numbers in the workspace manifest.
- They are safe to call concurrently with in-flight worker scripts or while a human editor has unsaved changes in the GUI.

---

### Layer 3: Unguarded Authoring Paths and Recoverability

Authoring tools (`blender_execute_python`, `blender_module_run`, `blender_branch_run`, `blender_branch_apply`) are **plainly unguarded arbitrary execution**.

#### Why Prevention is Not Used Here
3D modeling requires comprehensive write access: scripts must create datablocks, assign shaders, build meshes, and save blend files. Imposing runtime restrictions or sandboxing inside Blender would defeat the authoring pipeline.

#### The Mitigation: Recoverability, Not Prevention
Safety on authoring paths is achieved through structured recoverability:
1. **Modular Work Isolation**: Each part or concern is authored in an isolated script (`modules/<name>/script.py`).
2. **Pre-Run Checkpoints**: Every run of `blender_module_run` automatically creates a checkpoint before execution:
   `modules/<name>/runs/<NN>/pre-<NN>.blend`
3. **Automated Rollback**: If a run corrupts the scene, introduces a regression, or fails evaluation, `blender_module_revert` restores the exact pre-run checkpoint. Revert refuses if subsequent module runs have touched the scene unless `force: true` is explicitly passed.
4. **Branch Runs**: `blender_branch_run` runs headless modules against private `branch.blend` copies. Contested datablocks are caught before merging via `blender_branch_apply`.
5. **Cross-Process Serialization & Scene Diffing**: The bridge file lock (`bridge.lock`) serializes live execution. The `blender-script-runner` agent diffs scene datablocks before and after execution to detect cross-module contamination.

---

## Known-Unreliable Measurements and Pitfalls

When using probe tools, callers must be aware of geometric measurement limits where numerical or mathematical properties produce misleading figures.

### 1. `deepestPenetration` vs. `coincidentSurface`
- **The Pitfall**: In `blender_geometry_probe` pair checks, penetration depth is derived from ray parity (number of surface crossings) to determine if points lie inside or outside a closed manifold. When two surfaces are **coplanar or coincident** (e.g. two flat panels touching face-to-face in the same plane), ray parity becomes numerically indeterminate.
- **The False Signal**: Two coincident panels can report an apparent penetration of half a metre (`deepestPenetration: 0.5`) while touching nowhere in depth.
- **What to Read Instead**:
  - Never use `deepestPenetration` to assess coplanar or coincident surfaces.
  - Read **`coincidentSurface`** instead, which directly calculates the ratio and count of vertices lying within 0.1 mm of the opposing surface within the shared bounding box volume.
  - Check the pair verdict (`in-contact` vs `coincident-surface`).

### 2. Clearance and Detour Measurements
- **`path` Detour Ratio**: Snaps door and hallway coordinates to the nearest walkable floor raster cell. Because door centres move slightly off the wall plane to reach walkable samples, straight and detour distances shorten together. Always compare detour ratios **relative to each other**, rather than asserting textbook absolute thresholds.
- **`clearance` Island Count vs. Unreachable Area**: `islandCount > 1` detects free floor split into disconnected segments (e.g. a wall-to-wall sofa). However, a closed ring of obstacles around a corner pocket can leave `islandCount: 1` while trapping space; callers must check `unreachableArea > 0` to detect trapped pockets.

### 3. Topology Split Components (`isSplit` vs. `islandRead`)
- **Assemblies vs. Broken Geometry**: In `topology`, `connectedComponents > 1` (`isSplit: true`) is **not** inherently a defect. Valid assemblies (railings, balusters, multi-part props) are deliberately merged into a single object for export.
- **What to Read Instead**: Do not treat `isSplit` as an automatic defect. Inspect `islandRead` (`assembly` vs `break-candidate` vs `continuous`), `islandFloatingShare` (share of components farther than 5% of their size from neighbors), and `islandContact`.

### 4. Buried Objects in Joint Sweeps
- **Container Scale Filter**: A railing post set 2 mm into a deck or a pier set into the ground is intentionally embedded. A raw boolean or penetration check flags these as defects.
- **What to Read Instead**: The probe evaluates both depth as a multiple of the object's thinnest extent and requires the container to be at least 1.5x larger. Callers should evaluate both figures and let critic agents review flagged assemblies rather than treating embedded counts as fatal errors.

---

## Summary Matrix

| Tool / Path | Layer | Enforcement Mechanism | What It Prevents | What It Does NOT Prevent | Safety Strategy |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `blender_read_only_python` | Layer 1 | In-process Python monkeypatching (`blender/readonly_guard.py`) | Accidental `bpy` scene mutations, datablock deletions, file saves | Filesystem reads/writes (`os`, `open`), unlisted `bpy` APIs | Denylist guard; returns `refused: true`. Not a sandbox. |
| `blender_geometry_probe` | Layer 2 | Read-only by construction | Scene/file mutations, iteration claims | Numerical ray parity limits on coincident planes | Pure measurement; read `coincidentSurface` instead of `deepestPenetration`. |
| `blender_image_probe` | Layer 2 | Read-only by construction | Any Blender modification (runs in Node.js) | Incorrect background parameter choices | Safe analytical tool. |
| `blender_session_context` | Layer 2 | Read-only by construction | Scene/file mutations | Does not prevent human GUI modifications | Truth for present-tense UI state. |
| `blender_scene_info` | Layer 2 | Read-only by construction | Scene/file mutations | Does not see unsaved live UI edits | Truth for saved `.blend` state. |
| `blender_execute_python` | Layer 3 | Unguarded execution | None | Arbitrary script errors, scene changes, filesystem writes | Ad-hoc execution; relies on external backups or git. |
| `blender_module_run` | Layer 3 | Unguarded execution | Concurrent UI races (via `bridge.lock`) | Module bugs, cross-object contamination | Checkpoints (`pre-NN.blend`) and `blender_module_revert`. |
| `blender_branch_run` | Layer 3 | Unguarded execution | Contamination of `model.blend` | Branch-level script bugs | Isolated branch files merged selectively with `blender_branch_apply`. |

---

## MCP Tool Annotations

Every `blender_*` tool declares MCP-style annotations. These are not decoration: a client uses them to decide whether to prompt the user before a call, so a wrong hint is a wrong permission decision.

### The four hints

`pi-blender` tools declare MCP-style tool annotations (`ToolAnnotations`):
- `readOnlyHint`: whether the tool performs only read operations without altering scene data or writing new workspace files.
- `destructiveHint`: whether the tool mutates state destructively (e.g. overwriting/modifying `model.blend`, applying branches, or reverting checkpoints).
- `idempotentHint`: whether repeated calls with identical arguments leave system state unchanged.
- `openWorldHint`: local definition: `true` if the tool interacts with the live Blender process or external environment; `false` for workspace-file-only operations.

#### Local definition of openWorldHint

In `pi-blender`:
- **`openWorldHint: true`**: The tool interacts with an open-ended external runtime: either the live interactive Blender process (via the live bridge socket/polling mechanism), the active viewport, or host machine processes.
- **`openWorldHint: false`**: The tool performs workspace-file-only operations (reading or writing workspace manifests, disk-based `.blend` checkpoints, references, or critique logs headlessly).

---

### Disposition of blender_read_only_python

`blender_read_only_python` is annotated with:
```typescript
annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
}
```

#### Rationale

1. **Why `readOnlyHint: false`**:
   The live bridge intercepts mutating `bpy` operations through an in-process denylist (blocking `bpy.ops`, object vector/matrix modifications, datablock removals, collections linking/unlinking, and `save_as_mainfile`). However, `blender_read_only_python` runs arbitrary Python bytecode in the Blender environment. Python scripts retain access to built-in modules (`os`, `sys`, `pathlib`, `open`, etc.) and can read or mutate the host filesystem or communicate over networks.
   Annotating `blender_read_only_python` as `readOnlyHint: true` would falsely assure client permission gates and CI security policies that execution has no side effects. The honest disposition is `readOnlyHint: false`.

2. **Why `destructiveHint: false`**:
   Within the Blender scene graph itself, mutating `bpy` operations are refused by the bridge with `refused: true`. It does not overwrite `model.blend` or discard scene state.

---

### Complete tool annotations matrix

| Tool Name | readOnlyHint | destructiveHint | idempotentHint | openWorldHint | Notes |
|:---|:---:|:---:|:---:|:---:|:---|
| `blender_workspace_init` | `false` | `false` | `true` | `true` | Initializes workspace files; auto-opens in live Blender session. |
| `blender_execute_python` | `false` | `true` | `false` | `true` | Mutates scene in live Blender session and updates `model.blend`. |
| `blender_session_context` | `true` | `false` | `true` | `true` | Reads live UI state (selection, mode, open blend). |
| `blender_scene_info` | `false` | `false` | `true` | `false` | Reads saved `model.blend` on disk headlessly **and writes `scene-info.json` into the iteration directory**, so it is not read-only. `destructiveHint: false` because it never touches the blend file. |
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
| `blender_export_asset` | `false` | `false` | `false` | `false` | Headless export to glb/gltf/obj/stl. Read-only w.r.t `model.blend`, but it **creates files at a caller-supplied `outputDir`**, which is an unrestricted filesystem write. |
| `blender_add_reference` | `false` | `false` | `false` | `false` | Copies reference image to workspace directory and updates manifest. |
| `blender_bridge_status` | `true` | `false` | `true` | `true` | Inspects live Blender bridge and process status. |
| `blender_geometry_probe` | `false` | `false` | `true` | `true` | Non-mutating BVH measurements, but **writes `geometry-probe.json`** into the iteration directory. `destructiveHint: false` because the scene is untouched. |
| `blender_image_probe` | `false` | `false` | `true` | `false` | Pixel measurements on a rendered PNG; **writes `image-probe.json`** into the iteration directory. |
| `blender_read_only_python` | `false` | `false` | `false` | `true` | Guards `bpy` in live scene, but has un-sandboxed filesystem access. |
| `blender_montage` | `false` | `false` | `false` | `true` | Multi-angle orbit/interior renders tiled to disk; interacts with live session. |
| `blender_compare` | `false` | `false` | `false` | `true` | Side-by-side generational comparison renders; interacts with live session. |
