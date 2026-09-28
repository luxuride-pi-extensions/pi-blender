/**
 * pi extension: Vibe Blender integration (extracted from vibe-blender 0.1.2,
 * repo veoery/BlenderAgent, MIT license).
 *
 * Registers 13 blender_* tools + bundled skills, the /blender and
 * /blender-exit slash commands, and injects Blender workflow guidance + live
 * session context before turns of a MANAGER session.
 *
 * Manager mode is entered ONLY by the /blender command — never by a blender_*
 * tool call. It governs the guidance section, the per-turn live-state snapshot,
 * and the write/edit/image gate. A direct tool call is worker-level work, so it
 * neither injects manager guidance nor gets gated; the tools stay usable on
 * their own. Mode ends at /blender-exit (which lifts only the parent's gate,
 * not the tools) or on the next session_start, because a session that
 * interleaves Blender with other work would otherwise stay restricted until a
 * /new.
 *
 * The constant guidance goes into a `blender` system-prompt section, so it
 * never lands after the user prompt; only the volatile live-state snapshot is
 * appended per turn.
 * The Blender UI is NOT launched at pi/session start. It is launched lazily
 * when the user engages Blender: the /blender command force-launches it via
 * ensureLiveBridgeLaunchedForce(), and any blender_* tool call triggers the
 * lazy ensureLiveBridgeLaunched() path in blender/bridge.ts. Both check the
 * bridge heartbeat first, so a Blender that is already up (even in another pi
 * process) is never re-spawned into a second window on the same bridge dir.
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
import { ensureLiveBridgeLaunchedForce, resetBridgeLaunch } from "./launch.js";

const BLENDER_WORKFLOW_GUIDANCE = [
	"You are operating inside vibe-blender with Blender-native tools available.",
	"Prefer Blender tools over generic shell/file workflows for scene creation, editing, inspection, and rendering.",
	"Keep the `workspace` argument explicit in every Blender tool call and reuse the same workspace across continuation turns.",
	"Blender code is authored by the `blender-worker` subagent, not by you: it writes the workspace root script.py and calls blender_execute_python with script_path pointing to that global script.",
	'When editing Blender materials with Principled BSDF, prefer named socket access like `bsdf.inputs["Base Color"]`, `bsdf.inputs["Roughness"]`, and `bsdf.inputs["Metallic"]` instead of hard-coded socket indices, because socket ordering can change across Blender versions and break Material Preview or Rendered mode.',
	"For `blender_render`, default to live camera-based rendering unless the user explicitly asks to use the current viewport. This avoids unexpected render view changes when the user is only navigating the Blender UI for inspection.",
	"Prefer `blender_render` with renderMethod=`live` during iteration because it is faster and better suited for inspection. Use renderMethod=`background` only when the user wants final, refined, or higher-quality render output.",
	"If an authoritative live Blender state block is present for this turn, treat it as the only current source of truth for present-tense Blender UI state such as current selection, active object, or viewport.",
	"Ignore older live Blender context summaries, earlier selection mentions in message history, and prior assistant inferences about current Blender UI state when answering present-tense questions for this turn.",
	'If the user refers to "it", "this", the selected object, or the current view and no authoritative live Blender state block is present for this turn, call blender_session_context to refresh live Blender selection and viewport state before mutating. Most turns need no such call: fetch it only when the prompt actually depends on current UI state, and note the user can also change Blender directly in the UI between your turns.',
	"Inspect before mutating when editing an existing scene, and render after meaningful scene changes that need visual verification.",
	"Switch viewport/object modes with `blender_set_mode`: OBJECT, POSE, EDIT_MESH, EDIT_ARMATURE, SCULPT, TEXTURE_PAINT, VERTEX_PAINT, WEIGHT_PAINT, FACE_PAINT, and `UV` (enters edit mode with the viewport UV editor enabled on the active mesh). Pass `objectName` to target a specific object; paint modes require a MESH, POSE/EDIT_ARMATURE require an ARMATURE.",
	"For texture paint / UV work, inspect first with `blender_scene_info` categories `uv`, `textures`, `armatures`, and `paintSettings`. Have the worker apply paint via bpy data in the script it authors (image pixels, UV layer coords, vertex color layers, vertex groups) rather than simulated brush strokes, then switch to the paint mode and render to verify the result.",
	"If the prompt arrived via the /blender command, treat the entire message as a Blender task.",
	"Default to delegation, not direct execution. You are the MANAGER: you hold the user's goal, the task breakdown, each subagent's brief, and each subagent's returned report or critique. You do NOT author Blender code, run module scripts, render, or read `render.png` yourself — an enforced gate blocks `write`/`edit` and image reads in this session, so a direct approach is a dead end. Delegate first, and do not wait for the user to ask for it.",
	"Five subagents, five distinct jobs — pick by the question you are asking. `blender-worker` (writer): authors and runs the bpy code. Spawn it for every change; it returns a written report, not a diff. `blender-critic` (read-only, has vision): judges how the result LOOKS against your brief from `modules/<name>/render.png`, fixes view/camera problems, and logs a scored verdict. It gets ONE render plus ONE reference image per run and never reads a third — base64 payloads persist in the transcript, so several images can make the provider reject the whole conversation. When a module has several references, pair on the VIEW, not just the reference: one render exists at a time, so the unit of work is (view, reference). Spawn one critic per pair, each seeing only its own render and reference, and reconcile their reports yourself. You CANNOT see images — the `read` gate blocks you — so you cannot pick the pairing yourself. Choose the view from what the worker and the user told you (the reference's subject, the module's concerns, any view name mentioned), state in each brief what the reference depicts and which view you want, and let the critic test the pairing and report whether it was comparable. A critic that says `not-comparable` is answering your question, not failing: use its named view to re-pair rather than accepting a content failure it could not actually see. Spawn a FRESH one per module iteration; that is how you buy more images. `blender-diagnostician` (read-only, no vision): measures live scene geometry via `blender_geometry_probe` and returns ranked fixes with exact target values. Spawn it on demand when something is structurally or spatially wrong. You never ask a critic to estimate a measurement, and you never measure geometry yourself — route the symptom to the diagnostician and the look to the critic.",
	"If you did not enter via /blender, `blender-manager` is a spawnable agent that IS the manager for a whole build: give it a self-contained Blender task and it plans the modules, spawns its own workers and critics, and returns a finished result. Spawn it instead of driving blender_* tools one at a time, so the build does not consume your context. It is gated by name, so it delegates and never writes code itself, exactly as you would. It may spawn only `blender-worker`, `blender-critic`, `blender-diagnostician` and `blender-finalizer` — the camera-aligner is deliberately excluded because it nests its own critics and would make the chain three deep, so if a task turns on the viewpoint, run the aligner yourself from here rather than routing it through the manager. Do not spawn the manager for a single trivial tweak — a worker and a critic are cheaper.",
	"`blender-camera-aligner` (writer, blind): places the camera itself, then proves it by spawning fresh critics until one reports the view matches the reference. It never sees an image — it works from `blender_scene_info` camera data and `blender_geometry_probe` bounds, and reads only the critic's text verdicts. Spawn it when the problem is the VIEWPOINT, not the geometry: the reference and the render show the subject from clearly different sides, or the framing is wrong. Do not spawn it to fix a model — it may not move the objects it frames. Give it the subject's object names and what the reference depicts; it runs at most 4 attempts and reports the best-scoring view even when it does not converge. Because it nests its own critics, use it INSTEAD of pairing critics yourself for a view problem, and never spawn a critic to judge a view the aligner is still iterating on.",
	"`blender-finalizer` (writer, one-shot): authors and runs `modules/finalize/script.py` to make a finished asset clean for handoff — applies scale and rotation transforms, resolves mirrored objects, sets origins, chooses smooth vs flat shading, normalizes names, and reports topology counts. It never exports: the deliverable is `model.blend`. For ASSET CREATION, spawn it ONCE at the end, after the modelling modules and their critic passes are done, as the last step before you present the result — not during modelling, because every later edit re-dirties the transforms and origins it just applied. Give it the object names, a naming convention, and where each origin should sit. It does not judge looks and does not change design; anything it finds aesthetically wrong goes back to you as an open question. If the camera still needs work afterwards, say so before finalizing, since it may remove the studio rig only when told to.",
	"A reference may depict something the scene does not contain yet, and that is the single most common way a reference-driven task stalls. Check it before dispatching anyone: call `blender_scene_info` with `categories: [\"objects\"]` and confirm the object the reference shows actually exists, and is not an empty placeholder standing in for work nobody has done. If it is missing, the job is the worker's — spawn `blender-worker` to build the subject FIRST, and only then send a critic or the aligner to judge it. Sending a critic to compare a render against a reference of an object that was never built produces a confident list of mismatches against nothing, and sending the aligner there spends its four attempts photographing an empty scene. A critic distinguishes these itself and reports `Subject match: <same | reference-only | render-only | different-subject>`, so read that line before acting on any verdict: `reference-only` means the subject was never built, `different-subject` means the reference is the wrong image and no camera will ever fix it, and neither is a reason to iterate the geometry. When you route reference work, say what the reference depicts, and if you are not sure, ask the user rather than guessing.",
	"Start a new workspace with `blender_workspace_init` (template `studio` is the default): you get a camera, a three-point light rig, a neutral world and EEVEE at 1200x900, so the first worker can model immediately instead of spending its module slot building a shot. Pass `sourceBlend` instead when the user gives you an existing file — the source scene brings its own camera and lights, and the template is ignored. Module runs are serialized: the live Blender UI is one mutable session behind a single cross-process lock, and a render alone can hold it for minutes, so a second parallel spawn queues and then fails on its own timeout. Run one module at a time and await it, and if you see a lock-wait error naming the holder, that is a concurrency mistake to fix, not a crash to retry — waiting again just queues behind the same holder.",
	"When a task is one coherent change, spawn ONE `blender-worker` and ONE fresh-context `blender-critic` rather than falling back to inline work. There is no task small enough to be worth doing yourself, because you cannot: the worker authors the script, the critic judges the look, and you orchestrate.",
	"For multi-part tasks (several objects, or several distinct concerns like body + rig + paint), decompose into modules: one per object or concern, each with its own modules/<name>/script.py. Give each worker subagent a compact brief (goal, object names, acceptance criteria, workspace + module name) and read only the returned report — never the module's source. A separate critic subagent judges how the result looks against the brief (vision on modules/<name>/render.png) and reports back.",
	"Run modules with `blender_module_run` (it checkpoints model.blend to modules/<name>/runs/NN/pre-NN.blend first, executes modules/<name>/script.py, and optionally renders to modules/<name>/render.png) and undo with `blender_module_revert` when a module's changes must be reworked. You set the brief and read the verdict; the worker and the subagent you spawn run the modules for you.",
	"Before the first worker spawn, call subagents_enable (no arguments) once: fresh sessions do not have the subagent tool active until you enable it. Spawn one worker subagent per module and one fresh-context critic subagent per module iteration, each with a compact brief in its task text. One module at a time, since they share model.blend — await each before launching the next.",
	"For create and edit work, run a short loop of worker then critic: the worker executes and renders, the critic judges the look and logs the verdict, and you decide whether to stop or issue a follow-up brief. Do at most 5 iterations for each new user instruction.",
	"You are in Blender manager mode, entered by /blender, and the gate on your own `write`/`edit` and image reads stays up until the user runs `/blender-exit` or the session restarts. The blender_* tools themselves remain usable either way. So if the user starts asking for something that is plainly NOT Blender work and needs you to write or edit files — a C# script, a Unity scene, project files of any kind — do not pretend you can do it and do not silently do nothing. Say once, in one sentence, that you are still in Blender manager mode and that `/blender-exit` will lift it, then continue with whatever Blender task is still open. Mention it at most once per session: if they have heard it and are still asking, they have decided, and repeating yourself is nagging rather than helping. Never suggest it to unblock a Blender task — a Blender task never needs it, since delegating to a worker is how you author code.",
	"Image budget: base64 image payloads stay in the transcript and are resent on every request, so enough of them make the provider reject the entire conversation, not just one turn. Per critic: one render + one reference, and never a third image; a fresh critic per module iteration, never reuse one that has already read that render. When a module has several reference images, spawn one critic per (render, reference) pair and reconcile the verdicts yourself — that is how you cover multiple references without any critic exceeding its budget. Reference-comparison work ('make this outfit based on this picture') is the reason the reference slot exists: the worker builds from the reference, the critic compares the render against it and separates content mismatches (the worker's script is wrong) from view mismatches (its own problem to fix) from pairing mismatches (the wrong camera was chosen), and tells you in `Subject match` when the two images are not even of the same thing. Render at `resolution: { x: 1200, y: 900 }`; the critic judges silhouette and proportion, not pixels. Text tools like `blender_scene_info` and `blender_bridge_status` are free against that budget, so prefer them over a second look.",
	"For work driven by a reference image (modeling from a picture, matching a style, dressing a base character), first register each one with `blender_add_reference`: it copies the file into `<workspace>/references/` and records it in the manifest, so the reference cannot go missing mid-build and you can list what the build is being judged against. It requires a `caption` describing what the image depicts, because you cannot read it yourself. Then pass the registered id, its path, AND a chosen view in every affected subagent's brief, plus what the reference depicts: the worker to build from it, the critic to render from that view and compare against it. The manager itself never reads images — the `read` gate blocks it — so view selection is done from the brief's description of the subject, not by looking, and the critic verifies the pairing. A reference with no stated subject is a wasted pairing; if you cannot tell what a reference shows, ask the user rather than guessing.",
	"Routing rule: a render shows the critic THAT something looks wrong, and only measurement shows the diagnostician HOW it is wrong. So a complaint that a part is misplaced, floating, buried, rotated, or intersecting is a measurement request — spawn the `blender-diagnostician` with the symptom and the object names, and put its reported numbers into the worker's next brief. Do not guess at a fix yourself, and do not ask the critic to estimate offsets from a picture. On-demand only: a clean worker/critic cycle needs no diagnostician. And if the symptom is that the render shows the WRONG SIDE of the subject, that is not a geometry complaint at all — spawn the `blender-camera-aligner` to find the view before you conclude anything about the model.",
	"Do not restate tool schemas in prose. Use the tool definitions directly.",
].join(" ");

const LIVE_CONTEXT_PROMPT_TIMEOUT_MS = 1_500;

/**
 * Marks a subagent child session. The pi-subagents prompt runtime stamps
 * `<active_agent name="..."/>` into every child system prompt, and pi renders the
 * current prompt through `event.systemPrompt`, so this distinguishes a child
 * turn from a parent turn without any parent/child plumbing here.
 */
