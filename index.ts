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
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	blenderAddReference,
	blenderBranchApply,
	blenderBranchRun,
	blenderBridgeStatus,
	blenderExecutePython,
	blenderGeometryProbe,
	blenderImageProbe,
	blenderLogCritique,
	blenderRankAssets,
	blenderIterationState,
	blenderRecordIterationFact,
	blenderExportAsset,
	blenderImportAsset,
	blenderModuleRevert,
	blenderModuleRun,
	blenderMontage,
	blenderReadOnlyPython,
	blenderRender,
	blenderSaveView,
	blenderSceneInfo,
	blenderObjectDetail,
	blenderSessionContext,
	blenderSetMode,
	blenderWindowLayout,
	blenderSwitchWorkspace,
	blenderFocusView,
	blenderWorkspaceInit,
	blenderGetPythonApiDocs,
	blenderSearchApiDocs,
	blenderSearchManualDocs,
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
import type { AssetExportOptions, ImportFormat } from "./blender/types.js";
import { isLiveBridgeAlive } from "./launch.js";
import { blenderCompare } from "./blender/compare.js";
import { requestLiveBlenderShutdown } from "./blender/bridge.js";
import { requestWatchWindowLaunch, restartBridgeSupervisor } from "./launch.js";
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
	"blender_object_detail",
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
	"blender_search_api_docs",
	"blender_search_manual_docs",
	"blender_get_python_api_docs",
	"blender_window_layout",
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
const LAZY_BLENDER_TOOL_NAMES = [
	"blender_workspace_init",
	"blender_execute_python",
	"blender_session_context",
	"blender_scene_info",
	"blender_object_detail",
	"blender_save_view",
	"blender_render",
	"blender_module_run",
	"blender_branch_run",
	"blender_branch_apply",
	"blender_module_revert",
	"blender_set_mode",
	"blender_log_critique",
	"blender_rank_assets",
	"blender_iteration_state",
	"blender_record_iteration_fact",
	"blender_export_asset",
	"blender_import_asset",
	"blender_add_reference",
	"blender_bridge_status",
	"blender_geometry_probe",
	"blender_image_probe",
	"blender_read_only_python",
	"blender_montage",
	"blender_compare",
	"blender_search_api_docs",
	"blender_search_manual_docs",
	"blender_get_python_api_docs",
	"blender_window_layout",
	"blender_switch_workspace",
	"blender_focus_view",
];

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

function formatJsonResult(value: unknown): string {
	return JSON.stringify(value, null, 2);
}


