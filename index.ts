/**
 * pi extension: Vibe Blender integration (extracted from vibe-blender 0.1.2,
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
	blenderBridgeStatus,
	blenderExecutePython,
	blenderGeometryProbe,
	blenderLogCritique,
	blenderModuleRevert,
	blenderModuleRun,
	blenderRender,
	blenderSaveView,
	blenderSceneInfo,
	blenderSessionContext,
	blenderSetMode,
	blenderWorkspaceInit,
	formatCompactSessionContextPrompt,
	getBundledBlenderSkillsDir,
} from "./blender/runtime.js";
import { isLiveBridgeAlive } from "./launch.js";
import { requestLiveBlenderShutdown } from "./blender/bridge.js";
import { ensureLiveBridgeLaunchedForce, resetBridgeLaunch } from "./launch.js";
import { getManagerPrompt } from "./config.js";
import * as localCore from "./manager-core.local.js";
import { loadManagerCoreOrLocal } from "./manager-core.js";

/**
 * The shared manager core, or this extension's own copy of it. See
 * manager-core.ts for the resolution order and why it is a runtime lookup.
 */
const core = loadManagerCoreOrLocal(localCore);

const LIVE_CONTEXT_PROMPT_TIMEOUT_MS = 1_500;

/** The name pi-subagents stamped into this session's prompt, or null if none. */
function readActiveAgentName(systemPrompt: string): string | null {
	return core.readActiveAgentName(systemPrompt);
}

/** Whether this session is acting as THE manager, and so is subject to the gate. */
function isManagerSession(systemPrompt: string): boolean {
	return managerMode.isManagerSession(systemPrompt);
}

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
]);

const MANAGER_ALLOWED_TOOL_NAMES = new Set([
	"memory_write",
	"memory_read",
	"memory_search",
	"memory_forget",
	"memory_restore",
	"memory_status",
	"scratchpad",
]);

