# pi-blender

Pi extension extracted from [pi-blender](https://github.com/veoery/BlenderAgent) 0.1.2
(MIT) — the pi-blender fork of the pi monorepo. Brings the live-Blender 3D
modeling workflow (scene state, vision-informed iteration, render loop) into
stock pi, with fixes for a **flatpak** Blender install.

## Layout

```
index.ts            extension entry (13 tools + /blender command + skills + prompt injection, launches Blender when /blender runs or a blender_* tool is used)
launch.ts           BLENDER_PATH resolution (argv-aware) + detached live-bridge launch (on first blender_* use, + 15s liveness supervisor in the root session only)
config.ts           assets/bridge/temp dir resolution (XDG cache based)
core/exec.ts        execCommand stand-in (argv spawn, no shell)
blender/            module from packages/coding-agent/src/blender/ (+ set-mode, paint scene-info categories, module run/revert)
  live-bridge.py      file-based bridge polled inside a running Blender UI
  blank-bootstrap.py  strips the default startup scene and saves a clean blank.blend at launch (per-instance path)
  skills/             /skill:blender-create, blender-edit, blender-analyze, blender-with-reference, blender-paint, blender-modules, blender-live-state
  agents/             blender-worker + blender-critic + blender-manager PROMPT
                      + blender-diagnostician + blender-camera-aligner
                      + blender-finalizer + blender-script-runner
                      + blender-merger subagent definitions (nine distinct
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
   `$XDG_CACHE_HOME/pi-blender/tmp` (default `~/.cache/pi-blender/tmp`),
   overridable with `PI_BLENDER_TMP_DIR`.
2. **Command resolution** — `BLENDER_PATH` is whitespace-split into an argv
   array (no shell), so `BLENDER_PATH="flatpak run --command=blender
   org.blender.Blender"` works. Without it: macOS app path →
   `flatpak info org.blender.Blender` autodetect → `blender` on PATH.
3. **Bridge dir** — default moved from `~/.pi/agent/blender-bridge` to
   `~/.cache/pi-blender/bridge` (XDG cache), override with
   `PI_BLENDER_BRIDGE_DIR`. The bridge dir is **per pi process**:
   `…/bridge/<instance-id>`, so concurrent instances never contend for one
   mutable scene. The override disables that scheme entirely — one flat dir,
   no sweep — so a pinned dir's contents are treated as yours, not as instances.
   That also changes what a workspace claim can mean: with no per-instance
   `instance.json` to consult, the check falls back to whether the recorded
   owner's pid is still running, so a pinned dir is a promise you keep
   yourself — two pi processes on one pinned dir will both pass it. Pin the
   dir only when you deliberately want one shared scene.
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
   `PI_BLENDER_NO_UI=1` still opts out entirely.
   The 15 s **liveness supervisor that restarts a closed UI runs only in the
   root session** (`launch.ts` `startBridgeSupervisor`, gated on
   `PI_SUBAGENT_CHILD` — the same discriminator the shutdown guard in
   `index.ts` uses). A subagent child never supervises: it does not own the
   UI's lifetime, and a long-lived async runner process that outlives its
   session would otherwise keep respawning a stray window on the blank
   bootstrap blend, surviving every close, with the reaper unable to help
   because its owner pid is genuinely alive. If a child launched the *first*
   UI of a session and you then close it, nothing reopens it and the next
   `blender_*` call reports a dead bridge — a reported failure beats a
   silently respawned empty window.
6. **Blank scene on launch** — the UI launch runs `blank-bootstrap.py`
   first: it strips the default startup Cube/Camera/Light and saves the
   result to `$XDG_CACHE_HOME/pi-blender/blank/<instance-id>.blend`
   (flatpak-visible under the bind-mounted XDG cache home), so the
   live session starts from a clean, saved, non-dirty scene. The per-instance
   filename is why two pi processes can each hold a scratch blank without
   fighting over one file. No manual
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
| `PI_BLENDER_BRIDGE_DIR` | `~/.cache/pi-blender/bridge` (each pi process uses `…/<instance-id>/`; setting this pins ONE shared dir and disables per-instance isolation — see §3) |
| `PI_BLENDER_TMP_DIR` | `~/.cache/pi-blender/tmp` |
| `PI_BLENDER_BLANK_BLEND_PATH` | `~/.cache/pi-blender/blank/<instance-id>.blend` (launch.ts always sets this; `blank-bootstrap.py`'s own default is `…/blank/manual.blend`, used only for a hand-started Blender) |
| `PI_BLENDER_NO_UI` | unset (set `1` to never auto-launch UI) |
| `PI_BLENDER_MAX_PARALLEL_RUNS` | `16` — ceiling on concurrent **headless** Blender runs. A request, not a promise: the effective count is the smallest of this, the measured ceiling (4), the core count at 3 per run, and what free memory allows. The default is therefore normally clamped, and the clamp prints a warning naming the binding term. `blender_bridge_status` reports the resolved numbers **and how many headless Blenders are open right now**, counted across every process in the session tree, so a manager can see what its workers spent rather than only what the ceiling permits. A `/blender-watch` window is reported separately from that count: it is not one of these runs. |
| `PI_HOME` | `~/.pi` — root of the pi installation |
| `PI_AGENT_DIR` | `$PI_HOME/agent` — where extensions and agents are installed, and the base for every other path this table resolves against |

## Install

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

## Usage

Start pi in any project dir. The extension:

- registers `blender_workspace_init`, `blender_execute_python`, `blender_session_context`, `blender_scene_info`, `blender_geometry_probe`, `blender_image_probe`, `blender_read_only_python`, `blender_montage`, `blender_add_reference`, `blender_save_view`, `blender_render`, `blender_set_mode`, `blender_log_critique`, `blender_module_run`, `blender_module_revert`, `blender_bridge_status` (16 tools)
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
- opens NO Blender window itself. `/blender` engages the extension and makes
  the session the manager; it does not put a window on the user's screen. The
  one command that opens a window is `/blender-watch`, which is the only
  authorized spawner: a window exists if and only if it asked for one, and a
  session never has more than one. Every authoring path is headless and does
  not need a window — `blender_module_run` runs a module against a branch copy
  and merges the result, `blender_render` falls back to the background engine,
  and `blender_session_context` reads the blend on disk
- registers the `/blender` slash command — everything after `/blender`
  becomes the Blender task and engages the extension. The session it engages
  IS the manager: there is no manager subagent and no router hop, so the
  build's task list and progress are visible in the session the user typed the
  command into, rather than inside a child they would have to open to watch
- registers `/blender-exit`, which lifts the manager gate without ending the
  session or touching `model.blend`. Manager mode otherwise lasts until
  `/new`, which breaks a session that interleaves Blender with other work (a
  Unity bridge writing C#). The `blender_*` tools, `/blender` and the skills
  stay available afterwards; only this session's `write`/`edit`/image
  restriction ends. Spawned subagents are unaffected either way, because the
  gate exempts every child. The command is **suggested only in manager
  mode**: the instruction to mention it lives in the manager prompt, which is
  injected only while `/blender` is active, so a non-Blender session is never
  told about it. The prompt also caps it at one mention per session and
  forbids offering it to unblock a Blender task, since delegation — not
  writing — is how a manager does Blender work
- loads the 7 bundled `/skill:blender-*` skills (including `blender-paint`
  for texture paint, UV, vertex/weight paint, and bone/rig work, and
  `blender-modules` for Manager > worker/critic multi-module orchestration)
- injects the manager prompt (read from `blender/agents/blender-manager.md`) +
  a live session-state block
  (selection, viewport, mode, 1.5 s timeout) in **manager mode only**, which
  `/blender` enters and nothing else does. A `blender_*` tool called on its
  own gets no manager prompt and is not gated, because a direct tool call is
  worker-level work. If the bridge does not answer in time, the block is
  replaced by an explicit `Live Blender state is UNAVAILABLE` notice instead of
  silently disappearing, so the agent refreshes with `blender_session_context`
  rather than guessing
- `blender_scene_info` accepts the extra categories `uv`, `armatures`,
  `textures`, and `paintSettings` for paint/UV/rig planning
- `blender_geometry_probe` accepts a `shape` check alongside `transform`,
  `bounds`, `axis`, `pair`, and `topology`. `shape` measures the mesh rather
  than its placement: a radius profile along the mesh's own longest axis
  (mean, spread, monotonic, taper), self-symmetry about the mesh's own
  bounding-box centre (not the world origin), convexity as the fraction of
  sampled vertices lying on the mesh's own convex hull, and the open-edge and
  loose-vertex counts. A render is a projection, so it cannot show a saddle
  facing away, distinguish an asymmetric form from a symmetric one, or see the
  inside of a hollow shell
- `blender_image_probe` samples a rendered PNG that is already on disk and
  returns numbers rather than an image: subject bounds and coverage, an
  nx-by-ny mean-luma grid, per-row silhouette occupancy, edge sharpness, mean
  colour and a dominant-colour palette. `background` is a required input
  rather than an inferred one, because a wrong backdrop is read as subject and
  empties the whole measurement. It decodes PNG in-process (bit depths 1-16,
  colour types 0/2/3/4/6, all five filters) with no new dependency, and
  refuses an interlaced or non-PNG file by name rather than decoding it wrongly.
  It costs nothing against a critic's image budget because the pixels never
  enter the model's context as an image
- `blender_read_only_python` takes Python as inline text and returns what it
  printed, for a read-only role that has no `write` tool. The refusal is
  enforced in `blender/readonly_guard.py`, in the Blender process, by patching
  the objects a script reaches through rather than by scanning its source: a
  text scan is defeated by a name assembled from a string, and it would pass a
  script that never mentions a forbidden name and still deletes something. It
  covers `bpy.ops`, `bpy.data` removal, assignment to an object or to a
  component of its vectors (`obj.location.x = 5` mutates through the vector, so
  returning a copy is not enough — that would let the assignment succeed and the
  script read back its own number), and saving. A refusal comes back as
  `refused: true` naming the operation rather than as an error, because
  "your question needed a change" is an answer
- `blender_montage` renders several preset orbit angles of one subject and
  tiles them into a single labelled sheet at `modules/<name>/montage.png`,
  with each panel also written separately at full size. The cameras sit on one
  orbit at one distance from the subject's bounding sphere, so a difference
  between two panels is the geometry rather than the camera; the framing
  distance comes from the lens rather than a fixed multiplier, so a 200mm lens
  is not framed tighter than a 50mm one. Labels are capped to their own panel,
  because a label that runs into the next panel identifies the wrong view.
  Read-only with respect to the file it photographs: resolution, filepath, file
  format, scene camera and viewport are snapshotted and restored, and the
  temporary cameras are removed. It exists because one angle cannot answer
  every question — a silhouette that may be hiding a limb, a form that reads
  symmetric from the front and wrong from three-quarter — and because a sheet
  costs the same transcript weight as one render: images persist in a
  conversation and are re-sent every request
- `blender_log_critique` requires the `moduleName` it judged. The iteration
  number alone stops identifying what was reviewed once several modules are
  judged at once, and under parallel runs `latestIteration` is whichever run
  finished last — so a critique would carry a sibling's number. The module name
  goes into the log header with the budget position
  (`[ts] iteration_07 module=shirt budget 2/5`), and the budget is claimed
  under the manifest lock, so two critics judging one module at the same time
  cannot both take the last slot. Budgets are per module and reset when that
  module presents, so a pack of models reviewed in parallel each get their own
  five
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
  erroring immediately. A lock-wait timeout names the current holder, its pid,
  and how long it has been held, so it reads as "wait your turn" instead of a
  mysterious timeout. `blender_bridge_status` reports whether the UI is alive,
  busy, and how many requests are pending
- **authoring parallelises, execution does not.** Workers writing separate
  `modules/<name>/script.py` files never interfere, so a multi-part build
  spawns one `blender-worker` per part in the same turn. Their *runs* all
  execute inside the one live session behind that lock, so the manager hands
  the queue to a single `blender-script-runner`, which runs them in dependency
  order and diffs the scene around each run to catch a module that touched an
  object it did not own — contamination is reported, never silently repaired,
  because the repair is usually a revert that discards work. Parts that
  genuinely depend on each other are spawned in sequence instead of fanned
  out
- the bundled subagent definitions are `blender-worker` (authors one
  module), `blender-critic` (read-only render judge, one image budget per
  run), `blender-diagnostician` (read-only geometry measurement),
  `blender-camera-aligner` (blind camera placement that nests its own
  critics), `blender-finalizer` (one-shot asset hygiene: applies
  transforms, resolves mirrors, sets origins and shading, normalizes names;
  it does not export — the deliverable is `model.blend`),
  `blender-script-runner` (serializes module runs and audits them for
  cross-module contamination) and `blender-merger` (one-shot join of the
  finished parts, which reports "no merge needed" and runs nothing when the
  parts are already coherent). They are
  **templates** installed by `npm run install:agents`. `blender-manager.md` is
  deliberately NOT one of them: it is a PROMPT, read at runtime by
  `getManagerPrompt()` in `config.ts` and injected as a system-prompt section,
  because the `/blender` command session IS the manager. Installing it would
  leave a spawnable `blender-manager` whose prompt drifts from the one the user
  is watching; the installer deletes any already-installed copy.
  The hierarchy is therefore FLAT at the top: the `/blender` session (depth 0,
  the manager) → its subagents (depth 1) → the aligner's own critics (depth 2).
  The manager session is gated so it delegates instead of authoring code, and
  it is limited by name to the eight agents it may nest: `blender-worker`,
  `blender-script-runner`, `blender-merger`, `blender-critic`,
  `blender-diagnostician`, `blender-finalizer`, `blender-camera-aligner` and
  `blender-reference-describer`. `blender-camera-aligner` is reachable only
  because of that flat top: no router sits between the command and the manager,
  so the aligner at depth 1 still has room for the depth-2 critics it nests
  itself. The manager needs `PI_SUBAGENT_MAX_DEPTH`-style headroom for its own
  children; set
  `{"maxSubagentDepth": 3}` in `~/.pi/agent/extensions/subagent/config.json`
  (config, not the env var: child sessions carry a `runtime.maxDepth` that the
  env var never reaches)
- launches a windowed Blender only when `/blender-watch` asks for it, and
  keeps that one window alive across the session while the user wants it. A
  `blender_*` tool call alone never opens a window, and neither does the
  supervisor. Most tools need no window at all: with none open they run
  headlessly against `model.blend`, through the same bridge script the window
  serves, so the two paths cannot drift apart. Only two things genuinely
  require one — `blender_set_mode` and `blender_save_view` with
  `source=active-camera` — because both photograph or rearrange what a viewport
  is showing, which has no meaning in a process with no screen. Those two
  refuse and name `/blender-watch` instead of opening a window behind the
  user's back
- exports the workspace blend to an interchange format with
  `blender_export_asset` (`glb`, `gltf`, `obj`, `stl`), headlessly and
  read-only. USD is deliberately not offered: no exporter is guaranteed in a
  stock Blender build, and a format that silently fails on one machine is worse
  than one not offered. glTF export applies modifiers, so the training geometry
  is the geometry that was rendered
- ranks a batch against itself with `blender_rank_assets`, reading
  `critique.log` for structure only — never for prose. An absolute threshold
  can say whether an asset is good enough; it cannot say whether it is the best
  of a thousand, and the 60th-vs-95th-percentile gap is invisible to a rubric
  that has only seen one asset at a time. Only presented, usable-view entries
  are eligible, and `topFraction` (default 0.1) takes the slice. The report
  warns when rejects outnumber presents, because that points at the brief
  rather than at the assets

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
