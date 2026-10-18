# pi-blender

Pi extension extracted from [pi-blender](https://github.com/veoery/BlenderAgent) 0.1.2
(MIT) — the pi-blender fork of the pi monorepo. Brings the live-Blender 3D
modeling workflow (scene state, vision-informed iteration, render loop) into
stock pi, with fixes for a **flatpak** Blender install.

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

The released package installs with pi itself:

```bash
pi install npm:@luxuride-pi/blender
```

For development from a clone:

```bash
git clone <this repo's URL>
cd pi-blender
npm install
npm run setup
```

`npm run setup` does everything a fresh clone needs and is safe to re-run:

```
ok     extension symlink — ~/.pi/agent/extensions/pi-blender -> <clone>
ok     typebox resolvable — node_modules/typebox (pi 0.87.1)
ok     agent definitions — 9 in sync in ~/.pi/agent/agents
ok     todo provider for the manager prompt — @juicesharp/rpiv-todo
ok     Blender resolvable — flatpak org.blender.Blender (autodetected)
```

Four things have to be true before the extension works, and all four point
outside the repository — which is why a clone alone is not enough:

- **the symlink** is what pi loads; the repo is never modified
- **`typebox`** is bundled with pi but not installed into third-party
  extensions, so `node_modules/typebox` is a symlink into your pi release
  (gitignored, recreated per machine, resolved by semver so a new release does
  not get skipped by a lexicographic sort)
- **the agent definitions** carry `/path/to/...` placeholders because
  pi-subagents resolves only `.`/`..` entries — no `~`, no env vars
  (`src/agents/agents.js:1802-1813`) — so `install-agents.mjs` substitutes
  machine-specific absolute paths at install time and no such path is ever
  committed
- **`@juicesharp/rpiv-todo`** must be present, because the manager prompt lists
  a `todo` tool and a foreground child does not inherit ambient extensions;
  without the provider listed the child is handed a `todo` it can never call.
  Setup reports this rather than installing it, since it is a separate package
  in your agent npm tree

Blender itself is only *reported*, never required at setup time — resolution
mirrors `launch.ts` (`BLENDER_PATH`, macOS app, flatpak autodetect, `PATH`), so
a machine that configures Blender later is not blocked here.

```bash
npm run check:setup     # read-only: reports problems, repairs nothing, exit 1 on any
```

`--check` is genuinely read-only, including the agent check: it compares the
installed copies against the repo and fails on drift instead of silently
repairing it first. That distinction matters — a check that writes before it
verifies can never report the fault it exists to find.

## Releases

Every release is both a **git tag** and an npm package. The package publishes
as `@luxuride-pi/blender` from the release workflow via npm trusted publishing (OIDC from
GitHub Actions — no publish token exists anywhere).

pi can also install this extension from the **clone**: `installGit()` runs
`git clone`, an optional `git checkout <ref>`, then
`npm install --legacy-peer-deps` inside it, and pi loads the extension's
TypeScript straight from source through jiti. So a tag *is* the artifact for a
git install — there is no build step and nothing to compile.

### Install a release

```bash
pi install npm:@luxuride-pi/blender@^<version>
# or, from the clone:
pi install git:github.com/luxuride-pi-extensions/pi-blender@v<version>
```

The `@ref` is what pins the version; without it pi tracks the default branch, so
an unpinned spec is not a release, it is a moving target.

### Cut a release

1. Bump `version` in `package.json` and commit that on its own.
2. Tag the commit that contains the bump — the tag and the version must agree:
   ```bash
   git tag v<version> && git push origin master --tags
   ```
3. `.github/workflows/release.yml` packs the tarball, checks it, and publishes
   the release with generated notes.

Step 2 is the one that is easy to get wrong, so the workflow refuses to guess:
it fails when the tag is not on the commit being released, and again when the
tag does not match `package.json`'s `version`. Bump the version *before*
tagging; the tag is not the place to bump.

The `npm pack --dry-run` check in the release workflow is deliberately a copy of
what `pi-manager-core`'s `test/package-contents.mjs` proves on every CI run. A
release workflow that borrowed the check from another repository would depend on
that repository being checked out at the right ref, which is a moving part a
release should not have.
