/**
 * pi extension: Blender integration (extracted from pi-blender 0.1.2,
 * repo veoery/BlenderAgent, MIT license).
 *
 * Registers 13 blender_* tools + bundled skills, the /blender and
 * /blender-exit slash commands, and injects the manager prompt + live session
 * context before turns of a MANAGER session.
 *
 * The /blender command session IS the manager: there is no manager subagent, so
 * the user watches the build's todos and progress in the session they typed the
 * command into. The manager prompt lives in blender/agents/blender-manager.md and
 * is read at runtime (config.ts getManagerPrompt) rather than installed as a
 * spawnable agent, so a second, drifting copy cannot exist.
 *
 * Manager mode is entered ONLY by the /blender command — never by a blender_*
 * tool call. It governs the manager prompt, the per-turn live-state snapshot,
 * and the write/edit/image gate. A direct tool call is worker-level work, so it
 * neither injects the prompt nor gets gated; the tools stay usable on
 * their own. Mode ends at /blender-exit (which lifts only this session's gate,
 * not the tools) or on the next session_start, because a session that
 * interleaves Blender with other work would otherwise stay restricted until a
 * /new.
 *
 * The constant manager prompt goes into a `blender` system-prompt section, so it
 * never lands after the user prompt; only the volatile live-state snapshot is
 * appended per turn.
 * The Blender UI is NOT launched at pi/session start. It is launched lazily
 * when the user engages Blender: the /blender command force-launches it via
 * ensureLiveBridgeLaunchedForce(), and any blender_* tool call triggers the
 * lazy ensureLiveBridgeLaunched() path in blender/bridge.ts. Nothing is written
 * under the bridge root before that first launch -- see launch.ts
 * ensureInstanceClaimed.
 *
 * Each pi process gets its OWN bridge dir and therefore its own Blender, so
 * "a Blender that is already up" only ever refers to one this process
 * launched. That is what makes two instances safe to run at once, and it is why
 * a second instance opening the same workspace is refused rather than shared:
 * two UIs on one model.blend overwrite each other on save. See
 * blender/ownership.ts and the loadWorkspaceManifest guard.
 */

import { extname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	blenderSessionContext,
	describeMachineLimits,
	ensureWorkspaceInitialized,
	findNearestWorkspace,
	readRecordedWorkspace,
	formatCompactSessionContextPrompt,
	getBundledBlenderSkillsDir,
	loadWorkspaceManifest,
	LIVE_BRIDGE_COLD_START_TIMEOUT_MS,
	readHeartbeatBlendPath,
	requestLiveBlenderOpenBlend,
	resolveRunBudget,
	WATCH_WINDOW_RSS_BYTES,
} from "./blender/runtime.js";
import { BLENDER_TOOLS } from "./core/tools.js";
import { requestLiveBlenderShutdown } from "./blender/bridge.js";
import { isLiveBridgeAlive, requestWatchWindowLaunch, restartBridgeSupervisor } from "./launch.js";
import { getBlenderBridgeDir, getManagerPrompt } from "./config.js";
import { loadManagerCore } from "./manager-core.js";

/**
 * The shared manager core, or this extension's own copy of it. See
 * manager-core.ts for the resolution order and why it is a runtime lookup.
 */
const core = loadManagerCore();

const LIVE_CONTEXT_PROMPT_TIMEOUT_MS = 1_500;

/**
 * The name pi-subagents stamped into this session's prompt, or null if none.
 *
 * A call to the core rather than a local regex: the child-session stamp is the
 * one signal the whole gate turns on, and a copy of the pattern is a copy of
 * the one thing that must not disagree between the three extensions.
 */
/**
 * Extensions the manager may keep using while file authoring is blocked. These
 * are custom tools (not the built-in `write`/`edit`), so they pass the gate
 * below untouched; the list exists to document the intent and to fail loudly if
 * one of them is ever renamed to a built-in name.
 */
