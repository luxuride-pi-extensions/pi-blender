# pi-vibe-blender

Pi extension extracted from [vibe-blender](https://github.com/veoery/BlenderAgent) 0.1.2
(MIT) — the Vibe Blender fork of the pi monorepo. Brings the live-Blender 3D
modeling workflow (scene state, vision-informed iteration, render loop) into
stock pi, with fixes for a **flatpak** Blender install.

## Layout

```
index.ts            extension entry (13 tools + /blender command + skills + prompt injection, launches Blender when /blender runs or a blender_* tool is used)
launch.ts           BLENDER_PATH resolution (argv-aware) + detached live-bridge launch (session_start + liveness re-spawn)
config.ts           assets/bridge/temp dir resolution (XDG cache based)
core/exec.ts        execCommand stand-in (argv spawn, no shell)
blender/            module from packages/coding-agent/src/blender/ (+ set-mode, paint scene-info categories, module run/revert)
  live-bridge.py      file-based bridge polled inside a running Blender UI
  blank-bootstrap.py  strips the default startup scene and saves a clean blank.blend at launch
  skills/             /skill:blender-create, blender-edit, blender-analyze, blender-with-reference, blender-paint, blender-modules, blender-live-state
  agents/             blender-manager + blender-worker + blender-critic
                      + blender-diagnostician + blender-camera-aligner
                      + blender-finalizer subagent definitions (six distinct
                      roles)
                      TEMPLATES — run `npm run install:agents`, which copies
                      them to ~/.pi/agent/agents/ and substitutes their
                      `extensions:` frontmatter placeholders with absolute
                      paths for your machine (no ~ or env expansion happens
                      for that field)
scripts/install-agents.mjs  generates the machine-specific agent copies
                            (`--check` verifies them without writing)
scripts/dev-setup.mjs       one-command setup for a fresh clone: extension
                            symlink, typebox link, agent install, todo
                            provider check, Blender resolution report
                            (`--check` is read-only and exits 1 on any problem)
node_modules/typebox -> symlink to pi's bundled typebox (jiti resolves it)
```

## Flatpak fixes (vs. upstream)

1. **Temp scripts** — upstream writes bpy scripts to `os.tmpdir()` (`/tmp`),
   which the `org.blender.Blender` sandbox cannot read. Now:
   `$XDG_CACHE_HOME/vibe-blender/tmp` (default `~/.cache/vibe-blender/tmp`),
   overridable with `PI_BLENDER_TMP_DIR`.
2. **Command resolution** — `BLENDER_PATH` is whitespace-split into an argv
   array (no shell), so `BLENDER_PATH="flatpak run --command=blender
   org.blender.Blender"` works. Without it: macOS app path →
   `flatpak info org.blender.Blender` autodetect → `blender` on PATH.
3. **Bridge dir** — default moved from `~/.pi/agent/blender-bridge` to
   `~/.cache/vibe-blender/bridge` (XDG cache), override with
   `PI_BLENDER_BRIDGE_DIR`. The bridge dir is **per pi process**:
   `…/bridge/<instance-id>`, so concurrent instances never contend for one
   mutable scene. The override disables that scheme entirely — one flat dir,
   no sweep — so a pinned dir's contents are treated as yours, not as instances.
4. **Nothing is written until Blender is launched** — the instance dir claim
   and the sweep of other instances' dirs hang off the *first launch*
   (`launch.ts` `ensureInstanceClaimed`), not off `session_start`. A pi
   session that never engages Blender therefore creates no directory under the
   bridge root and enumerates no neighbours. Both steps are also idempotent:
   the claim happens once per process, so `/new` never rewrites `startedAt`.
5. **Launch** — Blender is NOT launched at pi/session start. It launches
   when the user engages Blender: the `/blender` command calls
   `ensureLiveBridgeLaunchedForce()`, and any `blender_*` tool call
   triggers the lazy `ensureLiveBridgeLaunched()` path in
   `blender/bridge.ts`. Both check the bridge heartbeat before spawning, so
   a UI that is already running — including one started by a different pi
   process — is never duplicated on the same bridge dir; a UI closed just
   before (heartbeat gone) is still relaunched. As defence in depth,
   `live-bridge.py` claims each request with an atomic rename before
   executing it, so even two pollers can never run one request twice.
   `VIBE_BLENDER_NO_BLENDER=1` still opts out entirely.
6. **Blank scene on launch** — the UI launch runs `blank-bootstrap.py`
   first: it strips the default startup Cube/Camera/Light and saves the
   result to `blank.blend` (flatpak-visible under the XDG cache home), so
   the live session starts from a clean, saved, non-dirty scene. No manual
   "save/discard startup scene" step is needed before editing. Note this also
   means a `template: "blank"` workspace has **no camera and no lights** at
   all — use the default `studio` template unless you have a reason not to.
7. **Engagement gating** — the workflow-guidance + live-session-context
   block is injected when the user runs the `/blender` slash command or
   after a `blender_*` tool has already run in the session; no keyword
   detection of the prompt. Non-Blender pi sessions pay no prompt or
   bridge-poll cost.
8. **One workspace, one instance** — a workspace records which pi instance
   claimed it, and a second instance opening it is **refused** rather than
   shared: two Blender windows on one `model.blend` overwrite each other on
   save, and neither can tell the other exists. The check lives in
   `loadWorkspaceManifest`, the one chokepoint every workspace tool goes
   through, so no tool can bypass it. A claim from a **dead** instance is
   taken over silently — nothing is answering, and a claim that can never
   block anyone is worse than no claim. The claim is advisory, never a lock: a
   crashed session never locks you out of your own workspace.
9. **Peers are visible, not hidden** — a live peer UI holding the same blend
   is reported in the per-turn session snapshot (`sharedWith`, plus a warning
   line), because the read-only context tool cannot refuse anything but can
   tell a session that a second window is watching the file it is about to
   mutate. Peer discovery reads heartbeats, which now carry the open
   `blendPath`, so it reports what a UI actually has open rather than what a
   claim file once said.

## Env vars

| Var | Default |
| --- | --- |
| `BLENDER_PATH` | auto (flatpak autodetect, else `blender` on PATH) |
| `PI_BLENDER_BRIDGE_DIR` | `~/.cache/vibe-blender/bridge` |
| `PI_BLENDER_TMP_DIR` | `~/.cache/vibe-blender/tmp` |
| `PI_BLENDER_BLANK_BLEND_PATH` | `~/.cache/vibe-blender/blank.blend` |
| `VIBE_BLENDER_NO_BLENDER` | unset (set `1` to never auto-launch UI) |

## Install

```bash
git clone <this repo's URL>
cd pi-vibe-blender
npm install
npm run setup
```

`npm run setup` does everything a fresh clone needs and is safe to re-run:

```
ok     extension symlink — ~/.pi/agent/extensions/vibe-blender -> <clone>
ok     typebox resolvable — node_modules/typebox (pi 0.87.1)
ok     agent definitions — 6 in sync in ~/.pi/agent/agents
ok     todo provider for blender-manager — @juicesharp/rpiv-todo
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
- **`@juicesharp/rpiv-todo`** must be present, because `blender-manager` lists
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

## Usage

Start pi in any project dir. The extension:

- registers `blender_workspace_init`, `blender_execute_python`, `blender_session_context`, `blender_scene_info`, `blender_geometry_probe`, `blender_add_reference`, `blender_save_view`, `blender_render`, `blender_set_mode`, `blender_log_critique`, `blender_module_run`, `blender_module_revert`, `blender_bridge_status` (13 tools)
- `blender_workspace_init` defaults to `template: "studio"`, which starts from
  an empty file (`wm.read_homefile(use_empty=True)`) and adds a `StudioCamera`,
  a three-point area-light rig (key/fill/rim, all aimed at the origin), a
  neutral world, and EEVEE at 1200x900 — so the first worker can model
  immediately instead of spending its module slot building a shot. `template:
  "blank"` keeps the old behaviour (save Blender's startup file as-is, no
  camera or lights). Both are ignored when `sourceBlend` is given, since a
  source scene brings its own setup. Studio objects live in a `Studio`
  collection under a `Studio` prefix, so they are easy to exclude from
  measurements.
- registers the `/blender` slash command — everything after `/blender`
  becomes the Blender task and engages the extension
- registers `/blender-exit`, which lifts the manager gate without ending the
  session or touching `model.blend`. Manager mode otherwise lasts until
  `/new`, which breaks a session that interleaves Blender with other work (a
  Unity bridge writing C#). The `blender_*` tools, `/blender` and the skills
  stay available afterwards; only the parent's `write`/`edit`/image restriction
  ends. A spawned `blender-manager` is gated by *name*, not by this flag, so
  it is unaffected either way. The command is **suggested only in manager
  mode**: the instruction to mention it lives in the guidance section, which is
  injected only while `/blender` is active, so a non-Blender session is never
  told about it. The guidance also caps it at one mention per session and
  forbids offering it to unblock a Blender task, since delegation — not
  writing — is how a manager does Blender work
- loads the 7 bundled `/skill:blender-*` skills (including `blender-paint`
  for texture paint, UV, vertex/weight paint, and bone/rig work, and
  `blender-modules` for Manager > worker/critic multi-module orchestration)
- injects Blender workflow guidance + a live session-state block
  (selection, viewport, mode, 1.5 s timeout) in **manager mode only**, which
  `/blender` enters and nothing else does. A `blender_*` tool called on its
  own gets no manager guidance and is not gated, because a direct tool call is
  worker-level work. If the bridge does not answer in time, the block is
  replaced by an explicit `Live Blender state is UNAVAILABLE` notice instead of
  silently disappearing, so the agent refreshes with `blender_session_context`
  rather than guessing
- `blender_scene_info` accepts the extra categories `uv`, `armatures`,
  `textures`, and `paintSettings` for paint/UV/rig planning
- **delegation is enforced, not advised.** In manager mode — entered by
  `/blender` and cleared by `/blender-exit` or a new session — a `tool_call` hook blocks the
  MANAGER from `write`, `edit`, and from `read`
  of image files (`.png .jpg .jpeg .gif .webp .bmp`) — a render tells the
  critic that something looks wrong, but only measurement says how, and the
  manager guessing at an offset is the failure this project exists to avoid.
  Text reads, `bash`, and the pi-memory tools stay open, and the hook is inert
  outside manager mode — including in a session that called a `blender_*` tool
  without `/blender`. Every `blender-*` skill routes authoring to a
  `blender-worker` module, so the skills and the gate agree. Note this is a
  nudge rather than a boundary: `bash` remains available.
- `blender_set_mode` switches the live viewport to OBJECT, POSE, EDIT_MESH,
  EDIT_ARMATURE, SCULPT, TEXTURE_PAINT, VERTEX_PAINT, WEIGHT_PAINT,
  FACE_PAINT, or UV (edit mode + viewport UV editor overlay)
- `blender_module_run` / `blender_module_revert` support modular multi-part
  work: one `modules/<name>/script.py` per object or concern, a per-run
  checkpoint (`modules/<name>/runs/NN/pre-NN.blend`), optional live render to
  `modules/<name>/render.png` (with `viewportShading`/`resolution`/`samples`
  parity with `blender_render`), and a manifest `moduleRuns` history so revert
  restores an exact recorded run. A module render with no explicit
  `resolution` defaults to **1200x900** (not the blend's own setting, which is
  1920x1080) — these renders are the critic's image budget, and base64
  payloads persist in the transcript, so the difference between 1200x900 and
  1920x1080 is roughly 1.3 MB versus 3.7 MB per render Revert **refuses** when later module runs
  also modified the shared `model.blend`, unless `force: true` is passed —
  otherwise it would silently destroy another module's work
- every `blender_*` bridge request takes a disk lock (`<bridge dir>/bridge.lock`,
  stale-reclaimable after 10 min), because the live UI is a single mutable
  session: concurrent requests interleave and corrupt state. A single module
  run can hold that lock for minutes (a render alone allows 360 s), so a
  parallel spawn *queues* and then fails on its own timeout rather than
  erroring immediately — run one module at a time. A lock-wait timeout names
  the current holder, its pid, and how long it has been held, so it reads as
  "wait your turn" instead of a mysterious timeout. `blender_bridge_status`
  reports whether the UI is alive, busy, and how many requests are pending
- the bundled subagent definitions are `blender-manager` (a spawnable
  manager-for-a-whole-build, so a non-Blender session such as a Unity bridge
  can hand over one self-contained task), `blender-worker` (writes/runs a
  module), `blender-critic` (read-only render judge, one image budget per
  run), `blender-diagnostician` (read-only geometry measurement),
  `blender-camera-aligner` (blind camera placement that nests its own
  critics) and `blender-finalizer` (one-shot asset hygiene: applies
  transforms, resolves mirrors, sets origins and shading, normalizes names;
  it does not export — the deliverable is `model.blend`). They are
  **templates** installed by `npm run install:agents`. Both `blender-manager`
  (matched by name, whether spawned or entered via `/blender`) and the
  `/blender` parent are gated so they delegate instead of authoring code; the
  spawned manager is additionally limited to spawning `blender-worker`,
  `blender-critic`, `blender-diagnostician` and `blender-finalizer`, while the
  `/blender` parent keeps the full roster because it is the session that can
  afford the aligner's extra nesting depth. `blender-manager` needs
  `PI_SUBAGENT_MAX_DEPTH`-style headroom for its own children; set
  `{"maxSubagentDepth": 3}` in `~/.pi/agent/extensions/subagent/config.json`
  (config, not the env var: child sessions carry a `runtime.maxDepth` that the
  env var never reaches)
- launches a flatpak Blender UI when the user runs `/blender` (via
  `ensureLiveBridgeLaunchedForce()`) or calls any `blender_*` tool (via the
  lazy `ensureLiveBridgeLaunched()` path); a UI closed across /new is
  automatically re-spawned on the next engagement, while an already-running
  UI is left alone

Example prompts:

```
/blender build a modern walnut coffee table with brass legs
/blender make the tabletop thicker in outputs/coffee-table
/blender texture paint a wood grain look on the tabletop, then leave the viewport in texture paint mode
/blender build a low-poly robot: body, head, armature, then texture paint — run it as modules so I can ask for reverts
```

(The old `/skill:blender-*` style prompts still work — skills load as
usual; only the extension's auto-engagement now requires `/blender`.)

## Verified end-to-end (2026-07-26, Blender 5.2.0 LTS flatpak, pi 0.87.1)

- `/blender` → Blender UI force-launched via `ensureLiveBridgeLaunchedForce()`; first
  `blender_workspace_init` call → open `model.blend` in the live UI
- `blender_execute_python` ran a bpy script in the live session (exit 0, saved)
- `blender_scene_info` returned live objects/cameras
- `blender_render` (live, material-preview, 480x320) wrote `renders/render.png`