/** Image types `read` would attach to the request, mirroring pi's own sniffing. */
const IMAGE_READ_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

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

		if (event.toolName === "subagent") {
			// `agent` is absent for management/control actions (status, list,
			// stop, …), so only a one-child spawn is constrained here.
			const target = typeof event.input.agent === "string" ? event.input.agent.trim() : "";
			if (target.length > 0 && !BLENDER_MANAGER_ROSTER.has(target)) {
				return {
					block: true,
					reason: `Manager role: you may only spawn ${[...BLENDER_MANAGER_ROSTER].join(", ")}. "${target}" is not one of them, and each of those already owns a distinct job in this build, so spawning something else means reassigning work that has an owner. If none of them covers a capability you need, say so in your report rather than reaching for an unrelated agent.`,
				};
			}
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


export default function piVibeBlenderExtension(pi: ExtensionAPI) {
		pi.registerTool({
			name: "blender_workspace_init",
			label: "Blender Workspace Init",
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
			name: "blender_execute_python",
			label: "Blender Execute Python",
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
			name: "blender_session_context",
			label: "Blender Session Context",
			description:
				"Inspect the current live Blender UI session to resolve the open blend, active scene, current mode, active object, selected objects, and viewport state before acting on ambiguous requests like 'update it' or 'render from here'.",
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
			name: "blender_scene_info",
			label: "Blender Scene Info",
			description:
				'Inspect the current Blender workspace, write structured scene metadata into the current iteration folder, and return it for planning or verification. Prefer a narrow `categories` list such as `["objects"]`, `["materials"]`, or `["cameras", "cameraSettings"]` when you only need one or a few sections. Omit `categories` only when you truly need the full scene info payload.',
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
						]),
						{
							description:
								"Optional scene info categories to inspect. Pass one category to inspect only that section, or pass a short list for a subset. For paint/UV/rig work add `uv`, `textures`, `armatures`, and `paintSettings`. Omit `categories` only when you need all available scene info sections.",
							uniqueItems: true,
						},
					),
				),
			}),
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const result = await blenderSceneInfo({
					cwd: ctx.cwd,
					workspace: params.workspace,
					categories: params.categories,
					signal,
					});

						return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "blender_save_view",
			label: "Blender Save View",
			description:
				"Save a named render view in the workspace manifest. With source=active-camera, capture the current live Blender UI viewport into a dedicated camera object; otherwise bind the view to an existing camera object.",
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
			name: "blender_render",
			label: "Blender Render",
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
			name: "blender_module_run",
			label: "Blender Module Run",
			description:
				"Run a workspace module: checkpoint model.blend to modules/<name>/runs/NN/pre-NN.blend, execute modules/<name>/script.py in the live Blender session, save the result, and optionally capture a live render to modules/<name>/render.png for critique. The run is recorded in the workspace manifest (moduleRuns), so blender_module_revert knows exactly which state it restores. Use one module per object or concern in multi-part tasks.",
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
			name: "blender_module_revert",
			label: "Blender Module Revert",
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
			name: "blender_set_mode",
			label: "Blender Set Mode",
			description:
				"Switch the live Blender viewport/object mode for a workspace blend, enabling texture paint, vertex/weight/face paint, sculpt, pose, edit-armature, or UV editing. Supported modes: OBJECT, POSE, EDIT_MESH, EDIT_ARMATURE, SCULPT, TEXTURE_PAINT, VERTEX_PAINT, WEIGHT_PAINT, FACE_PAINT, and UV (enters edit mode and turns on the viewport UV editor overlay). Paint modes require a MESH object, POSE/EDIT_ARMATURE require an ARMATURE object. Use this before/after authoring paint or rig changes in script.py so the user sees the correct workspace in the live UI.",
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
			name: "blender_log_critique",
			label: "Blender Log Critique",
			description:
				"Append a structured critique entry to the workspace critique.log using the 0-10 Blender iteration rubric, plus a view adequacy judgment for the current render perspective.",
			parameters: Type.Object({
				workspace: Type.String({
					description: "Explicit workspace path for the Blender task.",
				}),
				iteration: Type.Optional(
					Type.Number({
						description: "Optional iteration number. Defaults to the current workspace iteration.",
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
				viewAdequacy: Type.String({
					description:
						"Non-scored judgment of whether the current render view is good enough for evaluation, including any framing, coverage, or perspective problems.",
				}),
				issues: Type.Array(
					Type.String({
							description: "Concrete problems found in the current render or scene.",
					}),
				),
				nextAction: Type.String({
					description: 'Either a fix to attempt next or "present to user" when the result is good enough.',
				}),
			}),
			execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
				const result = await blenderLogCritique({
					cwd: ctx.cwd,
					workspace: params.workspace,
					iteration: params.iteration,
					accuracy: params.accuracy,
					geometry: params.geometry,
					materials: params.materials,
					completeness: params.completeness,
					quality: params.quality,
					viewAdequacy: params.viewAdequacy,
					issues: params.issues,
					nextAction: params.nextAction,
				});

				return {
					content: [{ type: "text", text: formatJsonResult(result) }],
					details: result,
				};
			},
		});

		pi.registerTool({
			name: "blender_add_reference",
			label: "Blender Add Reference",
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
			name: "blender_bridge_status",
			label: "Blender Bridge Status",
			description:
				"Check whether the live Blender bridge can serve a request right now: is the UI running, is another request holding the single live-Blender slot, and how many requests are pending. Use it before a long or mutating batch, or when a bridge call timed out, instead of guessing or burning another timeout.",
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
			name: "blender_geometry_probe",
			label: "Blender Geometry Probe",
			description:
				"Measure mesh/transform relationships in the LIVE Blender scene and return numbers: world-space bounds, thin/long principal axes and their angle to an expected axis, pair distance with an interpenetrating/in-contact/separated verdict, and non-manifold/loose/duplicate geometry counts. Read-only — it never mutates or saves, claims no iteration, and is safe to call while a worker has a module mid-flight. Use it instead of reasoning about placement: a floating or buried handle is a measured gap distance, not a guess.",
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
								'Object-name pairs to measure against each other, e.g. [["Mug", "MugHandle"]]. Each pair yields the closest surface distance, penetration depth, per-object vertex-inside counts, bounding-box overlap, and a verdict. Omit to auto-pair when exactly two objects are given.',
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
							Type.Literal("topology"),
						]),
						{
							description:
								"Measurement families to run. Omit for all. `transform` catches unapplied/mirror scale; `axis` finds a ring's own axis and how far it is off the expected one; `topology` is the expensive one (bmesh pass per mesh) and is only needed when the shape itself is suspect.",
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
					tolerance: params.tolerance,
					expectedAxis: params.expectedAxis,
					timeoutMs: params.timeoutMs,
					signal: _signal,
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
		pi.on("session_start", () => {
			managerMode.reset();
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
			if (readActiveAgentName(ctx.getSystemPrompt()) !== null) return;
			// A pi that never launched a UI has nothing to release, and asking
			// would cold-launch one purely to shut it down.
			if (!isLiveBridgeAlive()) return;
			try {
				const result = await requestLiveBlenderShutdown({ save: true, timeoutMs: 5_000 });
				if (result.saveError) {
					console.error(
						`[pi-vibe-blender] warning: could not save "${result.blendPath ?? "the open blend"}" before quitting Blender: ${result.saveError}`,
					);
				}
			} catch (error) {
				// Never block process exit on a bridge that is already gone.
				console.error(
					`[pi-vibe-blender] warning: could not cleanly shut down the live Blender UI: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});

		// Blender UI is NOT launched at pi/session start. It is launched when
		// the user engages Blender: running /blender force-launches it below
		// (bypassing the heartbeat stale check so a Blender closed moments ago
		// is still relaunched), and any blender_* tool call triggers the lazy
		// ensureLiveBridgeLaunched() path in blender/bridge.ts.

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
				// Force-launch the UI with the session: bypasses the stale-heartbeat
				// guard so a Blender closed just before this is still relaunched.
				resetBridgeLaunch();
				ensureLiveBridgeLaunchedForce();
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

		pi.on("before_agent_start", injectBlenderContext);
};

