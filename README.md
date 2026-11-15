# pi-blender

Pi extension for the live-Blender 3D modeling workflow (scene state,
vision-informed iteration, render loop) in stock pi, with fixes for a
**flatpak** Blender install. Extracted from [BlenderAgent](https://github.com/veoery/BlenderAgent) 0.1.2 (MIT).

## Tools

Registered tools (`blender_*`, 39). Usage detail, per-tool notes and the
verified-history log live in [docs/DESIGN.md](docs/DESIGN.md).

| Tool | What it does |
|---|---|
| `blender_workspace_init` | create a workspace blend (`template: "studio"` rig by default) |
| `blender_build_status` | build stage, history and the stages that may follow |
| `blender_build_advance` | record a stage the extension cannot observe (finalizer → finalized) with evidence |
| `blender_workspace_prune` | report/remove old renders, checkpoints and applied branches; dry run by default, references and newest checkpoints kept |
| `blender_execute_python` | run bpy Python in live Blender, optionally saving |
| `blender_read_only_python` | inline read-only Python that cannot touch the file |
| `blender_session_context` | current workspace, mode, selection, last render |
| `blender_scene_info` | scene inventory (extra categories: uv, armatures, textures, paintSettings, object_detail, missingFiles, linkedLibraries) |
| `blender_geometry_probe` | shape/clearance/path/joint/topology checks, read-only |
| `blender_image_probe` | sample a rendered PNG on disk (mean brightness, color stats) |
| `blender_montage` | render several preset orbit angles of one subject |
| `blender_compare` | render previous generation beside current for A/B judging |
| `blender_add_reference` | attach a local or downloaded reference image, with provenance |
| `blender_reference_search` | search CC0 catalogues (Poly Haven, ambientCG) for references |
| `blender_save_view` | save a named camera view |
| `blender_render` | render (live material-preview or background engine) |
| `blender_set_mode` | switch live viewport mode (OBJECT, POSE, EDIT_MESH, …) |
| `blender_log_critique` | append a scored critique to `critique.log` |
| `blender_iteration_state` | derive a module's iteration state from its manifest |
| `blender_record_iteration_fact` | persist one measured fact per call |
| `blender_module_run` | run one module's script against a branch copy |
| `blender_module_revert` | undo a module run's merge |
| `blender_branch_run` | run a script against a branch copy without merging |
| `blender_branch_apply` | merge a branch run's result into the workspace |
| `blender_rank_assets` | rank a workspace's renders by critique score |
| `blender_export_asset` | export an asset to glTF/GLB/OBJ/STL |
| `blender_bridge_status` | bridge alive/busy/pending, headless-run count |
| `blender_focus_view` | frame a named object in the live viewport (window-only) |
| `blender_window_layout` | read the live window/area layout and screenshot |
| `blender_switch_workspace` | switch the live Blender window to another workspace |
| `blender_import_asset` | import a model file into the workspace blend |
| `blender_blockout_generate` | import a generated blockout (local GLB/OBJ or ComfyUI) as a starting point |
| `blender_object_detail` | per-object mesh, modifier and material detail |
| `blender_get_python_api_docs` | look up a bpy symbol in the bundled API docs |
| `blender_search_api_docs` | search the bundled bpy API docs |
| `blender_search_manual_docs` | search the bundled Blender manual |
| `blender_usage_guess` | guess what a saved blend is for (animation/rendering/shading/procedural/modelling scores) |
| `blender_job_status` | poll a deferred render/montage/compare job |
| `blender_job_cancel` | cancel a running deferred render/montage/compare job (idempotent) |

The `/blender` command engages manager mode over these tools; child agents
(`blender-worker`, `blender-critic`, `blender-reference-describer`,
`blender-script-runner`) do the tool-level work.

## Install

```bash
pi install npm:@luxuride-pi/blender
```

### The Blender-side package comes separately

The Python this extension loads into Blender is its own package,
[`@luxuride-pi/blender-bridge`](https://github.com/luxuride-pi-extensions/pi-blender-bridge)
(GPL-3.0-or-later — [why](LICENSING.md)), and it has to be on disk before the
first `blender_*` tool call:

```bash
# beside the extension, which is the second place the resolver looks
git clone --depth 1 https://github.com/luxuride-pi-extensions/pi-blender-bridge \
  ~/.pi/agent/extensions/pi-blender-bridge
```

Resolution order is `node_modules` (if you installed the package yourself),
then a sibling checkout, then `~/.pi/agent/extensions/{blender-bridge,pi-blender-bridge}`;
`PI_BLENDER_BRIDGE_ASSETS_DIR=/path/to/package` overrides all of it and is
authoritative — a wrong path is an error, not a silent fallback.

It is not an npm dependency on purpose: npm 12 refuses to fetch anything that is
not a registry artifact (`allow-git` and `allow-remote` default to `none`), so a
git or tarball spec would make `npm ci`/`npm install` fail for every consumer
rather than fetch the package. Rather than force every user to change npm
policy, the two packages stay installable separately.

The child agents above must also exist in `$PI_AGENT_DIR/agents`. The
extension ships its agent templates, so install them once from the installed
copy:

```bash
node scripts/install-agents.mjs            # dry run: print resolved paths
node scripts/install-agents.mjs --write    # install into $PI_AGENT_DIR/agents
```

### Requirements & Version Floor

- **Node.js**: `>= 22.0.0`
- **Blender**: `>= 4.2.0` (Blender 4.2 LTS or later)

Blender 4.2 LTS is the version floor. The extension relies on modern Blender APIs including the EEVEE-Next engine and modern geometry export operators (`bpy.ops.wm.obj_export`, `bpy.ops.wm.stl_export`). Earlier Blender releases (such as 3.x or 4.0/4.1) lack these APIs and are rejected with an explicit, actionable error message.

Blender is autodetected in the following order:
1. `$BLENDER_PATH` environment variable (e.g. `BLENDER_PATH="flatpak run --command=blender org.blender.Blender"` or `/opt/blender/blender`)
2. macOS application bundle (`/Applications/Blender.app/Contents/MacOS/Blender`)
3. Flatpak (`org.blender.Blender` via `flatpak info`)
4. System `PATH` (`blender`)

If Blender is missing or below version 4.2.0, the extension fails fast with actionable upgrade instructions.

### Subagent activation

Manager sessions delegate through pi's `subagent` tool. A session on a model that
can add tools mid-conversation starts with only `subagents_enable` active, and
the manager calls it once before the first spawn; every other session has
`subagent` from the start and never touches the loader. To keep `subagent`
always active, set `"toolActivation": "eager"` in
`~/.pi/agent/extensions/subagent/config.json`, or start pi with
`--exclude-tools subagents_enable`.

Usage, workspace semantics, environment variables and per-tool behaviour:
[docs/DESIGN.md](docs/DESIGN.md).

## Releases

Every release is both a **git tag** and an npm package. The package publishes
as `@luxuride-pi/blender` from the release workflow via npm trusted publishing
(OIDC from GitHub Actions — no publish token exists anywhere).

pi can also install this extension from a **git ref**: pi clones, checks out
the ref, runs `npm install --legacy-peer-deps`, and loads the extension's
TypeScript straight from source — so a tag *is* the artifact; there is no
build step and nothing to compile.

### Install a release

```bash
pi install npm:@luxuride-pi/blender@^<version>
# or, pinned to a git tag:
pi install git:github.com/luxuride-pi-extensions/pi-blender@v<version>
```

### Cut a release

1. Bump `version` in `package.json` and commit that on its own.
2. Tag the commit that contains the bump — the tag and the version must agree:
   ```bash
   git tag v<version> && git push origin master --tags
   ```
3. `.github/workflows/release.yml` packs the tarball, checks it, and publishes
   the release with generated notes.

The workflow refuses to guess: it fails when the tag is not on the commit being
released, and again when the tag does not match `package.json`'s `version`.
Bump the version *before* tagging; the tag is not the place to bump.

## License

[MIT](LICENSE) — the extension: the TypeScript, the tool surface, the skills and
the agent prompts.

Its Python half is **not** MIT and is not in this package. `live-bridge.py`, the
headless run scripts and everything else that imports `bpy` live in
[@luxuride-pi/blender-bridge](https://github.com/luxuride-pi-extensions/pi-blender-bridge),
which is GPL-3.0-or-later because Blender's own license requires it — see
[LICENSING.md](LICENSING.md) for the reasoning and the citations.

Two directories are **not** ours and are **not** MIT: `docs/reference/api/` is
GPL-3.0-or-later (Blender's source docstrings) and `docs/reference/manual/` is
CC BY-SA 4.0 (the Blender Manual). They ship because the agent cites them at
runtime — see [docs/reference/NOTICE](docs/reference/NOTICE).