/**
 * The only agents a Blender manager may spawn.
 *
 * `allowedAgents:` in the manager's own frontmatter is already a capability
 * ceiling, but that ceiling is applied when the child is LAUNCHED, so a manager
 * still burns a failed launch discovering the limit. Checking the spawn call
 * itself turns that into an immediate, explanatory refusal, and it also covers
 * a manager that inherited a wider ceiling from a parent session allowing more
 * agents than the Blender roster does.
 *
 * `blender-camera-aligner` is in the list because the hierarchy is FLAT at the
 * top: the /blender command session is the manager and spawns straight down, so
 * the aligner's own nested critics land at depth 3 — exactly the configured
 * `maxSubagentDepth: 3`. It used to be refused here, on the grounds that a
 * manager at the old depth could not afford it; flattening is what made it
 * affordable.
 *
 * `blender-reference-describer` is in the list because it nests nothing: it
 * reads one reference and returns text. It is also load-bearing rather than
 * decorative. A manager has no image input, so the caption
 * it puts in a reference brief is composed from imagination, and a caption
 * wrong about the SUBJECT is the one failure every downstream agent repeats
 * unnoticed — the worker builds the wrong thing well, and the critic compares a
 * correct render against a reference for a different object. Refusing the spawn
 * would force the manager to improvise exactly that caption, so the roster has
 * to permit the agent that reads the image.
 *
 * `blender-script-runner` is in the list because a build fans out to several
 * workers at once, and their SCRIPTS do not share a handle but their RUNS do:
 * all of them execute inside the one live Blender session behind a
 * cross-process lock, so parallel `blender_module_run` calls block each other
 * and then fail on a checkpoint computed against a file that has since been
 * saved. One agent owns that serialization point, and it is the runner, not
 * each worker.
 *
 * `blender-merger` is in the list because joining the finished parts is a
 * distinct job with a distinct failure mode, not a part worker's job: it runs
 * once, late, and it consumes inputs, so its script has to be idempotent in a
 * way no part script needs to be.
 */
const BLENDER_MANAGER_ROSTER = new Set([
	"blender-worker",
	"blender-critic",
	"blender-diagnostician",
	"blender-finalizer",
	"blender-reference-describer",
	"blender-script-runner",
	"blender-merger",
	"blender-camera-aligner",
	// The composition trio. A room is decomposed into CONCERNS (shell,
	// daylight, furniture set) rather than models, so this manager needs an
	// assembler and a room-aware critic as well as the per-model agents. They
	// were advertised in this prompt's allowedAgents and absent from the Set,
	// so the gate refused a delegation pi itself offered and the manager
	// stalled on the exact work these exist for.
	"blender-composition-worker",
	"blender-composition-critic",
	"blender-composition-merger",
	// Read-only, and it runs BEFORE the workers rather than after them. Every
	// other composition agent reacts to geometry that already exists; the three
	// faults this one exists to prevent — a room you cannot enter, furniture
	// blocking the only path, a room that does not do its job — are cheapest to
	// answer on paper and expensive to answer after four modules are built.
	"blender-composition-planner",
]);

/**
 * The manager's own toolkit. The gate is deny-by-default, so a tool missing
 * here is REFUSED, and the refusals below are the only way back in.
 *
 * Kept in lockstep with the `tools:` line in blender/agents/blender-manager.md
 * (line 30) — that line is what pi actually hands the manager, so a tool added
 * there and forgotten here blocks the manager from using its own kit. The
 * installed copy of the prompt keeps the frontmatter even though the injected
 * section strips it, so test/allowlists.mjs compares the two and fails loudly
 * rather than letting them drift.
 *
 * The previous list was `memory_*` and `scratchpad`, neither of which any
 * installed package provides, so the gate refused every tool the manager
 * actually has.
 *
 * The context tools are a different kind of entry from the rest. Everything else
 * here is a tool this repo registers or a package that ships it; `compress` and
 * its siblings come from a plugin the host may or may not have loaded. Listing
 * a tool the session does not have is harmless — a tool call that names an
 * absent tool is never made, and nothing here asserts its existence — while
 * omitting one that IS present is how a manager spends a 100k-context session
 * re-reading a build it already summarized.
 */
