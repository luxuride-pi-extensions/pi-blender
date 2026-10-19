# pi-blender

Pi extension for the live-Blender 3D modeling workflow (scene state,
vision-informed iteration, render loop) in stock pi, with fixes for a
**flatpak** Blender install. Extracted from [BlenderAgent](https://github.com/veoery/BlenderAgent) 0.1.2 (MIT).

## Tools

Registered tools (`blender_*`, 23). Usage detail, per-tool notes and the
verified-history log live in [docs/DESIGN.md](docs/DESIGN.md).

| Tool | What it does |
|---|---|
| `blender_workspace_init` | create a workspace blend (`template: "studio"` rig by default) |
| `blender_execute_python` | run bpy Python in live Blender, optionally saving |
| `blender_read_only_python` | inline read-only Python that cannot touch the file |
| `blender_session_context` | current workspace, mode, selection, last render |
| `blender_scene_info` | scene inventory (extra categories: uv, armatures, textures, paintSettings) |
| `blender_geometry_probe` | shape/clearance/path/joint/topology checks, read-only |
| `blender_image_probe` | sample a rendered PNG on disk (mean brightness, color stats) |
| `blender_montage` | render several preset orbit angles of one subject |
| `blender_compare` | render previous generation beside current for A/B judging |
| `blender_add_reference` | attach a reference image for modelling |
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
| `blender_export_asset` | export an asset to glTF/GLB/FBX/OBJ |
| `blender_bridge_status` | bridge alive/busy/pending, headless-run count |

The `/blender` command engages manager mode over these tools; child agents
(`blender-worker`, `blender-critic`, `blender-reference-describer`,
`blender-script-runner`) do the tool-level work.

## Install

```bash
pi install npm:@luxuride-pi/blender
```

The child agents above must also exist in `$PI_AGENT_DIR/agents`. The
extension ships its agent templates, so install them once from the installed
copy:

```bash
node scripts/install-agents.mjs            # dry run: print resolved paths
node scripts/install-agents.mjs --write    # install into $PI_AGENT_DIR/agents
```

Blender itself is autodetected (`BLENDER_PATH`, macOS app bundle, flatpak,
`PATH`). Set `BLENDER_PATH` if yours lives elsewhere.

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

[GPL-3.0-or-later](LICENSE)