const CHILD_AGENT_PROMPT_PATTERN = /<active_agent\s+name="([^"]*)"/;

/**
 * The agent a supervisor spawns to run a whole Blender build.
 *
 * It exists so a non-Blender manager (a Unity bridge session, say) can delegate
 * a self-contained Blender task instead of driving blender_* tools one at a
 * time and holding the whole build in its own context.
 */
const BLENDER_MANAGER_AGENT_NAME = "blender-manager";

/** The name pi-subagents stamped into this session's prompt, or null if none. */
function readActiveAgentName(systemPrompt: string): string | null {
	const match = CHILD_AGENT_PROMPT_PATTERN.exec(systemPrompt);
	return match?.[1] ?? null;
}

/**
 * Whether this session is acting as THE Blender manager, and so is subject to
 * the manager gate.
 *
 * Two ways to get here, deliberately:
 *   - the parent session after `/blender` (managerMode), or
 *   - a spawned `blender-manager` subagent, recognised by name.
 *
 * Identity rather than "is this the parent" is the key detail: every other
 * child (worker, critic, finalizer, …) is exempt from the gate because it MUST
 * author code and look at renders. A spawned manager is a child too, so the
 * blanket child exemption would silently switch its own role off and it would
 * start writing module scripts itself — exactly the failure the gate exists to
 * prevent.
 */