const MANAGER_ALLOWED_TOOL_NAMES = new Set([
	// The two halves of waiting: bg_wait blocks on this session's own async
	// runs, subagent_supervisor answers a child that needs a decision. Both
	// belong to pi-subagents, not to an index.ts, so a deny-by-default gate has
	// to name them here.
	"subagent",
	"subagents_enable",
	"bg_wait",
	"subagent_supervisor",
	"contact_supervisor",
	// Context management, from the ambient billion-context plugin (its
	// `pi.extensions` entry registers these with pi, so they are real tools in
	// this session, not an MCP surface). A manager is the one role whose
	// transcript grows without bound: workers and critics each start fresh, but
	// the manager reads every brief, report and verdict for a whole build, and a
	// directed generation run is dozens of modules. It is also the only role that
	// can afford to lose detail, because everything it still needs is in
	// `todo` and in what it wrote down.
	//
	// Listed here because the gate is deny-by-default, and the gate is the only
	// thing between a manager and an unbounded transcript. Named rather than
	// assumed: pi itself ships no compression tool, so these come from the
	// plugin, and the plugin is loaded for the session the same way
	// `ask_user_question` below is.
	"compress",
	"decompress",
	"search_context",
	"acp_status",
	"acp_cache",
	// Planning and reading agent definitions to write a brief with.
	"todo",
	"read",
	"grep",
	"find",
	"ls",
	"ask_user_question",
	// Blender inspection. Read-only: the manager may look, not author.
	"blender_workspace_init",
	"blender_scene_info",
	"blender_add_reference",
	"blender_module_revert",
	"blender_session_context",
	"blender_bridge_status",
	"blender_log_critique",
	"blender_rank_assets",
	"blender_iteration_state",
	// Writing a measured fact back is authoring the loop's memory, not the
	// asset, so the manager may record what its own probes established.
	"blender_record_iteration_fact",
	"blender_export_asset",
]);

/** Image types `read` would attach to the request, mirroring pi's own sniffing. */
const IMAGE_READ_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * The blender_* family, registered inert and declared to the model only when
 * this session shows it needs them: /blender engage, or a first call. Every
 * registerTool above passes defaultActive:false, and this is the list of the
 * same names — one array, because a tool that is inert but not listed here
 * would be unreachable, and one listed here but registered active would cost
 * context every turn again.
 *
 * Kept in lockstep with the registerTool calls by test/registration.test.mjs
 * (see that file): a name on one side and not the other fails the suite.
 *
 * Child sessions are unaffected: pi activates any tool a --tools allowlist
 * names even when it is defaultActive:false, and lazyTools's tool_call
 * handler deliberately does NOT expand a session whose loadout already
 * declares the called tool, so a worker's scoping stays a worker's.
 */
const LAZY_BLENDER_TOOL_NAMES = BLENDER_TOOLS.map((tool) => tool.name);

/**
 * The gate that turns the family on. isEngaged re-arms an engaged session at
 * every turn boundary — the /blender engage may happen between turns, and a
 * session that has engaged must not run a turn without its kit.
 */
const lazyTools = core.createLazyToolGate({
	toolNames: LAZY_BLENDER_TOOL_NAMES,
	isEngaged: () => managerMode.isEngaged(),
});

/**
 * Manager mode, entered ONLY by the /blender command.
 *
 * It governs two things: the workflow guidance, and the write/edit/image gate
 * that enforces that guidance. Neither may be triggered by a blender_* tool
 * call, because a direct tool call is worker-level work — gating a worker
 * because someone ran a tool would be backwards, and turning the parent into a
 * delegating manager the user never asked for would be a surprise.
 *
 * The mechanism is the shared core's, and the three refusals are attached here
 * as a policy callback: which agents a manager may spawn, and which words the
 * refusal uses, are this extension's alone. See pi-manager-core.
 */
