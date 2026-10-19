# pi-blender design notes

Material moved out of the README: how the extension is laid out, the
flatpak-specific fixes it carries, environment variables, and the full
tool-by-tool usage reference.

## Layout

```
index.ts            extension entry (23 tools + /blender command + skills + prompt injection, launches Blender when /blender runs or a blender_* tool is used)
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
                      + blender-merger + blender-reference-describer
                      + the four blender-composition-*
                      subagent definitions (twelve distinct roles; blender-manager.md
                      is the manager PROMPT rather than an installed agent, and
                      exchange.md is the manager/child message contract, not a role)
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
docs/adr/                   architectural decision records (0001: do not rewrite as an MCP server)
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
   dir only when you deliberately want one shared scene. See
   [ADR 0001](adr/0001-do-not-rewrite-pi-blender-as-an-mcp-server.md) for why
   per-process bridge isolation is maintained rather than hosting a shared daemon.
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

## Usage

Start pi in any project dir. The extension:

- registers `blender_workspace_init`, `blender_execute_python`, `blender_session_context`, `blender_scene_info`, `blender_geometry_probe`, `blender_image_probe`, `blender_read_only_python`, `blender_montage`, `blender_compare`, `blender_add_reference`, `blender_save_view`, `blender_render`, `blender_set_mode`, `blender_log_critique`, `blender_iteration_state`, `blender_record_iteration_fact`, `blender_module_run`, `blender_module_revert`, `blender_bridge_status`, `blender_branch_run`, `blender_branch_apply`, `blender_rank_assets`, `blender_export_asset` (23 tools)
- `blender_workspace_init` defaults to `template: "studio"`, which starts from
  an empty file (`wm.read_homefile(use_empty=True)`) and adds a `StudioCamera`,
  a three-point sun rig (key/fill/rim, all aimed at the origin), a
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
  (see [ADR 0001](adr/0001-do-not-rewrite-pi-blender-as-an-mcp-server.md) for why
  manager mode, task tracking, and prompt injection reside in-session rather than
  behind an external server boundary)
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
  `bounds`, `axis`, `pair`, `joint`, `clearance`, `path`, and `topology`. `shape` measures the mesh rather
  than its placement: a radius profile along the mesh's own longest axis
  (mean, spread, monotonic, taper), self-symmetry about the mesh's own
  bounding-box centre (not the world origin), convexity as the fraction of
  sampled vertices lying on the mesh's own convex hull, and the open-edge and
  loose-vertex counts. A render is a projection, so it cannot show a saddle
  facing away, distinguish an asymmetric form from a symmetric one, or see the
  inside of a hollow shell
- `blender_geometry_probe`'s `clearance` check asks whether the room is a room
  somebody can USE, which is a different question from whether its parts meet,
  and the two faults it reports are not the same fault. `islandCount` above 1
  is reachable free floor in more than one piece — a sofa laid wall to wall
  splits a room in two, both halves are reachable, and nothing connects them,
  and the render shows a furnished room, which is why it reaches the user
  rather than the analyst. `unreachableArea` above 0 is free floor reaching NO
  edge at all: a pocket a person at the door cannot walk to, cut off by a
  closed ring of furniture, which reports `islandCount` 1 and so is invisible to
  the first figure. **The core of the measure is a body radius, not a grid,
  and that came from a fixture rather than from taste.** Each sample stands for
  a person and is blocked when an obstruction comes within `body` of it, so
  every obstruction is DILATED before it is stamped. The obvious version — an
  occupancy raster with a flood fill — reported a sofa spanning 5.9 m of a 6 m
  room, 50 mm clear at each end, as ONE free region, and the same sofa with
  500 mm clear also read 1, so the number could not tell a blocked room from a
  clear one: a flood fill walks through a one-cell gap as readily as through a
  metre. `body` is the knob that fixes both, because 50 mm is inside the reach
  of a shoulder and 500 mm is not. Widen it to ask whether a wheelchair gets
  through; narrow it to ask whether anything does. It takes its room from the
  same `objects` you scope it to, so measure one room rather than the house,
  and note that it does NOT know where a door is: a room with no door at all
  reads as one reachable island, so a zero here is not a room that works. An
  area is a count of samples and quantises, so the isolation figures are the
  ones to act on, and `note` always says which way the error runs
- `blender_geometry_probe`'s `path` check asks whether the WALK between two
  points is longer than the line between them, and it is the only defect in
  this list that a good-looking render actively hides. Every wall meets, every
  opening is the right width, every room is correct in isolation, and a person
  still stair-steps from one door to the next because each shell was placed
  against its own origin rather than a shared axis. From above it is a house.
  Pass `points` — door centres, the ends of a corridor — and every PAIR of them
  is walked over the same floor raster the `clearance` check uses, walls
  included, because a path that ignores walls goes through them. The number is
  a ratio: walked over straight, so 1.0 is a corridor, one bend is about
  1.1–1.3, and four offset doors measured **1.917** in `test/path-probe.py`,
  which is why the default threshold is 1.45 — real architecture bends once and
  the defect is the several-turn stair-step. A right-angle L in a textbook reads
  1.27 and here reads nearer 1.08, because a door centre snaps to the nearest
  free sample and that pulls both ends off the wall plane: line and walk shorten
  together so the ratio survives, but **compare ratios against each other, not
  against a figure from a textbook.** Every pair is measured rather than the
  ones you ordered, because a house is short of doors and long of rooms and the
  pair a designer forgot is the one that zig-zags. A wardrobe across a corridor
  reports **no route at all** rather than a detour of infinity, and a point
  that lands on no free floor is listed in `unresolved` rather than guessed at —
  a door buried in a solid and a door nobody modelled are indistinguishable to
  this measure, and only one of them is a layout error.
- `blender_geometry_probe`'s `joint` check finds the parts that are detached
  WITHOUT being asked, which is the only way the defect reaches the user rather
  than the analyst: a shower riser modelled 11 mm clear of the pipe it
  continues looks correct in a render from any useful angle, and nobody pairs
  two pipes of the same object family by instinct. It sweeps every pair in
  scope, filters by bounding box so the sweep stays O(n²) in boxes rather than
  in BVH builds, and reports five severities. `coincident-surface` is the
  defect a pair check cannot see at all: two parts sharing a stretch of
  geometry render as z-fighting colour banding, and the verdict says
  `in-contact` — which is what a CLEAN flush abutment also says — so the joint
  sweep skipped exactly the pairs that needed it. It is measured as the count
  of each object's vertices lying within 0.1 mm of the other's surface, taken
  INSIDE the two bounding boxes' shared volume, because that volume is both the
  right scope and the right denominator. The first version divided by the whole
  mesh and the cleanest case of the defect failed to report: a panel laid on a
  wall covers a fraction of the wall, so its 12 touching vertices against the
  wall's 81 came to 14.8% and slipped under a 15% floor. `buried` is the next
  one, and it needed TWO numbers rather than one. `interpenetrating` is a single
  word for both a railing post set 2 mm into a deck — which is how the joint is
  built — and a wall built straight through a door, so the boolean cannot tell a
  working construction from a swallowed part. Depth as a multiple of the buried
  part's own thinnest extent tells them apart, and is scale-free where any
  threshold in metres is a statement about one asset. That alone was not
  enough: run against a real 243-object scene it reported 119 buried pairs,
  almost all of them correct geometry — a pier founded in the ground measured
  55x buried and a lantern standing inside a railing's extent 8.9x. Both are
  inside something large. So a second figure is required too: the part must be
  at least 1.5x smaller than the thing holding it, because something placed
  INTO something else is smaller than its container, while two surfaces of
  near-equal extent that overlap are layers. That filter took the same scene
  from 119 findings to 35. Both figures are reported, and a critic is told to
  judge the remainder, because the measure is a proportion and not a verdict.
  `broken-continuation`
  and `overlapping-but-apart` are also defects — two parts that were meant to be
  one and are not touching. `near-miss` is a placement to JUDGE and is deliberately
  not a failure: a chair pulled up to a table is geometrically indistinguishable
  from a detached riser, because the two differ in MEANING and no measurement
  recovers meaning, so calling it a defect would be the false positive that
  trains an analyst to ignore the list. Pairs that DO meet are skipped, because
  reporting the healthy case would bury the one that matters — the one
  exception being a coincident pair, which is in contact and still broken. The
  gap is the same signed BVH measurement the `pair` check reports, so a pair
  named in both gets identical numbers
- **A coincident pair's `deepestPenetration` is not a measurement to trust.**
  The inside/outside sign behind it comes from ray parity, which is arbitrary
  when two surfaces lie in one plane: two coincident panels came back reporting
  a half-metre penetration while touching nowhere. Read `coincidentSurface`
  instead, which asks the question directly
- `topology`'s `connectedComponents` is the one topology number that catches a
  mesh split into drifting pieces, and it is there because every other count is
  blind to that case: each piece is a clean closed solid, so a head that has
  drifted off its own pipe reports `nonManifoldEdges: 0`, `boundaryEdges: 0`,
  `looseVertices: 0` and `duplicateVertices: 0`. But `isSplit` alone is
  **not** a defect signal, and reading it as one buries the real finding under
  every assembly in the workspace: a railing of 66 balusters, a bamboo cluster
  of 83 culms, a drone's four propeller blades are all one mesh with many
  components, and all of them are CORRECT — merging repeated parts into one mesh
  is what the toolchain asks a worker to do. So read `islandRead` instead: it
  is `assembly` when no single island dominates (largest share under 10% — many
  equal parts), `break-candidate` when one body does dominate, and `continuous`
  for a single island.

  But `assembly` alone is NOT a pass: it says *many equal parts*, not that they
  **meet**. A merged mesh whose parts float apart is the exact shape of the
  defect this family exists for. So `islandFloatingShare` reports the percentage
  of islands whose nearest other island is farther than **5% of their own size**,
  and `islandContact` gives that ratio for the tightest join. The ratio is
  dimensionless on purpose — the same 25 mm is a seam on a 2.65 m plank and a
  canyon on a 0.3 m bollard. Measured on real workspaces the two cases are
  identical on the island count and opposite on contact: 32 bridge planks 2.65 m
  long, 25 mm apart, gap 9.6% of their own length, **100% floating — not an
  assembly, a broken model with a healthy-looking count** — against a shoji frame
  whose pieces share surfaces at **1.8% floating**
- Both of these are measured, not asserted. `test/joint-probe.py` builds a
  scene whose correct answers are known by construction (an 11 mm gap between a
  1 m riser and the pipe above it, a chair pulled up to a table, a cube
  interpenetrating another, a part floating in a ring's void, a cube embedded
  in solid material, two panels laid in one plane, a bolt head resting flush on
  a plate, a mesh in two pieces) and runs the real handler in
  headless Blender; `test/blender-probes.test.mjs` drives it. The suite is what
  caught the two bugs this check shipped with: a bounding-box gap whose sign was
  inverted, so the distance filter rejected nothing and every pair in the scene
  was reported, and a containment test reading the wrong extreme, so a chair
  under a table counted as one box swallowing the other. The coincidence
  measure was caught the same way — by a fixture whose correct answer is known
  by construction, not by reading it
- Every Python probe in `test/` is run against a real Blender by
  `test/blender-probes.test.mjs`, and the runner asserts on the SUMMARY line
  each probe prints rather than the exit code — a Blender script exception is a
  traceback on stderr and Blender still exits 0, so the exit code cannot be the
  signal. The probes are listed in the runner, which is a real cost: a probe
  dropped off that list dies quietly, and `test/shape-probe.py` did exactly
  that, failing silently for as long as it went unrun after the handlers began
  requiring the `blendPath` they were not passing
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
- `blender_compare` renders the PREVIOUS generation of a subject beside the
  current one on one labelled sheet at `modules/<name>/compare.png`, the two
  panels of a view side by side. It exists because a critic judging the current
  render cannot see a REGRESSION: a brief covers what should be there, and a
  part that was fine last iteration and has grown a crack now is not mentioned
  anywhere in the brief. Both generations are framed from the UNION of their
  extents, so the camera is identical in every panel and a difference between
  two panels is geometry — framing each generation on its own extent would make
  a part that grew read as a camera change. The baseline is the checkpoint the
  earlier run started from, so no kept render is needed; it is a file on disk
  and is put back afterwards, so a comparison never replaces what you are
  looking at. Two runs is the minimum, and with one there is no previous
  generation to compare against
- `blender_iteration_state` / `blender_record_iteration_fact` carry a module's
  iteration state and its measured facts across critics. A fact a critic
  measured is worthless to the NEXT critic unless it is persisted, which is how
  a loop spends three renders re-learning that the handle is the wrong
  thickness: `blender_iteration_state` derives the state from the manifest and
  `critique.log` rather than from anyone's memory, reporting the per-module
  budget, the last run and its content digest, the last verdict and score,
  whether the last briefed fix actually changed anything, and a waste guard
  naming the condition under which another render would tell you nothing new.
  `blender_record_iteration_fact` persists ONE measured fact per call —
  what the probe returned and which tool returned it, so the next critic
  re-checks a number instead of trusting a sentence. Re-recording the same
  statement updates it rather than duplicating it, and the newest 24 facts per
  module are kept. Read the state before spending a run or a fresh critic
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
  FACE_PAINT, or UV (edit mode + viewport UV editor overlay). With no watch
  window open it reports `switched: false` and a reason rather than failing:
  the mode is a statement about a UI, and the paint underneath it is already
  applied as bpy data either way
- `blender_module_run` / `blender_module_revert` support modular multi-part
  builds. `blender_branch_run` / `blender_branch_apply` are the two halves of
  that exposed directly: run a module against a private `branch.blend`
  headlessly, with no bridge lock and no live session, then merge the staged
  branches back into `model.blend` in one serialized call that reports any
  contested datablock rather than auto-resolving it.
- `blender_rank_assets` reads a workspace's `critique.log` and keeps the best
  slice of a batch by score — an absolute verdict can say "good enough" but only
  ranking over a batch can say "best of these fifty". `blender_export_asset`
  writes `glb`/`gltf`/`obj`/`stl`, which is what makes an asset leave Blender at
  all; pass `objects` to keep the studio rig out of a dataset.
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
  busy, and how many requests are pending. (See
  [ADR 0001](adr/0001-do-not-rewrite-pi-blender-as-an-mcp-server.md) for why
  this cross-process lock, live/headless fallback, and module iteration state
  cannot be replaced by a remote or standalone MCP server without inventing
  distributed locking and losing crash reclamation.)
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
  finished parts). Three more run the other pipeline, for briefs that are a
  SPACE rather than a model: `blender-composition-planner` (plans the rooms on
  paper BEFORE anything is built -- purpose, entry and path, fixed elements with
  conflicts marked rather than resolved -- because a sofa across a corridor is a
  decision made early and merely discovered late),
  `blender-composition-worker` (builds one concern
  of a room -- shell, daylight, furniture, dressing -- against a shared
  coordinate frame, and reports every dimension against the brief's scale
  contract), `blender-composition-critic` (judges a room from interior-angle
  montage panels rather than an auto-framed module render, which for a building
  is a photograph of a wall) and `blender-composition-merger` (assembles the
  concerns, re-checks the scale contract across the finished room, and never
  joins a mesh -- a room is an assembly of things, not a model). They are
  **templates** installed by `npm run install:agents`. `blender-manager.md` is
  deliberately NOT one of them: it is a PROMPT, read at runtime by
  `getManagerPrompt()` in `config.ts` and injected as a system-prompt section,
  because the `/blender` command session IS the manager. Installing it would
  leave a spawnable `blender-manager` whose prompt drifts from the one the user
  is watching; the installer deletes any already-installed copy.
  The hierarchy is therefore FLAT at the top: the `/blender` session (depth 0,
  the manager) → its subagents (depth 1) → the aligner's own critics (depth 2).
  The manager session is gated so it delegates instead of authoring code, and
  it is limited by name to the twelve agents it may nest: `blender-worker`,
  `blender-script-runner`, `blender-merger`, `blender-critic`,
  `blender-diagnostician`, `blender-finalizer`, `blender-camera-aligner`,
  `blender-reference-describer`, `blender-composition-planner`,
  `blender-composition-worker`, `blender-composition-critic` and
  `blender-composition-merger`. `blender-camera-aligner` is reachable only
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
  require a window — `blender_set_mode` and `blender_save_view` with
  `source=active-camera` — because both photograph or rearrange what a viewport
  is showing, which has no meaning in a process with no screen. Neither opens
  one. `blender_set_mode` reports `switched: false` with a reason, and
  `blender_save_view` reports `savedView: null` and writes nothing, because a
  viewport mode is a statement about a UI and a view bound to a camera that was
  never created would make every later render through it wrong. An agent can
  report that and carry on; only the user can run `/blender-watch`, and a build
  never waits for one
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

## Development

For development from a clone:

```bash
git clone <this repo's URL>
cd pi-blender
npm install
npm run setup
```

`npm run setup` does everything a fresh clone needs and is safe to re-run:

```text
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

## Verified end-to-end (2026-07-26, Blender 5.2.0 LTS flatpak, pi 0.87.1)

- `/blender` → Blender UI force-launched via `ensureLiveBridgeLaunchedForce()`; first
  `blender_workspace_init` call → open `model.blend` in the live UI
- `blender_execute_python` ran a bpy script in the live session (exit 0, saved)
- `blender_scene_info` returned live objects/cameras
- `blender_render` (live, material-preview, 480x320) wrote `renders/render.png`