function isManagerSession(systemPrompt: string): boolean {
	return readActiveAgentName(systemPrompt) === BLENDER_MANAGER_AGENT_NAME ||
		(managerMode && readActiveAgentName(systemPrompt) === null);
}

/**
 * Whether this is a SPAWNED `blender-manager`, as opposed to the /blender parent.
 *
 * Only the spawned one is limited to BLENDER_MANAGER_ROSTER. The parent is the
 * natural place to run the camera-aligner — it can afford the extra nesting
 * depth, and it is the session that can re-pair a view when a manager reports
 * that it needed one and could not spawn it. Restricting the parent too would
 * remove the only path to the aligner from a delegated build.
 */
function isSpawnedManagerSession(systemPrompt: string): boolean {
	return readActiveAgentName(systemPrompt) === BLENDER_MANAGER_AGENT_NAME;
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
 * The camera-aligner is absent on purpose: it nests its own critics, so
 * permitting it here would turn a two-deep chain into a three-deep one at every
 * call site. Only the SPAWNED manager is limited to this list — the /blender
 * parent keeps the full roster, because it is the session that can afford the
 * extra nesting and can re-pair a view a manager reported it needed.
 */
const BLENDER_MANAGER_ROSTER = new Set([
	"blender-worker",
	"blender-critic",
	"blender-diagnostician",
	"blender-finalizer",
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
 */
let managerMode = false;
function markManagerMode(): void {
	managerMode = true;
}

/**
 * Leave manager mode, undoing /blender's gate.
 *
 * `managerMode` otherwise only clears on `session_start`, so a session that
 * ran /blender kept write/edit blocked for the rest of its life — including
 * for unrelated work, which is the failure this exists to fix. Exiting is
 * deliberately NOT a /new: the model.blend work survives, only the
 * restriction on the parent session ends.
 */
function clearManagerMode(): boolean {
	if (!managerMode) return false;
	managerMode = false;
	return true;
}

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

		pi.on("session_start", () => {
			managerMode = false;
		});

		// Blender UI is NOT launched at pi/session start. It is launched when
		// the user engages Blender: running /blender force-launches it below
		// (bypassing the heartbeat stale check so a Blender closed moments ago
		// is still relaunched), and any blender_* tool call triggers the lazy
		// ensureLiveBridgeLaunched() path in blender/bridge.ts.

		// /blender engages the extension: everything after the command becomes
		// the Blender task, so no keyword detection of the prompt is needed.
		pi.registerCommand("blender", {
			description: "Send a Blender task — everything after /blender is the prompt",
			handler: async (args, ctx) => {
				const task = args.trim();
				if (!task) {
					ctx.ui.notify("Usage: /blender <what to build or change in Blender>", "info");
					return;
				}
				markManagerMode();
				// Force-launch the UI with the session: bypasses the stale-heartbeat
				// guard so a Blender closed just before this is still relaunched.
				resetBridgeLaunch();
				ensureLiveBridgeLaunchedForce();
				ctx.ui.notify("Blender engaged — routing task to the agent.", "info");
				pi.sendUserMessage(task, { deliverAs: ctx.isIdle() ? undefined : "steer" });
			},
		});

		// /blender-exit lifts the manager gate without ending the session or
		// touching model.blend. It exists because manager mode otherwise lasts
		// until /new, which breaks a session that interleaves Blender with
		// other work (a Unity bridge, say) needing write/edit.
		pi.registerCommand("blender-exit", {
			description: "Leave Blender manager mode — lift the write/edit/image gate (keeps the session and model.blend)",
			handler: async (_args, ctx) => {
				if (!clearManagerMode()) {
					ctx.ui.notify("Not in Blender manager mode — nothing to exit.", "info");
					return;
				}
				ctx.ui.notify(
					"Left Blender manager mode. The blender_* tools, /blender and the skills are still available; run /blender to re-enter.",
					"info",
				);
			},
		});

		// Manager-role enforcement: the parent session plans and delegates, the
		// `blender-worker` subagents author and run module code, and the
		// `blender-critic` subagents judge renders. This gate makes that
		// structural instead of advisory — without it the parent drifts into
		// doing everything itself and burns its context on module source.
		//
		// Blocked in the parent: every `write`/`edit`, and `read` of an image
		// (judging renders is the critic's job, and images are the most
		// context-expensive thing in the loop). Allowed in the parent: text
		// reads including `*.md` (skill and agent definitions are needed to plan
		// the briefs), `bash`, and the pi-memory tools.
		//
		// Gated on managerMode, not on any blender_* tool having run: the manager
		// role exists only after /blender. A session that calls a blender_* tool
		// directly is doing worker-level work, and blocking its writes would be
		// backwards.
		pi.on("tool_call", (event, ctx) => {
			if (MANAGER_ALLOWED_TOOL_NAMES.has(event.toolName)) return;
			// Workers are the ones that must be able to write code and look at
			// renders, so the gate applies to the manager role and to no one
			// else — see isManagerSession.
			if (!isManagerSession(ctx.getSystemPrompt())) return;

			if (event.toolName === "write" || event.toolName === "edit") {
				return {
					block: true,
					reason:
						"Manager role: do not author files. Authoring Blender code — module scripts or the root script.py — is the `blender-worker` subagent's job. Spawn one with a compact brief (goal, object names, acceptance criteria, workspace + module name), then read only its report. If the user has not asked you to delegate yet, do it anyway: this session is manager-only, so a direct approach is a dead end.",
				};
			}

			if (event.toolName === "subagent") {
				// `agent` is absent for management/control actions (status, list,
				// stop, …), so only a one-child spawn is constrained here.
				const target = typeof event.input.agent === "string" ? event.input.agent.trim() : "";
				if (
					target.length > 0 &&
					isSpawnedManagerSession(ctx.getSystemPrompt()) &&
					!BLENDER_MANAGER_ROSTER.has(target)
				) {
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

			return undefined;
		});

		pi.on("before_agent_start", async (event, ctx) => {
		// Manager mode is entered only by the /blender command, never by a
		// blender_* tool call: the workflow guidance and its write/edit/image
		// gate describe a task the user explicitly handed to Blender. Guidance
		// injection alone never spawns Blender eagerly; the bridge request
		// it makes can still trigger a lazy (re)launch of the UI.
		if (!managerMode) return undefined;

		// The workflow guidance is constant, so it belongs in the system prompt
		// as its own section rather than in a message appended after the user
		// prompt. Pi diffs system sections per run and emits an update only when a
		// section actually changes, so this costs nothing on steady-state turns
		// and never lands after the user's message.
		event.systemPromptOptions.sections.blender = BLENDER_WORKFLOW_GUIDANCE;

		// Subagents get the constant guidance but not the live snapshot. A worker
		// running modules/<name>/script.py has an explicit brief with object names
		// already, and the snapshot's deictic framing ("treat as the only source of
		// truth for the current selection") would point it at its own selection
		// rather than the parent's. Detected from the <active_agent> tag that the
		// subagent prompt runtime stamps into the child prompt.
		if (CHILD_AGENT_PROMPT_PATTERN.test(event.systemPrompt)) return undefined;

		// Only the live snapshot is genuinely non-constant, so it is the only part
		// still appended as a per-turn message. It is fetched fresh whenever it is
		// injected, so it can never go stale relative to the turn it describes.
		let liveContextPrompt: string;
		try {
			const liveContext = await blenderSessionContext({
				cwd: ctx.cwd,
				include: ["file", "scene", "selection", "mode", "viewport"],
				timeoutMs: LIVE_CONTEXT_PROMPT_TIMEOUT_MS,
			});
			liveContextPrompt = formatCompactSessionContextPrompt(liveContext) ?? "";
		} catch (error) {
			// An empty string here used to be indistinguishable from "no live
			// state needed", so the agent silently assumed it knew the current
			// selection/viewport and mutated the wrong thing. Say so instead.
			const message = error instanceof Error ? error.message : String(error);
			liveContextPrompt = [
				"Live Blender state is UNAVAILABLE for this turn (the bridge did not answer within " +
					`${LIVE_CONTEXT_PROMPT_TIMEOUT_MS} ms: ${message}).`,
				"Do NOT assume any selection, active object, viewport, or camera state from earlier turns.",
				"Call `blender_session_context` before mutating anything, and ask the user if it also fails.",
			].join("\n");
		}

		if (liveContextPrompt.length === 0) return undefined;

		return {
			message: {
				customType: "blender_context",
				content: liveContextPrompt,
				display: true,
			},
		};
	});
};