const managerMode = core.createManagerMode({
	// The Set is spread rather than passed: the core takes a readonly array,
	// and a Set is an iterable, not one. Spreading here keeps the single
	// declaration below the one place the allowlist is edited.
	allowedTools: [...MANAGER_ALLOWED_TOOL_NAMES],
	// The roster's RULE is the core's; only the names are ours. The local copy
	// of the check was deleted when it moved, because the rule sat behind the
	// allowlist there — and `subagent` is allowlisted, since delegating is the
	// manager's job.
	agentRoster: [...BLENDER_MANAGER_ROSTER],
	onGateMessage: (event) => {
		// Workers are the ones that must be able to write code and look at
		// renders, so the gate applies to the manager session and to no one
		// else — see ManagerMode.isManagerSession.
		if (event.toolName === "write" || event.toolName === "edit") {
			return {
				block: true,
				reason:
					"Manager role: do not author files. This session IS the manager — you were not handed a job to relay — and the subagents you spawn are the ones that do the work. Authoring Blender code, whether a module script or the root script.py, is `blender-worker`'s job: plan the modules, then spawn one per module with a compact brief (goal, module name, object names, acceptance criteria) and read only the reports that come back. A direct approach is a dead end: your `write`/`edit` is blocked for the rest of this manager mode.",
			};
		}

		if (event.toolName === "read") {
			const path = typeof event.input.path === "string" ? event.input.path : "";
			if (IMAGE_READ_EXTENSIONS.has(extname(path).toLowerCase())) {
				return {
					block: true,
					reason:
						"Manager role: do not read images. Judging `modules/<name>/render.png` against the brief is the `blender-critic` subagent's job — spawn a fresh-context critic and let it return a PASS/FAIL verdict with concrete visual issues. Read the returned critique text instead.",
				};
			}
		}

		return null;
	},
});

/**
 * The per-turn injection: the constant manager prompt as a system section, and
 * the live snapshot as a message.
 *
 * The ORDERING and the three rules are the shared core's — see
 * createContextInjection in pi-manager-core for why a constant prompt belongs in
 * a section, why a child must not receive the parent's snapshot, and why a
 * failed fetch must say so loudly rather than inject nothing. What stays here is
 * the Blender-specific half: which categories of state are worth a bridge round
 * trip, and the name of the tool to retry with.
 */
const injectBlenderContext = core.createContextInjection({
	section: "blender",
	customType: "blender_context",
	timeoutMs: LIVE_CONTEXT_PROMPT_TIMEOUT_MS,
	// Manager mode is entered only by the /blender command, never by a
	// blender_* tool call: the manager prompt and its write/edit/image gate
	// describe a task the user explicitly handed to Blender. Injecting the
	// prompt alone never spawns Blender eagerly; the bridge request it makes
	// can still trigger a lazy (re)launch of the UI.
	shouldInject: () => managerMode.isEngaged(),
	getPrompt: getManagerPrompt,
	// Fetched fresh on every injection, so the snapshot can never go stale
	// relative to the turn it describes. The 1.5s budget is Blender's, and
	// differs from Unity's: the Blender bridge shares nothing with a compiling
	// Editor, and a prompt-timeout that eats the user's turn is worse than a
	// snapshot that arrives a beat later.
	fetchState: (ctx) =>
		blenderSessionContext({
			cwd: (ctx as { cwd: string }).cwd,
			include: ["file", "scene", "selection", "mode", "viewport"],
			timeoutMs: LIVE_CONTEXT_PROMPT_TIMEOUT_MS,
		}),
	formatState: (liveContext) => formatCompactSessionContextPrompt(liveContext as Parameters<typeof formatCompactSessionContextPrompt>[0]) ?? "",
	failureGuidance: () => "Call `blender_session_context` before mutating anything, and ask the user if it also fails.",
});