export default function piBlenderExtension(pi: ExtensionAPI) {
		pi.registerTool({
			defaultActive: false,
			name: "blender_workspace_init",
			label: "Blender Workspace Init",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				"Create or reopen a managed Blender workspace with a persistent model.blend and workspace manifest, and auto-open that blend in the live Blender session when available.",
			parameters: Type.Object({
				workspace: Type.Optional(
					Type.String({
						description: "Explicit workspace path. Relative paths resolve from the current working directory.",
					}),
				),
				sourceBlend: Type.Optional(
					Type.String({
						description: "Optional source .blend file to copy into the workspace as the starting model.blend.",
					}),
				),
				template: Type.Optional(
					Type.Union(
						[
							Type.Literal("studio"),
							Type.Literal("blank"),
						],
						{
							description:
								'Workspace template. "studio" (recommended) starts an empty file with a camera, a three-point light rig, a neutral world and EEVEE at 1200x900, so the first worker can model immediately instead of building a shot first. "blank" saves Blender\'s startup file as-is, with no camera or lights. Ignored when sourceBlend is given, since the source scene brings its own setup.',
							default: "studio",
						},
					),
				),
				continueExisting: Type.Optional(
					Type.Boolean({
						description: "When true, require the workspace to exist already instead of creating a new one.",
						default: false,
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderWorkspaceInit({
					cwd: ctx.cwd,
					workspace: params.workspace,
					sourceBlend: params.sourceBlend,
					template: params.template,
					continueExisting: params.continueExisting,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_execute_python",
			label: "Blender Execute Python",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Copy a Blender Python script into a run directory, execute it inside the live bridge-enabled Blender session for the workspace, and persist the updated model.blend so the UI stays in sync. By default the run claims a numbered iteration slot; pass claimIteration=false for throwaway runs so it does not count as progress.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				script_path: Type.String({
					description:
						"Path to the existing Blender Python script to snapshot and execute. Use the workspace root script.py.",
				}),
				saveBefore: Type.Optional(
					Type.Boolean({
						description: "If true, copy the current model.blend into the iteration folder before execution.",
						default: false,
					}),
				),
				saveAfter: Type.Optional(
					Type.Boolean({
						description: "If true, save the updated Blender scene back to model.blend after execution.",
						default: true,
					}),
				),
				claimIteration: Type.Optional(
					Type.Boolean({
						description:
							"If false, run without claiming a numbered iteration_NN slot — the copied script and log still go to a private runs/ad-hoc/<id>/ directory, so nothing clobbers, but the run does not advance latestIteration. Use false for throwaway work such as a camera nudge or a one-off inspection, and true (the default) for a change you would describe as progress. Claiming every ad-hoc run makes the iteration numbers in critique.log stop corresponding to anything readable.",
						default: true,
					}),
				),
				timeoutSeconds: Type.Optional(
					Type.Number({
						description: "Execution timeout in seconds.",
						default: 120,
					}),
				),
				label: Type.Optional(
					Type.String({
						description: "Optional label for the iteration step.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderExecutePython({
					cwd: ctx.cwd,
					workspace: params.workspace,
					script_path: params.script_path,
					saveBefore: params.saveBefore,
					saveAfter: params.saveAfter,
					claimIteration: params.claimIteration,
					timeoutSeconds: params.timeoutSeconds,
					label: params.label,
					signal,
					});

						return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_session_context",
			label: "Blender Session Context",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				"Read the LIVE Blender session: the open blend path, active scene, current mode, active object, selected objects, viewport state, unsaved changes, and whether another pi session holds the same blend. This is the only source of truth for present-tense Blender state — for 'what is selected', 'update it', 'render from what I'm looking at', or any claim about what Blender currently shows. `blender_scene_info` is NOT that: it reads the last SAVED blend file, so it never sees a worker's in-flight edits or a change made by hand and not saved. Call it before mutating anything. Read-only by construction (see docs/SAFETY.md for full guarantee boundary).",
			parameters: Type.Object({
				workspace: Type.Optional(
					Type.String({
						description:
							"Optional workspace path to compare against the live Blender session. Relative paths resolve from the current working directory.",
					}),
				),
				include: Type.Optional(
					Type.Array(
						Type.Union([
							Type.Literal("file"),
							Type.Literal("scene"),
							Type.Literal("selection"),
							Type.Literal("mode"),
							Type.Literal("viewport"),
						]),
						{
							description:
								"Optional live session categories to include. Omit to return the full live Blender session context.",
							uniqueItems: true,
						},
					),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderSessionContext({
					cwd: ctx.cwd,
					workspace: params.workspace,
					include: params.include,
					signal,
					});

						return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_window_layout",
			label: "Blender Window Layout",
			description:
				"Read the live Blender UI window layout, screens, areas, space types, active object, and selection as JSON (zero image token cost), or capture a byte-capped screenshot downscaled with system pixel_size awareness. Any screenshot capture is byte-capped at 500 KB (512,000 bytes) and downscaled honoring context.preferences.system.pixel_size. Window-only: reports layout: null and captured: false with a reason instead of failing when no watch window is open.",
			annotations: {
				// Not read-only: screenshot mode writes a PNG to a caller-supplied
				// output_path (blender/live-bridge.py:836). Claiming read-only here
				// would let pi skip the confirmation prompt for a filesystem write.
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			parameters: Type.Object({
				workspace: Type.Optional(
					Type.String({
						description:
							"Optional workspace path for the Blender task. Relative paths resolve from the current working directory.",
					}),
				),
				format: Type.Optional(
					Type.Union([Type.Literal("json"), Type.Literal("image")], {
						description:
							"Output format: 'json' for zero-cost layout description (default), or 'image' for a byte-capped screenshot.",
					}),
				),
				screenshot: Type.Optional(
					Type.Boolean({
						description:
							"Whether to capture a screenshot (default false). When true, downscales and byte-caps the image at 500 KB.",
					}),
				),
				as_image: Type.Optional(
					Type.Boolean({
						description: "Alias for screenshot: true.",
					}),
				),
				as_json: Type.Optional(
					Type.Boolean({
						description:
							"Return layout and selection as JSON only, asserting no image payload (default true).",
					}),
				),
				area_type: Type.Optional(
					Type.String({
						description:
							"Optional Blender area type to screenshot (e.g. 'VIEW_3D', 'OUTLINER', 'PROPERTIES'). If omitted or 'window', captures the entire window.",
					}),
				),
				max_bytes: Type.Optional(
					Type.Number({
						description:
							"Maximum file size in bytes for the downscaled screenshot (default 512,000 = 500 KB).",
					}),
				),
				output_path: Type.Optional(
					Type.String({
						description: "Optional file path where the screenshot PNG will be written.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderWindowLayout({
					cwd: ctx.cwd,
					workspace: params.workspace,
					format: params.format,
					screenshot: params.screenshot,
					as_image: params.as_image,
					as_json: params.as_json,
					area_type: params.area_type,
					max_bytes: params.max_bytes,
					output_path: params.output_path,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_scene_info",
			label: "Blender Scene Info",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
'Read the workspace blend file as it was last SAVED, and return its structure: scene content (objects, collections, materials, cameras, lights, render settings, UVs, armatures, textures, paint settings), single-object detail (object_detail), or file health (missingFiles, linkedLibraries). Nothing unsaved in the open Blender is visible here — a worker\'s in-flight edits are not on disk yet, and a session that has changed something by hand has not saved it. This is the right tool for the SAVED STATE of a build ("what objects exist", "what materials are assigned"), for per-object detail ("what is this object\'s transform, parent, modifiers"), and for file-health diagnostics ("is this file broken", missing external asset files, direct and indirect linked library trees). For what the UI currently shows — the open file, the selection, the mode, the viewport, unsaved changes, or another session holding the same blend — use `blender_session_context`, which reads the live Blender and is the only source of truth for present-tense state. Prefer a narrow `categories` list such as `["objects"]`, `["materials"]`, `["cameras", "cameraSettings"]`, `["object_detail"]`, or `["missingFiles", "linkedLibraries"]` when you only need one or a few sections. Omit `categories` only when you truly need the full scene info payload. Read-only by construction (see docs/SAFETY.md for full guarantee boundary).',
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				categories: Type.Optional(
					Type.Array(
						Type.Union([
							Type.Literal("objects"),
							Type.Literal("collections"),
							Type.Literal("materials"),
							Type.Literal("cameras"),
							Type.Literal("cameraSettings"),
							Type.Literal("lights"),
							Type.Literal("views"),
							Type.Literal("renderSettings"),
							Type.Literal("uv"),
							Type.Literal("armatures"),
							Type.Literal("textures"),
							Type.Literal("paintSettings"),
							Type.Literal("object_detail"),
							Type.Literal("missingFiles"),
							Type.Literal("linkedLibraries"),
						]),
						{
							description:
								"Optional scene info categories to inspect. Pass one category to inspect only that section, or pass a short list for a subset. For paint/UV/rig work add `uv`, `textures`, `armatures`, and `paintSettings`. For single object detail add `object_detail` (requires `targetObject`). For blend-file health diagnostics without opening a window, add `missingFiles` (external references missing from disk) and `linkedLibraries` (direct and indirect linked library tree). Content categories describe what is inside the scene; file-health categories report whether external references and link trees on disk are intact. These all describe the last SAVED blend file, not live UI state. Omit `categories` only when you need all available scene info sections.",
							uniqueItems: true,
						},
					),
				),
				targetObject: Type.Optional(
					Type.String({
						description:
							"Optional target object name when inspecting object detail in the saved blend file.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderSceneInfo({
					cwd: ctx.cwd,
					workspace: params.workspace,
					categories: params.categories,
					targetObject: params.targetObject,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_object_detail",
			label: "Blender Object Detail",
			description:
				'Read the workspace blend file as it was last SAVED, and return detailed inspection data for a single object: transforms (with non-uniform scale flag), modifier stack (marking viewport-disabled modifiers), material slots, mesh counts (vertices, edges, polygons/faces), parent and child relationships, and orphan/unlinked-to-scene status. Does not pull the entire scene; payload is bounded to the specified object. Reads the saved blend file headlessly, matching blender_scene_info.',
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				objectName: Type.Optional(
					Type.String({
						description:
							"Name of the object in the saved blend file to inspect.",
					}),
				),
				targetObject: Type.Optional(
					Type.String({
						description:
							"Alias for objectName. Name of the object in the saved blend file to inspect.",
					}),
				),
				name: Type.Optional(
					Type.String({
						description:
							"Alias for objectName. Name of the object in the saved blend file to inspect.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const objectName = params.objectName ?? params.targetObject ?? params.name;
				if (!objectName) {
					throw new Error("objectName (or targetObject, name) is required for blender_object_detail.");
				}
				const result = await blenderObjectDetail({
					cwd: ctx.cwd,
					workspace: params.workspace,
					objectName,
					targetObject: params.targetObject,
					name: params.name,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_save_view",
			label: "Blender Save View",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				"Save a named render view in the workspace manifest. With source=active-camera, capture the current live Blender UI viewport into a dedicated camera object; otherwise bind the view to an existing camera object. source=active-camera photographs what the UI currently shows, including unsaved edits, so with no window open it reports savedView:null with a reason rather than failing — binding the view to a camera name works headlessly and is the right source when there is no window. Nothing is written to the manifest when the capture is skipped, so a later render cannot pick up a view bound to a camera that was never created.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				name: Type.String({
					description: "Saved view name to store in the workspace manifest.",
				}),
				source: Type.String({
					description:
						'Either "active-camera" to capture the current Blender UI view, or a camera object name already present in the scene.',
				}),
				camera_name: Type.Optional(
					Type.String({
						description:
							'Optional dedicated camera object name to use when source is "active-camera". Defaults to the saved view name.',
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderSaveView({
					cwd: ctx.cwd,
					workspace: params.workspace,
					name: params.name,
					source: params.source,
					camera_name: params.camera_name,
					signal,
					});

						return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_render",
			label: "Blender Render",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Render the workspace blend file and write outputs into the current iteration. Use renderMethod=`live` for viewport renders and renderMethod=`background` for normal headless scene renders. Live renders default to camera-based framing with viewportShading=`material-preview`; switch to viewSource=`current-view` only when the user explicitly wants the raw current viewport. Live viewport renders disable overlays automatically so grids, axes, and other viewport clutter are not captured. Background renders are camera-based and use renderEngine overrides such as `eevee`, `cycles`, or `workbench` instead of viewport shading modes.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				view: Type.Optional(
					Type.String({
						description: 'Optional saved view name, camera name, or "active-camera".',
					}),
				),
				resolution: Type.Optional(
					Type.Object({
						x: Type.Number(),
						y: Type.Number(),
						percentage: Type.Optional(Type.Number()),
					}),
				),
				samples: Type.Optional(
					Type.Number({
						description: "Optional Cycles sample count override.",
					}),
				),
				outputName: Type.Optional(
					Type.String({
						description: "Output image file name. Defaults to render.png.",
					}),
				),
				renderMethod: Type.Optional(
					Type.Union([Type.Literal("live"), Type.Literal("background")], {
						description:
							"How to execute the render. `live` uses the open Blender UI viewport. `background` uses a headless scene render. Defaults to `live`.",
						default: "live",
					}),
				),
				viewSource: Type.Optional(
					Type.Union([Type.Literal("camera"), Type.Literal("current-view")], {
						description:
							"How to choose the framing. `camera` uses the saved view, explicit camera, or active camera. `current-view` uses the raw current viewport in the live Blender UI. Defaults to `camera`.",
						default: "camera",
					}),
				),
				viewportShading: Type.Optional(
					Type.Union(
						[
							Type.Literal("wireframe"),
							Type.Literal("solid"),
							Type.Literal("material-preview"),
							Type.Literal("rendered"),
						],
						{
							description:
								"Viewport shading mode for live renders only. Defaults to `material-preview`. `solid` uses Workbench-style viewport shading. `rendered` uses the scene render engine interactively.",
							default: "material-preview",
						},
					),
				),
				renderEngine: Type.Optional(
					Type.Union([Type.Literal("eevee"), Type.Literal("cycles"), Type.Literal("workbench")], {
						description:
							"Optional render engine override for background renders only. Omit to keep the scene's current engine.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderRender({
					cwd: ctx.cwd,
					workspace: params.workspace,
					view: params.view,
					resolution: params.resolution,
					samples: params.samples,
					outputName: params.outputName,
					renderMethod: params.renderMethod,
					viewSource: params.viewSource,
					viewportShading: params.viewportShading,
					renderEngine: params.renderEngine,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_module_run",
			label: "Blender Module Run",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Run a workspace module: checkpoint model.blend to modules/<name>/runs/NN/pre-NN.blend, execute modules/<name>/script.py, save the result, and optionally capture a render to modules/<name>/render.png for critique. The run is recorded in the workspace manifest (moduleRuns), so blender_module_revert knows exactly which state it restores. Use one module per object or concern in multi-part tasks. With a window open it runs in the live session (executionMode \"live-session\"); with none, it runs HEADLESSLY against a branch copy and merges the result back (executionMode \"headless-apply\"), which is the normal case since /blender no longer opens a window. Prefer blender_branch_run + blender_branch_apply when you want to author several modules against the same state and merge them in one pass. A headless run reports stateDigest — a content hash of the objects this module owns — plus unchangedSinceLastRun, which is true when the previous run of this module produced the same digest. An iteration that changed nothing produces the same render as the last one, so re-rendering and re-critiquing it buys a verdict you already have: read that flag before spending a critic.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				moduleName: Type.String({
					description:
						"Module name (lowercase letters, digits, dashes). Resolves to modules/<name>/script.py.",
				}),
				render: Type.Optional(
					Type.Boolean({
						description: "Capture a live camera render to modules/<name>/render.png after the run.",
						default: true,
					}),
				),
				view: Type.Optional(
					Type.String({
						description:
						'Optional saved view name, camera object name, or "active-camera" to render from. Defaults to the active camera.',
					}),
				),
				viewportShading: Type.Optional(
					Type.Union(
						[
							Type.Literal("wireframe"),
							Type.Literal("solid"),
							Type.Literal("material-preview"),
							Type.Literal("rendered"),
						],
						{
							description: "Viewport shading for the module render. Defaults to material-preview.",
						},
					),
				),
				resolution: Type.Optional(
					Type.Object({
						x: Type.Number({ description: "Render width in pixels." }),
						y: Type.Number({ description: "Render height in pixels." }),
						percentage: Type.Optional(Type.Number({ description: "Resolution percentage (default 100)." })),
					}),
				),
				samples: Type.Optional(
					Type.Number({
						description: "Sample count override for Cycles renders.",
					}),
				),
				timeoutSeconds: Type.Optional(
					Type.Number({
						description: "Execution timeout in seconds.",
						default: 120,
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderModuleRun({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
					render: params.render,
					view: params.view,
					viewportShading: params.viewportShading,
					resolution: params.resolution,
					samples: params.samples,
					timeoutSeconds: params.timeoutSeconds,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_branch_run",
			label: "Blender Branch Run",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
			description:
				"Run a workspace module HEADLESSLY against its own private copy of model.blend (modules/<name>/branch.blend), then stage the result for a later blender_branch_apply. No live Blender session is touched and no bridge lock is taken, so several modules can run at once — the concurrency ceiling is the headless run budget, not the one live session. Reports exactly which objects and materials the script changed, which is what the apply uses to bring back only this module's work instead of reverting its siblings'. A failed run leaves model.blend untouched and there is nothing to revert.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				moduleName: Type.String({
					description:
						"Module name (lowercase letters, digits, dashes). Resolves to modules/<name>/script.py.",
				}),
				render: Type.Optional(
					Type.Boolean({
						description: "Render the BRANCH (not model.blend) to modules/<name>/render.png for critique. Defaults to true.",
						default: true,
					}),
				),
				view: Type.Optional(
					Type.String({
						description:
							'Optional saved view name, camera object name, or "active-camera" to render from. Defaults to the active camera.',
					}),
				),
				resolution: Type.Optional(
					Type.Object({
						x: Type.Number({ description: "Render width in pixels." }),
						y: Type.Number({ description: "Render height in pixels." }),
						percentage: Type.Optional(Type.Number({ description: "Resolution percentage (default 100)." })),
					}),
				),
				samples: Type.Optional(
					Type.Number({
						description: "Sample count override for Cycles renders.",
					}),
				),
				timeoutSeconds: Type.Optional(
					Type.Number({
						description: "Execution timeout in seconds.",
						default: 300,
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderBranchRun({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
					render: params.render,
					view: params.view,
					resolution: params.resolution,
					samples: params.samples,
					timeoutSeconds: params.timeoutSeconds,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_branch_apply",
			label: "Blender Branch Apply",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Apply staged branch runs into model.blend, one at a time under a lock, so concurrent module runs can be merged in a fixed order. A module whose datablocks are contested by another STAGED branch is REPORTED AND SKIPPED, never auto-merged: its changes stay in its own branch blend and the apply says which modules and which object conflicted, because silently picking a winner is how a half-built asset gets presented as finished. Each successful apply is recorded as a module run, so blender_module_revert can restore the state it replaced.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				modules: Type.Array(Type.String(), {
					description:
						"Module names to apply, in any order — they are applied in the order their branch runs were staged. Every one must have a staged branch run.",
				}),
				timeoutSeconds: Type.Optional(
					Type.Number({
						description: "Per-apply timeout in seconds.",
						default: 300,
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderBranchApply({
					cwd: ctx.cwd,
					workspace: params.workspace,
					modules: params.modules,
					timeoutSeconds: params.timeoutSeconds,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_module_revert",
			label: "Blender Module Revert",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Revert model.blend to a module's recorded pre-run checkpoint and reload it in the live Blender session. Uses the manifest's moduleRuns history, so it reverts the exact state before that run. Refuses when later module runs also modified the blend (pass force: true to accept discarding them). The reload DISCARDS any unsaved changes currently open in the live Blender UI, so save unrelated work in the UI before reverting.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				moduleName: Type.String({
					description: "Module name to revert.",
				}),
				iteration: Type.Optional(
					Type.Number({
						description:
							"Revert this specific recorded run instead of the module's latest one.",
					}),
				),
				force: Type.Optional(
					Type.Boolean({
						description:
							"Allow the revert even though later module runs also mutated the blend.",
						default: false,
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderModuleRevert({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
					iteration: params.iteration,
					force: params.force,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_set_mode",
			label: "Blender Set Mode",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				"Switch the live Blender viewport/object mode for a workspace blend, enabling texture paint, vertex/weight/face paint, sculpt, pose, edit-armature, or UV editing. Supported modes: OBJECT, POSE, EDIT_MESH, EDIT_ARMATURE, SCULPT, TEXTURE_PAINT, VERTEX_PAINT, WEIGHT_PAINT, FACE_PAINT, and UV (enters edit mode and turns on the viewport UV editor overlay). Paint modes require a MESH object, POSE/EDIT_ARMATURE require an ARMATURE object. Use this before/after authoring paint or rig changes in script.py so the user sees the correct workspace in the live UI. A viewport mode is a statement about a UI, so with no window open this reports switched:false and a reason instead of failing: the paint is applied as bpy data either way and nothing about the asset depends on this. Authoring does not need a window — blender_module_run and blender_branch_run work headlessly.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				mode: Type.Union(
					[
						Type.Literal("OBJECT"),
						Type.Literal("POSE"),
						Type.Literal("EDIT_MESH"),
						Type.Literal("EDIT_ARMATURE"),
						Type.Literal("SCULPT"),
						Type.Literal("TEXTURE_PAINT"),
						Type.Literal("VERTEX_PAINT"),
						Type.Literal("WEIGHT_PAINT"),
						Type.Literal("FACE_PAINT"),
						Type.Literal("UV"),
					],
					{
						description:
							"Target viewport/object mode. UV enters edit mode with the UV editor overlay enabled.",
					},
				),
				objectName: Type.Optional(
					Type.String({
						description:
								"Optional object to act on. Defaults to the active object. Paint modes need a MESH, POSE/EDIT_ARMATURE need an ARMATURE.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderSetMode({
					cwd: ctx.cwd,
					workspace: params.workspace,
					mode: params.mode,
					objectName: params.objectName,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_switch_workspace",
			label: "Blender Switch Workspace",
			description:
				"Switch the active workspace tab in the live Blender window by workspace name (e.g. 'Layout', 'Modeling', 'Sculpting', 'UV Editing', 'Shading', 'Animation', 'Rendering', 'Compositing', 'Geometry Nodes', 'Scripting') or by contained editor space_type (e.g. 'VIEW_3D', 'NODE_EDITOR', 'IMAGE_EDITOR', 'SEQUENCE_EDITOR'). This changes what editor and layout the user is currently looking at in the live UI. Window-only: this is a statement about the live UI window, so when no /blender-watch window is open this reports switched: false with an explicit reason rather than throwing.",
			annotations: {
				// Changes what the live UI is showing, but writes no files and
				// touches no blend data: the scene itself is unmodified.
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				workspaceName: Type.Optional(
					Type.String({
						description:
							"Name of workspace tab to switch to (e.g. 'Layout', 'Modeling', 'Shading', 'Geometry Nodes', 'Scripting').",
					}),
				),
				spaceType: Type.Optional(
					Type.String({
						description:
							"Editor space type to switch to (e.g. 'VIEW_3D', 'NODE_EDITOR', 'IMAGE_EDITOR', 'SEQUENCE_EDITOR'). Finds the first workspace containing an area of this type.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderSwitchWorkspace({
					cwd: ctx.cwd,
					workspace: params.workspace,
					workspaceName: params.workspaceName,
					spaceType: params.spaceType,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_focus_view",
			label: "Blender Focus View",
			description:
				"Center and frame the 3D viewport on a named object in the live Blender window. Focuses the view on the object's geometry (view_selected). Window-only: this is a statement about the live 3D viewport, so when no /blender-watch window is open this reports moved: false with an explicit reason rather than throwing.",
			annotations: {
				// Changes what the live UI is showing, but writes no files and
				// touches no blend data: the scene itself is unmodified.
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				objectName: Type.String({
					description: "Name of the target object (or object data) to frame and focus in the 3D viewport.",
				}),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderFocusView({
					cwd: ctx.cwd,
					workspace: params.workspace,
					objectName: params.objectName,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_log_critique",
			label: "Blender Log Critique",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description:
				"Append a structured critique entry to the workspace critique.log using the 0-12 Blender iteration rubric: five 0-2 craft axes plus a 0-2 category-validity axis, a 0-2 view adequacy that gates whether the judgement counts at all, and an optional rejectReason. Resolves a verdict (continue / present / reject) and records it, so blender_rank_assets can select across a batch without re-reading prose.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				moduleName: Type.String({
					description:
						"The module this critique judged. Names the part the render shows, and keeps each module's 5-iteration budget its own rather than shared across a fan-out.",
				}),
				iteration: Type.Optional(
					Type.Number({
						description:
							"Optional iteration number, for a run whose number differs from the workspace's latest. Omit it and the latest is used.",
					}),
				),
				accuracy: Type.Number({
					description: "Accuracy score from 0 to 2.",
					minimum: 0,
					maximum: 2,
				}),
				geometry: Type.Number({
					description: "Geometry and proportions score from 0 to 2.",
					minimum: 0,
					maximum: 2,
				}),
				materials: Type.Number({
					description: "Materials and appearance score from 0 to 2.",
					minimum: 0,
					maximum: 2,
				}),
				completeness: Type.Number({
					description: "Completeness score from 0 to 2.",
					minimum: 0,
					maximum: 2,
				}),
				quality: Type.Number({
					description: "Quality score from 0 to 2.",
					minimum: 0,
					maximum: 2,
				}),
				validity: Type.Number({
					description:
						"Is this a valid instance of the CATEGORY at all -- does it read as a mug, not as a well-formed object carrying a brief's worth of mug features? Separate from accuracy, which asks whether it matches its brief. Zero means the category is not satisfied, and no amount of polish recovers that.",
					minimum: 0,
					maximum: 2,
				}),
				viewAdequacy: Type.Number({
					description:
						"Can the asset be judged FROM this render? 2 = the whole subject and its silhouette are visible, 1 = partly occluded or ambiguous, 0 = the render does not show the subject. Scored because it gates the JUDGEMENT, not the asset: an ugly render of a good mesh is still a good sample, but a render that cannot show the object makes every other score meaningless, so an unusable view never presents.",
					minimum: 0,
					maximum: 2,
				}),
				viewNote: Type.String({
					description: "Free text on the framing, coverage, or perspective, kept because the score cannot say why.",
				}),
				issues: Type.Array(
					Type.String({
							description: "Concrete problems found in the current render or scene.",
					}),
				),
				nextAction: Type.String({
					description: 'Either a fix to attempt next, or "present to user" when the result is good enough.',
				}),
				rejectReason: Type.Optional(
					Type.String({
						description:
							"Reject the asset outright, whatever it scored. Use this when the ATTEMPT was wrong -- the category is unsatisfiable from this brief, or the structure is fundamentally not what was asked for -- rather than merely unpolished. Distinct from a low score on purpose: a scored failure is a finished attempt worth keeping the record of, and this says it should never have been made.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderLogCritique({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
					iteration: params.iteration,
					accuracy: params.accuracy,
					geometry: params.geometry,
					materials: params.materials,
					completeness: params.completeness,
					quality: params.quality,
					validity: params.validity,
					viewAdequacy: params.viewAdequacy,
					viewNote: params.viewNote,
					issues: params.issues,
					nextAction: params.nextAction,
					rejectReason: params.rejectReason,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_rank_assets",
			label: "Blender Rank Assets",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"Rank a batch against ITSELF and return the best slice. An absolute threshold can say whether an asset is good enough; it can never say whether it is the best of a thousand, and the gap between the 60th and 95th percentile is invisible to a rubric that only ever sees one asset at a time. Reads critique.log's STRUCTURE (never its prose), keeps each module's latest judgement, ranks only presented assets judged from a usable view, and returns the top fraction best-first plus per-verdict counts and batch-level warnings. Use this before shipping a batch for training or curation: when rejects outnumber presents, the brief is usually wrong rather than the assets.",
			parameters: Type.Object({
				workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
				topFraction: Type.Optional(
					Type.Number({
						description:
							"Fraction of ELIGIBLE assets to keep, 0..1, default 0.1. A batch of 100 with a 0.1 slice returns the best 10. Always at least one asset is kept, so a batch of 3 returns its best rather than nothing.",
					}),
				),
				minScore: Type.Optional(
					Type.Number({
						description:
							"Score an asset must reach before it may be ranked at all, default 0. The verdict already gates on the present threshold; raise this only to keep borderline-but-presented assets out of a slice.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderRankAssets({
					cwd: ctx.cwd,
					workspace: params.workspace,
					topFraction: params.topFraction,
					minScore: params.minScore,
				});

				const lines = [
					`${result.selected.length} of ${result.eligible} eligible asset(s), top ${Math.round(result.topFraction * 100)}%:`,
					...result.selected.map(
						(asset) => `  ${asset.rank}. ${asset.moduleName} — ${asset.score}/12, validity ${asset.validity}/2 (${Math.round(asset.relativeScore * 100)}% of best)`,
					),
					`Verdicts: ${result.counts.present} present, ${result.counts.reject} reject, ${result.counts.continue} mid-iteration`,
					...result.warnings.map((warning) => `Warning: ${warning}`),
				];

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_iteration_state",
			label: "Blender Iteration State",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"What this module's iteration loop already knows, derived from the manifest and critique.log rather than from anyone's memory. Read it BEFORE spending a run or a fresh critic: it reports the per-module iteration budget, the last run and its content digest, the last verdict and score, whether the last briefed fix actually changed the content, the probe facts already recorded, and a waste guard that names the specific condition under which another render would tell you nothing new. A loop that has lost its budget to a context fold is a loop that runs forever; this is where the budget lives. Read-only.",
			parameters: Type.Object({
				workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
				moduleName: Type.String({
					description:
						"The module to report on. One model's history cannot be summarised for all of them, and the budget, digest and waste guard are all per-module.",
				}),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderIterationState({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
				});

				const lines = [
					`${result.module}: budget ${result.budget.used}/${result.budget.max} (${result.budget.exhausted ? "exhausted" : `${result.budget.remaining} left`}), present at ${result.presentThreshold}/12`,
					result.lastRun
						? `Last run: iteration ${result.lastRun.iteration} (${result.lastRun.executionMode}${result.lastRun.stateDigest ? `, digest ${result.lastRun.stateDigest.slice(0, 8)}` : ", no digest"})`
						: "Last run: none recorded.",
					result.lastVerdict
						? `Last verdict: ${result.lastVerdict.verdict} at ${result.lastVerdict.score}/12${result.lastVerdict.viewUsable ? "" : " (view unusable — the judgement did not gate anything)"}${result.lastVerdict.rejectReason ? ` — ${result.lastVerdict.rejectReason}` : ""}`
						: "Last verdict: never critiqued.",
					`Fix landed: ${result.fixLanded === undefined ? "unknown (no paired digests)" : result.fixLanded ? "yes" : "NO — the content did not move"}`,
					`Waste guard: ${result.wasteGuard.kind} — ${result.wasteGuard.detail}`,
				];
				for (const fact of result.knownFacts) {
					lines.push(`Known: ${fact.statement} (${fact.source}${fact.iteration ? `, iteration ${fact.iteration}` : ""})`);
				}

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_record_iteration_fact",
			label: "Blender Record Iteration Fact",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"Persist one MEASURED fact about this module so it survives the critic that measured it, a context fold, and a crash. A fact without a record is re-measured by every fresh critic, which is how a loop spends three renders learning that the handle is the wrong thickness. Record what the probe actually returned and the tool that returned it, so the next critic can re-check the number rather than trusting a sentence. Re-recording the same statement updates it rather than duplicating it; the newest 24 facts per module are kept. Read blender_iteration_state to see what is already known before measuring anything.",
			parameters: Type.Object({
				workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
				moduleName: Type.String({ description: "The module the fact is about." }),
				statement: Type.String({
					description:
						'The measured finding itself, as a checkable sentence: "The handle is 12mm across, under the 18mm a hand needs". Not "the handle looks thin" -- that is a judgement, and the critic makes those.',
				}),
				source: Type.String({
					description:
						'Which tool produced it, with the identifying detail: "blender_geometry_probe, Mug vs MugHandle pair distance", "blender_image_probe, modules/mug/render.png". A fact with no source is an assertion.',
				}),
				iteration: Type.Optional(
					Type.Number({ description: "The run the measurement belongs to. Defaults to nothing; supply it when the fact came from a specific run." }),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderRecordIterationFact({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
					statement: params.statement,
					source: params.source,
					iteration: params.iteration,
				});

				return {
					content: [
						{
							type: "text",
							text: [
								`Recorded for ${result.module}: ${result.recorded.statement}`,
								`Source: ${result.recorded.source}${result.recorded.iteration ? ` (iteration ${result.recorded.iteration})` : ""}`,
								`${result.facts.length} fact(s) now known for this module${result.superseded > 0 ? `; ${result.superseded} earlier statement(s) replaced` : ""}.`,
							].join("\n"),
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_export_asset",
			label: "Blender Export Asset",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description:
				"Export the workspace blend to an interchange format: glb or gltf (materials, scene graph, modifiers applied) or obj (geometry, UVs, materials) or stl. This is what makes the asset leave Blender at all -- .blend is not an interchange format and no training pipeline reads it. Works headlessly. Pass `objects` to export a named subset, which is how you keep the studio rig out of a dataset. Read-only with respect to model.blend: the exporter writes a new file and never saves back.",
			parameters: Type.Object({
				workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
				format: Type.Optional(
					Type.String({
						description: "glb (default, single file), gltf (separate .bin and textures), obj, or stl. USD is not offered because no exporter is guaranteed present in a stock Blender build.",
						enum: ["glb", "gltf", "obj", "stl"],
					}),
				),
				objects: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Names to export, when given. Omit for the whole blend. Naming the asset's own objects is how a studio camera and three lights stay out of the dataset.",
					}),
				),
				outputDir: Type.Optional(
					Type.String({
						description: "Directory for the exported file. Defaults to the blend's own directory.",
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Base filename, without extension. Defaults to the blend's name. Sanitised, since it usually comes from a prompt.",
					}),
				),
				animations: Type.Optional(
					Type.Boolean({
						description: "Include animation data (glTF only). Default false.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderExportAsset({
					cwd: ctx.cwd,
					workspace: params.workspace,
					format: params.format as AssetExportOptions["format"],
					objects: params.objects,
					outputDir: params.outputDir,
					name: params.name,
					animations: params.animations,
				});

				return {
					content: [
						{
							type: "text",
							text: `Exported ${result.format} to ${result.exportPath} (${result.bytes} bytes, ${result.meshCount} mesh(es)).`,
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_import_asset",
			label: "Blender Import Asset",
			description:
				"Import an external 3D asset (obj, stl, gltf/glb, fbx) into the workspace blend. Checkpoints the workspace blend before importing so partial imports are cleanly revertible. Guards against path traversal and sanitizes asset names. Probes format and add-on support (e.g. FBX), reporting missing capabilities as explicit results rather than tracebacks. Returns a post-import report detailing imported objects, non-uniform scale checks, and principal axes.",
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: false,
			},
			parameters: Type.Object({
				workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
				path: Type.String({ description: "Path to the 3D asset file to import (obj, stl, gltf, glb, or fbx)." }),
				format: Type.Optional(
					Type.String({
						description: "Format of the asset: obj, stl, gltf, glb, or fbx. If omitted, inferred from file extension.",
						enum: ["obj", "stl", "gltf", "glb", "fbx"],
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Optional asset name or object name prefix. Sanitized against invalid characters.",
					}),
				),
				allowedPaths: Type.Optional(
					Type.Array(Type.String(), {
						description: "Allowed directories or file paths for source assets to guard against traversal. Defaults to the workspace directory and current working directory.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderImportAsset({
					cwd: ctx.cwd,
					workspace: params.workspace,
					path: params.path,
					format: params.format as ImportFormat | undefined,
					name: params.name,
					allowedPaths: params.allowedPaths,
				});

				if (!result.success) {
					return {
						content: [
							{
								type: "text",
								text: `Import failed: ${result.error}`,
							},
						],
						details: result,
					};
				}

				return {
					content: [
						{
							type: "text",
							text: `Imported ${result.format} asset "${result.assetName}" (${result.importedObjects.length} object(s): ${result.importedObjects.join(", ")}). Pre-import checkpoint saved to ${result.checkpointPath}.${result.report?.hasNonUniformScale ? " Warning: non-uniform scale detected." : ""}`,
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_add_reference",
			label: "Blender Add Reference",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			},
			description:
				"Register a reference image with a workspace. Copies the image into <workspace>/references/ and records it in the manifest so it can be listed, addressed by a stable id in briefs, and handed to a critic that cannot read images. The `caption` is required and is the only description of the image available to the worker and critic, because the manager is blocked from reading image files.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				path: Type.String({
					description:
						"Path to an existing image file on disk. It is COPIED into the workspace references/ directory, so later moves or deletions of the original do not break pending work. Supported: .png .jpg .jpeg .gif .webp .bmp",
				}),
				caption: Type.String({
					description:
						"What this image depicts, in one or two sentences: the subject, the angle it is shot from, and anything a worker or critic would need to judge against it. Required — you cannot read the image yourself, so this text is the only thing that will convey its contents.",
				}),
				id: Type.Optional(
					Type.String({
						description:
							"Stable id to address this reference by in briefs, e.g. 'front' or 'three-quarter'. Defaults to the file's name without its extension. Adding a reference whose id is taken stores it as <id>-2 rather than overwriting, so earlier verdicts stay reproducible.",
					}),
				),
				suggestedView: Type.Optional(
					Type.String({
						description:
							"Optional saved view or camera name you believe this reference should be compared against. The pairing is a hypothesis: a critic will report whether the two images are actually comparable, and name the view it would prefer if not.",
					}),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderAddReference({
					cwd: ctx.cwd,
					workspace: params.workspace,
					path: params.path,
					caption: params.caption,
					id: params.id,
					suggestedView: params.suggestedView,
					signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_bridge_status",
			label: "Blender Bridge Status",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				"Check whether the live Blender bridge can serve a request right now: is the UI running, is another request holding the single live-Blender slot, how many requests are pending, how many headless Blender runs may execute concurrently on this machine, and how many are open RIGHT NOW across this session's workers. Use it before a long or mutating batch, or when a bridge call timed out, instead of guessing or burning another timeout. The open count is the one to read mid-fan-out: the budget says what is permitted, not what your workers already spent. A /blender-watch window is reported apart from the runs, because it is not one of them.",
			parameters: Type.Object({
				workspace: Type.Optional(
					Type.String({
						description: "Optional workspace path to report alongside the bridge state.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderBridgeStatus({
					cwd: ctx.cwd,
					workspace: params.workspace,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_geometry_probe",
			label: "Blender Geometry Probe",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
			description:
				"Measure mesh/transform relationships in the workspace blend and return numbers: world-space bounds, thin/long principal axes and their angle to an expected axis, pair distance with an interpenetrating/in-contact/separated verdict, a scene-wide sweep for parts that ought to meet and do not — or that share a surface and will z-fight, mesh island counts, and non-manifold/loose/duplicate geometry counts. Read-only by construction — it never mutates or saves, claims no iteration, and is safe to call while a worker has a module mid-flight (see docs/SAFETY.md for full guarantee boundary and measurement pitfalls like coincident deepestPenetration). Use it instead of reasoning about placement: a floating or buried handle is a measured gap distance, not a guess. Works with no window: it then measures model.blend on disk headlessly. With a window open it measures the live session instead, including unsaved edits, and warns when the two differ.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				objects: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Object names to measure. Omit to probe every visible mesh in the scene — usually the right default, because a misplaced part is found by its relationship to the rest, and the culprit is often not yet known.",
					}),
				),
				pairs: Type.Optional(
					Type.Array(
						Type.Array(Type.String(), {
							minItems: 2,
							maxItems: 2,
						}),
						{
							description:
								'Object-name pairs to measure against each other, e.g. [["Mug", "MugHandle"]]. Each pair yields the closest surface distance, penetration depth, per-object vertex-inside counts, a coincident-surface figure, bounding-box overlap, and a verdict. Omit to auto-pair when exactly two objects are given.',
						},
					),
				),
				specifications: Type.Optional(
					Type.Record(
						Type.String(),
						Type.Object({
							width: Type.Optional(Type.Union([Type.Number(), Type.String()])),
							depth: Type.Optional(Type.Union([Type.Number(), Type.String()])),
							height: Type.Optional(Type.Union([Type.Number(), Type.String()])),
							tolerance: Type.Optional(Type.Number()),
						}),
						{
							description:
								"Reference dimensions per object name, compared against what the scene actually measures. A bare integer is MILLIMETRES and a bare decimal is METRES, because a brief says `2400` and `2.4m` for the same ceiling; unitless-as-metres is not an option when a 1000x error renders identically. Naming dimensions implies the `scale` check.",
						},
					),
				),
				checks: Type.Optional(
					Type.Array(
						Type.Union([
							Type.Literal("transform"),
							Type.Literal("bounds"),
							Type.Literal("axis"),
							Type.Literal("pair"),
							Type.Literal("joint"),
							Type.Literal("clearance"),
							Type.Literal("path"),
							Type.Literal("shape"),
							Type.Literal("topology"),
							Type.Literal("scale"),
						]),
						{
							description:
								"Measurement families to run. Omit for all. `transform` catches unapplied/mirror scale; `axis` finds a ring's own axis and how far it is off the expected one; `pair` measures only the pairs you NAME; `joint` sweeps the whole scope for pairs nobody named — bounding boxes that overlap or come within 50mm while the surfaces are further apart than the tolerance — and is the check that finds a riser pipe modelled clear of the pipe it continues; it also reports `coincident-surface`, the two parts sharing a stretch of geometry that renders as z-fighting colour banding, which no verdict can see because a flush-laid panel is in contact and so is a clean one, and `buried`, a part swallowed whole by another, which is a correct render of a wrong model; `clearance` answers whether the room is USABLE — it samples the floor with a person-sized body, dilates every obstruction by that reach, and reports `islandCount` (free floor cut into pieces nobody can walk between) and `unreachableArea` (floor that reaches no edge at all), which is what catches a sofa laid wall to wall; it takes its room from the same `objects` you scope it to, so measure one room rather than the house; `path` asks whether the WALK between two points is longer than the line between them — pass `points` (door centres, the ends of a corridor) and it walks every pair over the same floor raster, walls included, and reports a `detour` ratio: 1.0 is a corridor, one bend is about 1.1–1.3, and a stair-step of several offset doors runs to 1.9 or more, which is the shape a render cannot show because from above it is still a house; `shape` reports self-symmetry, a radius profile along the mesh's own long axis, convexity and open edges — the defects a render cannot show; `topology` is the expensive one (bmesh pass per mesh) and is only needed when the shape itself is suspect, and its island count is what catches a mesh split into drifting pieces; `scale` needs `specifications` and compares each object against the reference dimensions your brief named.",
						},
					),
				),
				tolerance: Type.Optional(
					Type.Number({
						description:
							"Contact distance in Blender units (default 0.002, i.e. 2 mm at default scale). Distances within tolerance report as `in-contact` rather than `separated`.",
					}),
				),
				expectedAxis: Type.Optional(
					Type.Union([Type.Literal("X"), Type.Literal("Y"), Type.Literal("Z")], {
						description:
							"The axis a part's thin direction should align with — `Z` for a mug handle's ring axis, `Z` for a vertical stem. Omit to skip the alignment comparison.",
					}),
				),
				body: Type.Optional(
					Type.Number({
						description:
							"`clearance` and `path` only. Metres a person reaches — a sample is blocked when an obstruction comes within this. Default 0.25, which is what makes a 50 mm gap read as blocked and a 500 mm one as a doorway. Widen it to ask whether a wheelchair gets through, narrow it to ask whether anything does. Any other check ignores it.",
					}),
				),
				points: Type.Optional(
					// Deliberately NOT `Type.Tuple([Type.Number(), Type.Number()])`.
					//
					// A tuple serializes to a POSITIONAL `items` array:
					//   { "items": [ { "type": "number" }, { "type": "number" } ] }
					// That is valid draft-07, but strict providers reject it as a
					// malformed tool schema, which fails the whole request:
					//   Tool 22 function has invalid 'parameters' schema:
					//   [{'type': 'number'}, {'type': 'number'}] is not of type
					//   'object', 'boolean'
					// The bounded inner array below serializes to the OBJECT form
					// (`items: { "type": "number" }` plus minItems/maxItems), which
					// every provider accepts. `Type.Unsafe` supplies the `[number,
					// number]` static type that the plain `Type.Array` loses, so the
					// call site keeps its exact typing without a cast.
					Type.Unsafe<[number, number][]>(
						Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), {
							description:
								"World `[x, y]` positions in metres a person is meant to travel between — door centres, the ends of a corridor, the foot of a stair. Passing these implies the `path` check. Every PAIR is walked, not just the ones you ordered: a house is short of doors and long of rooms, so the pair a designer forgot is the one that zig-zags. Each point snaps to the nearest free floor within a body's reach, so a door centre given beside its frame still resolves; one that lands on nothing is reported in `unresolved` rather than guessed at.",
						}),
					),
				),
				detour: Type.Optional(
					Type.Number({
						description:
							"`path` only. The detour ratio above which a route counts as a zig-zag, default 1.45. A straight corridor is 1.0 and a single right-angle bend is about 1.1–1.3, which is why the default sits well above 1: real architecture bends, and the defect is the several-turn stair-step. Cannot go below 1.0 — the straight line is a lower bound on any walk.",
					}),
				),
				cell: Type.Optional(
					Type.Number({
						description:
							"`clearance` and `path` only. Metres, the sampling granularity, default 0.05. The effective stride is this widened to cover `body`, because a sample is stamped with a dilated box spanning `2 * body` — so `cell` alone does not set the resolution. Lower it for a fine question, and expect a proportionally larger sample count. The two checks share one raster, so the same scope and the same `cell` report the same `stride`.",
					}),
				),
				timeoutMs: Type.Optional(
					Type.Number({
						description:
							"Bridge timeout override in ms. Defaults to 120000 (4x the 30s round-trip) because a probe scales with scene size — raise it for a `topology` check on a heavy scene, lower it when you are probing a small object list and want a dead bridge to report sooner.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderGeometryProbe({
					cwd: ctx.cwd,
					workspace: params.workspace,
					objects: params.objects,
					pairs: params.pairs,
					checks: params.checks,
					specifications: params.specifications,
					tolerance: params.tolerance,
					expectedAxis: params.expectedAxis,
					body: params.body,
					cell: params.cell,
					points: params.points,
					detour: params.detour,
					timeoutMs: params.timeoutMs,
					signal: _signal,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_image_probe",
			label: "Blender Image Probe",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			description:
				"Measure a rendered PNG numerically instead of judging it by eye: subject pixel bounds and coverage, mean subject colour, an nx-by-ny mean-luma grid, silhouette row occupancy, edge sharpness, and dominant subject colours. Read-only by construction, and it needs no live Blender — the pixels are the whole input, so any read-only role can use it (see docs/SAFETY.md for full guarantee boundary). Use it to check a visual suspicion before asserting it: 'the part is bare' is a colour fraction, 'the arms are hidden behind the body' is a row-occupancy pattern, and 'the render is too dark to judge' is a mean luma.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				path: Type.String({
					description:
						"Path to the PNG to measure, e.g. `modules/<name>/render.png`. Relative paths resolve against the workspace root.",
				}),
				background: Type.Optional(
					Type.Array(Type.Number(), {
						minItems: 3,
						maxItems: 3,
						description:
							"The image's background colour as three 0..1 values (r, g, b). Defaults to black. This is a property of the shot, so read it from the render settings or the world rather than guessing from a corner pixel — a wrong value makes the background read as subject and empties the measurement.",
					}),
				),
				tolerance: Type.Optional(
					Type.Number({
						description:
							"Per-channel 0..1 tolerance for calling a pixel background (default 0). Raise it for a noisy or film-grain background, or for an antialiased edge that should count as subject.",
					}),
				),
				grid: Type.Optional(
					Type.Array(Type.Number(), {
						minItems: 2,
						maxItems: 2,
						description:
							"Luma grid resolution as [nx, ny] (default [8,8], maximum 32 per side). Each cell is the mean luma of the subject pixels inside it, and null where there are none — a null cell means the subject does not reach that part of the frame.",
					}),
				),
				paletteLimit: Type.Optional(
					Type.Number({
						description: "How many dominant subject colours to report (default 6, 0 disables).",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderImageProbe({
					cwd: ctx.cwd,
					workspace: params.workspace,
					path: params.path,
					background: params.background as [number, number, number] | undefined,
					tolerance: params.tolerance,
					grid: params.grid as [number, number] | undefined,
					paletteLimit: params.paletteLimit,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_read_only_python",
			label: "Blender Read-Only Python",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Run a Python measurement script in the LIVE Blender scene and get its stdout back, with mutating bpy operations refused by the bridge itself — bpy.ops, bpy.data and bpy.data.<collection> removal (including batch_remove and orphans_purge), linking or unlinking in the scene collection, assigning to an object or its vectors, and saving. It never mutates, saves, or claims an iteration. This exists because a question like 'is the tights the visible surface' is one raycast, and answering it any other way means eyeballing a render. A refusal comes back as `refused: true` naming the operation, which is an answer, not a failure: rewrite the script to ask a question that does not need the change. Print what you measured; the return value is whatever you printed. Two honest limits: this guards bpy, NOT the filesystem, so a read-only script may still read and write files with `os` and `open` — do not use it on anything you would mind losing. And it is a denylist of named entry points rather than a sandbox, so a bpy API this tool does not know about is not refused; see docs/SAFETY.md for the full guarantee boundary. If a measurement needs to change the scene, use blender_execute_python or blender_module_run. Works with no window: the script then runs headlessly against model.blend. With a window open it runs against the live session instead, so it can see unsaved edits.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				script: Type.String({
					description:
						"The Python to run, as text. Inline rather than a path on purpose: a read-only role has no `write` tool, so a path-only API would make the tool unusable for exactly the role that needs it, and would push it toward asking a worker to author its own evidence.",
				}),
				timeoutMs: Type.Optional(
					Type.Number({
						description: "Bridge timeout override in ms for the script itself.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderReadOnlyPython({
					cwd: ctx.cwd,
					workspace: params.workspace,
					script: params.script,
					timeoutMs: params.timeoutMs,
					signal: _signal,
				});

				return {
					content: [
						{
							type: "text",
							text: result.refused
								? `REFUSED: the script asked for an operation that would change the scene.\n${result.stdout.trim()}`
								: result.stdout.trim() || "(the script printed nothing)",
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_montage",
			label: "Blender Montage",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Render several preset views of one subject and tile them into a single labelled sheet, plus the individual panels at full size. Two families of preset, chosen per view name. ORBIT presets (front, three-quarter, …) frame the subject's bounding sphere at one fixed distance, so every panel frames identically and a difference between panels is the geometry rather than the camera. INTERIOR presets (interior-corner, interior-doorway, …) stand inside the subject at eye height — a room has no silhouette to orbit, and a 6x4x2.8m room has a bounding-sphere radius of 3.9m, so every orbit panel of it photographs the outside of a wall. Use it when one angle cannot answer the question — a silhouette that might be hiding a limb, a shape that reads as symmetric from the front and wrong from three-quarter, a room that reads as cluttered from one corner and open from another, a critic that keeps calling something vague. Name the views; do not ask for views. Read-only with respect to the file it photographs: resolution, filepath, scene camera and viewport are restored, and the temporary cameras are removed. Works with no window: it then renders each panel headlessly from model.blend.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				moduleName: Type.String({
					description: "Module the sheet belongs to. Written to modules/<name>/montage.png, with panel-N-<view>.png beside it.",
				}),
				views: Type.Array(Type.String(), {
					minItems: 1,
					maxItems: 4,
					description:
						"Preset view names. Orbit: front, back, left, right, top, bottom, three-quarter, three-quarter-left, three-quarter-high, profile-left, profile-right, front-high. Interior: interior-corner, interior-corner-left, interior-corner-right, interior-elevated, interior-doorway, interior-low. An unknown name is refused with the list rather than approximated. Two to four views make a useful sheet; one view is a render with extra steps.",
				}),
				subject: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Objects to frame. Defaults to every visible mesh, which frames the whole build. Pass names when one module is the subject and the rest of the scene is context.",
					}),
				),
				columns: Type.Optional(
					Type.Number({
						description:
							"Sheet columns. Default 1 for up to two views, otherwise 2. A 2x2 sheet of four panels is the most a critic can resolve before the panels get downsampled.",
					}),
				),
				panelResolution: Type.Optional(
					Type.Object({
						x: Type.Number({ description: "Panel width in pixels (default 900)." }),
						y: Type.Number({ description: "Panel height in pixels (default 700)." }),
					}),
				),
				timeoutMs: Type.Optional(
					Type.Number({
						description:
							"Bridge timeout override in ms. Defaults to four times the single-render budget, because this is one render per panel.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderMontage({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
					views: params.views,
					subject: params.subject,
					columns: params.columns,
					panelResolution: params.panelResolution,
					timeoutMs: params.timeoutMs,
					signal: _signal,
				});

				return {
					content: [
						{
							type: "text",
							text: [
								`Montage: ${result.montagePath}`,
								`Panels: ${result.panelPaths.join(", ")}`,
								`Views: ${result.views.join(", ")} (${result.layout.columns}x${result.layout.rows} of ${result.layout.panelWidth}x${result.layout.panelHeight})`,
								`Framed: ${result.subject.join(", ")}`,
								result.note,
							].join("\n"),
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_compare",
			label: "Blender Compare",
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			description:
				"Render the PREVIOUS generation of a subject beside the current one on a single labelled sheet, so a regression is visible. Each panel is labelled with which ITERATION it is (the baseline is the run before this module's latest, the current one is the latest; pass baselineLabel/currentLabel to say otherwise), and the two panels of one view sit side by side, which is what makes the sheet a comparison rather than a pair of pictures. Both generations are framed from the UNION of their extents, so the camera is identical in every panel and a difference between two panels of the same view is geometry — framing each generation on its own extent would make a part that grew read as a camera change. The baseline is rendered again from the checkpoint the earlier run started from (a checkpoint IS that generation's state, so no kept render is needed); pass baselineBlendPath to compare against a named earlier iteration instead. Two runs is the minimum: with only one there is no previous generation, and a sheet of identical pairs would read as proof of stability. Views are the same preset names as blender_montage. The baseline is a file on disk, never the session's own state: it is opened, rendered, and the workspace blend put back, so a comparison never replaces what you are looking at. A baseline missing subjects you named is reported as missingSubjects rather than rendered as an absence. Works with no window: both generations then render headlessly.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				moduleName: Type.String({
					description:
						"Module whose two generations are compared. Defaults the baseline from this module's run history, and writes modules/<name>/compare.png.",
				}),
				baselineBlendPath: Type.Optional(
					Type.String({
						description:
							"The generation to compare against — normally a checkpoint under modules/<name>/runs/NN/. Defaults to the run immediately before this module's latest one. Refused outright when there is none, because a sheet of one generation wearing a comparison's labels invites reading the build as an improvement over nothing.",
					}),
				),
				baselineLabel: Type.Optional(
					Type.String({
						description:
							"What to call the baseline in every panel label. Default its iteration number when the baseline came from run history, and BEFORE when you named the path yourself.",
					}),
				),
				currentLabel: Type.Optional(
					Type.String({
						description: "What to call the current generation. Default AFTER.",
					}),
				),
				views: Type.Array(Type.String(), {
					minItems: 1,
					maxItems: 4,
					description:
						"Preset view names, same as blender_montage. Two to four make a readable sheet; with columns 2 each view's two generations sit adjacent, so the reading order IS the comparison.",
				}),
				subject: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Objects to frame and compare. Defaults to every visible mesh. Pass names when one module is the subject and the rest of the scene is context.",
					}),
				),
				columns: Type.Optional(
					Type.Number({
						description: "Sheet columns. Default 2, so a view's two generations sit side by side.",
					}),
				),
				panelResolution: Type.Optional(
					Type.Object({
						x: Type.Number({ description: "Panel width in pixels (default 900)." }),
						y: Type.Number({ description: "Panel height in pixels (default 700)." }),
					}),
				),
				timeoutMs: Type.Optional(
					Type.Number({
						description:
							"Bridge timeout override in ms. Defaults to eight times the single-render budget: this renders every panel twice and opens a second blend.",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderCompare({
					cwd: ctx.cwd,
					workspace: params.workspace,
					moduleName: params.moduleName,
					baselineBlendPath: params.baselineBlendPath,
					baselineLabel: params.baselineLabel,
					currentLabel: params.currentLabel,
					views: params.views,
					subject: params.subject,
					columns: params.columns,
					panelResolution: params.panelResolution,
					timeoutMs: params.timeoutMs,
					signal: _signal,
				});

				const missing = result.baseline.missingSubjects;
				return {
					content: [
						{
							type: "text",
							text: [
								`Comparison: ${result.montagePath}`,
								`Baseline: ${result.labels.baseline} = ${result.baseline.blendPath}`,
								`Current: ${result.labels.current}`,
								`Views: ${result.views.join(", ")} (${result.layout.columns}x${result.layout.rows} of ${result.layout.panelWidth}x${result.layout.panelHeight})`,
								`Framed: ${result.subject.join(", ")}`,
								missing.length > 0
									? `Baseline is missing ${missing.join(", ")} — it predates those objects, so their absence in the ${result.labels.baseline} panels is not a render fault.`
									: undefined,
								result.note,
							]
								.filter((line): line is string => line !== undefined)
								.join("\n"),
						},
					],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_get_python_api_docs",
			label: "Blender Get Python API Docs",
			description:
				"Look up authoritative documentation and signatures from the Blender 4.2 LTS Python API reference for a specific identifier (e.g. bpy.types.Modifier, bpy.ops.mesh.primitive_uv_sphere_add, bpy.data.objects) or list matching identifiers and submodules when ending with a wildcard * (e.g. bpy.ops.mesh.*, bpy.types.*). Offline and fast; does not require a running Blender instance or bridge lock.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			parameters: Type.Object({
				identifier: Type.String({
					description:
						"The bpy identifier to look up (e.g. 'bpy.types.Modifier', 'bpy.ops.mesh.primitive_uv_sphere_add'), or a wildcard query (e.g. 'bpy.ops.mesh.*', 'bpy.types.*') to list available members.",
				}),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
				const result = await blenderGetPythonApiDocs({
					identifier: params.identifier,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_search_api_docs",
			label: "Blender Search API Docs",
			description:
				"Perform full-text search across the curated Blender 4.2 LTS Python API reference corpus (bpy.types, bpy.ops, bpy.data, bpy.context, bpy.props). Returns matching API signatures, descriptions, and parameter definitions. Offline and fast; does not require a running Blender instance or bridge lock.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			parameters: Type.Object({
				query: Type.String({
					description:
						"Search query string to match against Blender 4.2 LTS API reference (types, operators, signatures, properties).",
				}),
				limit: Type.Optional(
					Type.Number({
						description: "Maximum number of search results to return (default 10).",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
				const result = await blenderSearchApiDocs({
					query: params.query,
					limit: params.limit,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			defaultActive: false,
			name: "blender_search_manual_docs",
			label: "Blender Search Manual Docs",
			description:
				"Perform full-text search across curated Blender 4.2 LTS user manual excerpts covering modeling, modifiers, rigging, shading, render, and geometry nodes. Returns matching topics, explanations, and workflows. Offline and fast; does not require a running Blender instance or bridge lock.",
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			parameters: Type.Object({
				query: Type.String({
					description:
						"Search query string to match against Blender 4.2 LTS user manual excerpts (modeling, modifiers, rigging, shading, render, geometry nodes).",
				}),
				limit: Type.Optional(
					Type.Number({
						description: "Maximum number of search results to return (default 10).",
					}),
				),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
				const result = await blenderSearchManualDocs({
					query: params.query,
					limit: params.limit,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

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