export default function piBlenderExtension(pi: ExtensionAPI) {
	for (const tool of BLENDER_TOOLS) {
		pi.registerTool({
			defaultActive: false,
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				return tool.execute(params, { cwd: ctx.cwd, signal });
			},
		});
	}

		pi.on("resources_discover", () => ({
			skillPaths: [getBundledBlenderSkillsDir()],
		}));

		// Blender engagement is per-session: a fresh session (/new, resume, or
		// fork) must not inherit the guidance-injection flag from a previous
		// one, so it is reset on every session start.
		//
		// Nothing else happens here on purpose. The bridge dir claim and the
		// sibling sweep used to run at session_start, which meant every pi
		// session in the world — including ones that never touch Blender —
		// created a directory under the bridge root and enumerated the others.
		// Both now hang off the first actual launch (see launch.ts
		// ensureInstanceClaimed), because a claim only means something once a
		// UI exists and a sweep only has work to do once instance dirs do.
		pi.on("session_start", (event) => {
			// The reason matters: a /reload keeps this session's manager
			// engagement, every other reason is a genuinely different session and
			// inherits nothing. See createManagerMode's reset().
			managerMode.reset(event?.reason);
			// Same semantics for the lazy tools: a reload keeps an activated
			// family, a fresh session starts with it inert. The gate itself also
			// installs its own session_start handler; this explicit reset keeps
			// the two gates' lifecycle visibly in one place.
			lazyTools.reset(event?.reason);
			// `/reload` re-fires this event, and it is the only lifecycle hook a
			// reload is guaranteed to reach. Re-arming here is what keeps a reload
			// from ending up with two supervisors: whichever module instance is
			// live ends up with exactly one, whether the reload reused this one or
			// built a new one.
			restartBridgeSupervisor();
		});

		// Release this instance's Blender when the PROCESS is ending. Only for
		// reason "quit": "reload", "new", "fork" and "resume" all keep the same
		// process alive with its Blender still wanted, and shutting the UI down
		// there would destroy a session the user is about to continue in.
		//
		// Idempotent and fail-silent by design. This runs during teardown, where
		// a thrown error has nowhere useful to go, and the worst case of every
		// failure here is a Blender window the user closes by hand — which is
		// exactly the situation the next process's reaper also cleans up.
		pi.on("session_shutdown", async (event, ctx) => {
			if (event.reason !== "quit") return;
			// A SUBAGENT must never shut the shared UI down. This is the cause of
			// the "a second Blender appeared over a live one" incident.
			//
			// config.ts deliberately gives every process in one session's
			// delegation tree the SAME instance id, so the manager and each of
			// its workers drive ONE private Blender. The unit of ownership is the
			// SESSION, but the unit of process lifetime is not: pi-subagents runs
			// every subagent as its own node process whose entire life is a single
			// child session, and finishing that session calls session.dispose(),
			// which pi emits as session_shutdown with reason "quit" (see
			// AgentSessionRuntime.dispose in pi-coding-agent, and finish() in
			// pi-subagents src/runs/background/run-child-session.js). So a worker
			// that simply finished its brief tore down the manager's Blender —
			// and because it is a shared dir, the liveness check then correctly
			// reported the bridge dead, the next blender_* call or the 15s
			// supervisor relaunched from blank-bootstrap.py, and the fresh UI came
			// up on the pristine per-instance blank rather than on model.blend.
			// That is the whole chain: the relaunch was never a liveness bug, it
			// was a correct relaunch after a correct shutdown.
			//
			// Only the top-level pi process owns the UI's lifetime. A child leaves
			// it running for whoever is still driving it, and if nobody is, the
			// parent's own quit handler below releases it — or, if the parent
			// died first, the reaper in blender/reap.ts adopts or cleans it up
			// exactly as it did before.
			//
			// Detected the same way the manager gate detects a child turn: the
			// pi-subagents prompt runtime stamps <active_agent name="..."/> into
			// every child system prompt. Every child is exempt from owning the
			// UI's lifetime, whatever it is. Deliberately a TEST and not an
			// isManagerSession() call: manager mode is irrelevant here, and a
			// child of an engaged session must still be exempt.
			if (core.readActiveAgentName(ctx.getSystemPrompt()) !== null) return;
			// A pi that never launched a UI has nothing to release, and asking
			// would cold-launch one purely to shut it down.
			if (!isLiveBridgeAlive()) return;
			try {
				const result = await requestLiveBlenderShutdown({ save: true, timeoutMs: 5_000 });
				if (result.saveError) {
					console.error(
						`[pi-blender] warning: could not save "${result.blendPath ?? "the open blend"}" before quitting Blender: ${result.saveError}`,
					);
				}
			} catch (error) {
				// Never block process exit on a bridge that is already gone.
				console.error(
					`[pi-blender] warning: could not cleanly shut down the live Blender UI: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});

		// Blender UI is NOT launched at pi/session start, by /blender, or by any
		// blender_* tool. A window appears only when the user runs
		// /blender-watch, which is the one authorized spawner (see
		// requestWatchWindowLaunch). Until then the tools work headlessly.

		// /blender engages the extension: everything after the command becomes
		// the Blender task, so no keyword detection of the prompt is needed.
		// Registration, argument handling and the deliverAs choice are the
		// shared core's, because all three manager extensions send the user's
		// text the same way and a `steer` sent to an idle session can interleave
		// ahead of queued work.
		core.registerEngageCommand(pi, {
			name: "blender",
			usage: "<what to build or change in Blender>",
			engagedMessage: "Blender engaged — this session is the manager.",
			onEngage: () => {
				managerMode.markEngaged();
				// The engage command runs outside a turn, so the family must be
				// declared here; the before_agent_start re-arm only fires when a
				// turn starts after this point.
				lazyTools.activate(pi);
			},
		});

		// /blender-watch opens the one windowed Blender this session may have.
		//
		// A plain registerCommand, NOT core.registerEngageCommand: watching is
		// not engaging. It must not mark the session as the manager, and it
		// must not send a user message, because nothing about opening a viewer
		// is a task.
		//
		// At most one per session, and only here. The marker
		// requestWatchWindowLaunch writes is what every other spawn path checks,
		// so "only /blender-watch opens a window" is enforced by the code that
		// would otherwise have to spawn one rather than by each caller's
		// discipline. Other pi instances' windows are deliberately NOT
		// inspected or counted: this session's invariant is about this session.
		pi.registerCommand("blender-watch", {
			description: "Open the one windowed Blender for this session. No argument: the workspace this session has been working in, else the nearest one above the cwd.",
			handler: async (args, ctx) => {
				const workspace = args.trim();
				try {
					// An existing window is reused, never duplicated. With no
					// argument that is the whole answer; with one, the window
					// switches to that workspace's blend, which is still one
					// window rather than a second one.
					const alreadyOpen = isLiveBridgeAlive();
					if (workspace) {
						await ensureWorkspaceInitialized({ cwd: ctx.cwd, workspace, continueExisting: true });
					}
// With no argument, the workspace this session is actually
				// working in is plainly current — which is usually NOT above
				// the cwd, because the manager brief has every agent pass
				// `workspace` explicitly. The recorded workspace is preferred
				// for that reason; the cwd walk is the fallback, and it is the
				// whole answer in a session that only ever opened a workspace by
				// running a tool with an explicit path.
				const recorded = workspace ? undefined : await readRecordedWorkspace();
				const target = workspace || recorded || (await findNearestWorkspace(ctx.cwd));
				if (!target) {
					// Resolved BEFORE any launch, because a window with
					// nothing to show is a 1 GB mistake, not a fallback:
					// an already-open window is left exactly as it is.
					ctx.ui.notify(
						`No blender workspace for this session: none above ${ctx.cwd}, and this session has not opened one. ` +
							`Pass one: /blender-watch <path>.`,
						"warning",
					);
					return;
				}
				const manifest = await loadWorkspaceManifest(ctx.cwd, target);
				if (recorded && !workspace) {
					// Says WHICH rule chose it, because a window that opened the
					// wrong blend is otherwise indistinguishable from a window
					// that opened the right one by accident.
					ctx.ui.notify(
						`Using the workspace this session has been working in: ${manifest.blendPath}`,
						"info",
					);
				}
					// The window is switched, never duplicated, so re-running
					// this is how you return to a workspace after opening
					// another one.
					if (alreadyOpen && readHeartbeatBlendPath(getBlenderBridgeDir()) === manifest.blendPath) {
						ctx.ui.notify(
							`Already watching ${manifest.blendPath} — this session never has more than one window. Pass a workspace to switch it to another blend.`,
							"info",
						);
						return;
					}
					if (!alreadyOpen) await requestWatchWindowLaunch();
					await requestLiveBlenderOpenBlend({ blendPath: manifest.blendPath, timeoutMs: LIVE_BRIDGE_COLD_START_TIMEOUT_MS });
					const budget = resolveRunBudget();
					const { rssBytes } = describeMachineLimits();
					ctx.ui.notify(
						`Watching ${manifest.blendPath}. ` +
							`A windowed Blender costs roughly ${(WATCH_WINDOW_RSS_BYTES / 1024 ** 3).toFixed(1)} GB resident and sits outside the headless budget; ` +
							`${budget.effective} concurrent runs add about ${((budget.effective * rssBytes) / 1024 ** 3).toFixed(1)} GB.` +
							(budget.clamped ? ` ${budget.warning}` : ""),
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`[pi-blender] could not open the watch window: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		// /blender-exit lifts the manager gate without ending the session or
		// touching model.blend. It exists because manager mode otherwise lasts
		// until /new, which breaks a session that interleaves Blender with
		// other work (a Unity bridge, say) needing write/edit.
		core.registerExitCommand(pi, {
			name: "blender-exit",
			description: "Leave Blender manager mode — lift the write/edit/image gate (keeps the session and model.blend)",
			onExit: () => managerMode.clearGate(),
			notEngagedMessage: "Not in Blender manager mode — nothing to exit.",
			exitedMessage:
				"Left Blender manager mode. The blender_* tools, /blender and the skills are still available; run /blender to re-enter.",
		});

		// Manager-role enforcement: this session plans and delegates, the
		// `blender-worker` subagents author and run module code, and the
		// `blender-critic` subagents judge renders. This gate makes that
		// structural instead of advisory — without it the manager drifts into
		// doing everything itself and burns its context on module source.
		//
		// Blocked in the manager: every `write`/`edit`, and `read` of an image
		// (judging renders is the critic's job, and images are the most
		// context-expensive thing in the loop). Allowed in the manager: text
		// reads including `*.md` (skill and agent definitions are needed to
		// write a worker's brief), `bash`, and the pi-memory tools.
		//
		// Gated on managerMode, not on any blender_* tool having run: the manager
		// role exists only after /blender. A session that calls a blender_* tool
		// directly is doing worker-level work, and blocking its writes would be
		// backwards.
		//
		// The gate's MECHANISM — engaged flag, and the exemption for a subagent
		// inside a manager session — is installed from the shared core, which all
		// three manager extensions use. The three refusals below stay here,
		// because each names an agent only this manager can spawn.
		managerMode.install(pi);
		lazyTools.install(pi);

		pi.on("before_agent_start", injectBlenderContext);
};

