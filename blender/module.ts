import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLiveBridgeAlive } from "../launch.js";
import { requestLiveBlenderExecutePython, requestLiveBlenderReloadBlend, requestLiveBlenderRender } from "./bridge.js";
import type {
	BlenderModuleRunRecord,
	ModuleRevertOptions,
	ModuleRevertResult,
	ModuleRunOptions,
	ModuleRunResult,
} from "./types.js";
import { fileExists, getSavedViewCameraObjectName, LIVE_BRIDGE_INIT_TIMEOUT_MS, nowIso } from "./utils.js";
import { loadWorkspaceManifest, releaseReservedIteration, updateManifest } from "./workspace.js";

const MODULE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MODULE_SCRIPT_FILE = "script.py";
const MODULE_PREAMBLE_MARKER = "# --- vibe-blender module preamble";
/** Read-only pre-run checkpoint from a workspace predating per-run checkpoints. */
const LEGACY_CHECKPOINT_FILE = "pre.blend";
const RENDER_FILE = "render.png";

/**
 * Default module-render resolution.
 *
 * The bridge falls back to the scene's own settings when a request omits
 * `resolution` (blender/live-bridge.py), and a fresh blend carries Blender's
 * 1920x1080. That produced ~2.9x the pixels the guidance tells subagents to
 * render at, which matters because these renders are the critic's image
 * budget: base64 payloads persist in the transcript and are resent every
 * request, so 3.7MB per render versus 1.3MB is the difference between one
 * image and a provider rejection. The guidance value is applied HERE, at the
 * single place every module run funnels through, so it holds for the tool,
 * the module runner, and any future caller alike — a schema-level default
 * would only cover the model that remembered to pass it.
 */
const DEFAULT_MODULE_RENDER_RESOLUTION = { x: 1200, y: 900 } as const;

function getModuleDir(workspacePath: string, moduleName: string): string {
	return join(workspacePath, "modules", moduleName);
}

/**
 * Deterministic preamble prepended to every module script, mirroring what
 * blenderExecutePython injects in the root loop.
 *
 * Without it, a module script had to re-derive the workspace and blend paths
 * itself, and its only documented contract (the prose in the skill: "use
 * explicit `workspace`") was not something an error message could point at.
 * Now a worker that gets it wrong sees the contract in its own traceback.
 */
export function buildModuleScriptPreamble(workspacePath: string, blendPath: string, moduleName: string): string {
	return [
		"# --- vibe-blender module preamble (do not edit) ---",
		`# workspace: ${workspacePath}`,
		`# module: ${moduleName}`,
		``,
		"import bpy",
		``,
		`WORKSPACE_PATH = r"${workspacePath}"`,
		`BLEND_PATH = r"${blendPath}"`,
		`MODULE_NAME = r"${moduleName}"`,
		``,
		"# --- end preamble ---",
		``,
		"",
	].join("\n");
}

/** Runs directory name for one iteration, e.g. runs/03. */
function getRunDirName(iteration: number): string {
	return String(iteration).padStart(2, "0");
}

/** Per-run checkpoint name, e.g. pre-03.blend. */
function getRunCheckpointName(iteration: number): string {
	return `pre-${getRunDirName(iteration)}.blend`;
}

function getLatestRun(manifest: { moduleRuns?: BlenderModuleRunRecord[] }, moduleName: string): BlenderModuleRunRecord | undefined {
	return [...(manifest.moduleRuns ?? [])].reverse().find((run) => run.name === moduleName);
}

/**
 * Read the run records safely — an older manifest (version 2 without
 * moduleRuns) is valid and simply has no history yet.
 */
function getModuleRuns(manifest: { moduleRuns?: BlenderModuleRunRecord[] }): BlenderModuleRunRecord[] {
	return manifest.moduleRuns ?? [];
}

export async function blenderModuleRun(options: ModuleRunOptions): Promise<ModuleRunResult> {
	const moduleName = options.moduleName.trim();
	if (!MODULE_NAME_RE.test(moduleName)) {
		throw new Error(
			`Invalid module name "${options.moduleName}". Use lowercase letters, digits, and dashes (max 64 chars), e.g. "table-top".`,
		);
	}

	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const moduleDir = getModuleDir(manifest.workspacePath, moduleName);
	const scriptPath = join(moduleDir, MODULE_SCRIPT_FILE);
	if (!(await fileExists(scriptPath))) {
		throw new Error(
			`Module script not found: ${scriptPath}. Write the module's bpy script there first (worker agent), then run it.`,
		);
	}

	await mkdir(moduleDir, { recursive: true });

	// Module scripts run against the same implicit contract as the root loop,
	// but nothing made that contract executable: WORKSPACE_PATH/BLEND_PATH did
	// not exist for module code. Inject a preamble into a run-local copy so the
	// worker's own traceback names the contract it broke. The module source
	// stays exactly what the worker wrote.
	const rawScript = await readFile(scriptPath, "utf-8");
	const hasPreamble = rawScript.includes(MODULE_PREAMBLE_MARKER);

	// Claim the iteration under the manifest lock, not from this snapshot:
	// a concurrent blender_execute_python (or a parallel pi session) would
	// otherwise compute the same N+1, and the two runs would share a
	// runs/NN directory and clobber each other's manifest fields.
	//
	// The claim is published immediately (an unclaimed N+1 could be handed out
	// twice while this run spends minutes inside Blender) and given back on
	// failure, so a failed run does not look like progress. A crash mid-run
	// leaves the number claimed — correct, since the iteration dir and the run
	// log for it do exist on disk.
	//
	// The claim MUST be assigned onto `current` — updateManifest persists the
	// mutated manifest, not the callback's return value. A callback that only
	// returned the number published nothing, so every run re-derived the same
	// N+1 and clobbered the previous run's runs/NN directory.
	//
	// `sequence` is the claimed iteration, not `max(moduleRuns) + 1`. The
	// history only ever records SUCCESSFUL runs, so two runs overlapping
	// inside Blender both computed max+1 from the same base and collided on
	// sequence 1 — and blender_module_revert decides what "later" means by
	// comparing sequences, so the guard against discarding another module's
	// work silently failed. The claimed iteration is unique by construction
	// (it is claimed under this lock) and orders runs exactly as the history
	// did. Existing records keep their recorded sequence, and because a legacy
	// sequence is always <= its iteration, the comparison stays monotonic
	// across the upgrade.
	const { iteration, sequence } = await updateManifest(
		manifest.manifestPath,
		(current) => {
			const claimedIteration = current.latestIteration + 1;
			current.latestIteration = claimedIteration;
			return { iteration: claimedIteration, sequence: claimedIteration };
		},
		{ signal: options.signal },
	);

	// Per-run checkpoint: this is the blend state immediately before THIS run,
	// and the only checkpoint this function writes. A rolling modules/<name>/pre.blend
	// used to be written too, doubling blend I/O every run while silently
	// drifting from any real checkpoint; it is now read-only, consulted only to
	// revert workspaces created before per-run checkpoints existed.
	const runDir = join(moduleDir, "runs", getRunDirName(iteration));
	await mkdir(runDir, { recursive: true });

	let effectiveScriptPath = scriptPath;
	if (!hasPreamble) {
		effectiveScriptPath = join(runDir, MODULE_SCRIPT_FILE);
		await writeFile(
			effectiveScriptPath,
			buildModuleScriptPreamble(manifest.workspacePath, manifest.blendPath, moduleName) + rawScript,
			"utf-8",
		);
	}

	const checkpointPath = join(runDir, getRunCheckpointName(iteration));
	await copyFile(manifest.blendPath, checkpointPath);

	const result = await requestLiveBlenderExecutePython({
		blendPath: manifest.blendPath,
		workspacePath: manifest.workspacePath,
		iterationPath: runDir,
		userScriptPath: effectiveScriptPath,
		saveBeforePath: undefined,
		saveAfter: true,
		label: `module:${moduleName}`,
		timeoutMs: (options.timeoutSeconds ?? 120) * 1000,
		signal: options.signal,
	});
	if (result.exitCode !== 0) {
		await releaseReservedIteration(manifest.manifestPath, iteration).catch(() => undefined);
		// Point at the script that actually ran (the preamble injection may
		// have used the run-local copy, not the module source file).
		throw new Error(
			`Module "${moduleName}" script failed (exit ${result.exitCode}). The blend was not saved to the workspace, and this failed attempt was not recorded in moduleRuns (nothing to revert — model.blend still holds the pre-run state, backstopped by ${checkpointPath}).\nScript that ran: ${effectiveScriptPath}\nSource: ${scriptPath}\n${result.stderr.trim() || result.stdout.trim()}`,
		);
	}

	let renderOutputPath: string | null = null;
	let viewLabel = options.view ?? "active-camera";
	if (options.render) {
		let cameraName: string | undefined;
		const savedView = options.view ? manifest.savedViews[options.view] : undefined;
		if (savedView) {
			cameraName = getSavedViewCameraObjectName(savedView) ?? undefined;
		} else if (options.view && options.view !== "active-camera") {
			// Accept either a named camera object or a saved view; "active-camera"
			// keeps the UI's current camera, same as blender_render.
			cameraName = options.view;
		} else {
			viewLabel = "active-camera";
		}
		const renderPath = join(moduleDir, RENDER_FILE);
		const renderPayload = await requestLiveBlenderRender({
			blendPath: manifest.blendPath,
			cameraName,
			outputPath: renderPath,
			viewSource: "camera",
			viewportShading: options.viewportShading ?? "material-preview",
			resolution: options.resolution ?? DEFAULT_MODULE_RENDER_RESOLUTION,
			samples: options.samples,
			signal: options.signal,
			timeoutMs: 360_000,
		});
		// Registered in the manifest below (together with the run record), like
		// blender_render does, so the manager and critic can find the newest
		// render for any iteration without guessing between iteration_XX/renders/
		// and modules/<name>/.
		renderOutputPath = renderPayload.outputPath;
	}

	// Publish success: iteration counter, run history, and render output all
	// land in one manifest write, applied to the state on disk (not this
	// snapshot) so a concurrent render or save-view is merged, not lost.
	await updateManifest(manifest.manifestPath, (current) => {
		current.latestIteration = iteration;
		current.moduleRuns = [
			...(current.moduleRuns ?? []),
			{
				name: moduleName,
				iteration,
				checkpointPath,
				at: nowIso(),
				sequence,
				exitCode: result.exitCode,
				status: "ok",
			},
		];
		if (renderOutputPath) {
			current.renderOutputs.push({
				path: renderOutputPath,
				view: viewLabel,
				iteration,
				createdAt: nowIso(),
				module: moduleName,
			});
		}
	});

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		module: moduleName,
		moduleDir,
		scriptPath,
		iteration,
		checkpointPath,
		createdCheckpoint: true,
		stdout: result.stdout.trim(),
		exitCode: result.exitCode,
		renderOutputPath,
		changed: result.changed,
	};
}

export async function blenderModuleRevert(options: ModuleRevertOptions): Promise<ModuleRevertResult> {
	const moduleName = options.moduleName.trim();
	if (!MODULE_NAME_RE.test(moduleName)) {
		throw new Error(`Invalid module name "${options.moduleName}".`);
	}
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const moduleRuns = getModuleRuns(manifest);

	// Prefer the recorded history: it tells us exactly which blend state this
	// checkpoint represents and what would be silently discarded.
	const target = options.iteration !== undefined
		? moduleRuns.find((run) => run.name === moduleName && run.iteration === options.iteration)
		: getLatestRun(manifest, moduleName);
	const checkpointPath = target?.checkpointPath ?? join(getModuleDir(manifest.workspacePath, moduleName), LEGACY_CHECKPOINT_FILE);

	if (!(await fileExists(checkpointPath))) {
		throw new Error(
			target
				? `Recorded checkpoint for module "${moduleName}" iteration ${target.iteration} is missing at ${checkpointPath}. Nothing to revert.`
				: `No checkpoint for module "${moduleName}" at ${checkpointPath}. Nothing to revert.`,
		);
	}

	// Guard against the destructive case: reverting module A after module B ran
	// throws away B's work too, because they share one model.blend.
	const laterRuns = target
		? moduleRuns.filter((run) => run.sequence > target.sequence)
		: [];
	const discardedLaterRuns = laterRuns.map((run) => `${run.name} (iteration ${run.iteration})`);
	if (laterRuns.length > 0 && !options.force) {
		const names = [...new Set(laterRuns.map((run) => run.name))].join(", ");
		throw new Error(
			`Refusing to revert module "${moduleName}" iteration ${target?.iteration}: ${laterRuns.length} later module run(s) also modified model.blend (${names}). Reverting now would discard their work. Revert those modules first, or pass force: true to accept the loss.`,
		);
	}

	await copyFile(checkpointPath, manifest.blendPath);

	// The blend content changed underneath the recorded history, so the history
	// past this point is no longer an accurate description of model.blend.
	// Merge under the manifest lock, and derive the surviving set from the runs
	// on disk so a run that landed since this snapshot is not silently dropped.
	await updateManifest(
		manifest.manifestPath,
		(current) => {
			current.moduleRuns = target
				? (current.moduleRuns ?? []).filter((run) => run.sequence < target.sequence)
				: (current.moduleRuns ?? []);
		},
		{ signal: options.signal },
	);

	const warning = discardedLaterRuns.length > 0
		? `This revert also discarded ${discardedLaterRuns.length} later module run(s): ${discardedLaterRuns.join(", ")}.`
		: null;

	try {
		await requestLiveBlenderReloadBlend({
			blendPath: manifest.blendPath,
			signal: options.signal,
			// Same reasoning as workspace init: a short best-effort budget is
			// only right when a UI is already up. If Blender was closed between
			// the module run and this revert, let the bridge apply its own
			// cold-start budget instead of failing after 5 s.
			timeoutMs: isLiveBridgeAlive() ? LIVE_BRIDGE_INIT_TIMEOUT_MS : undefined,
		});
		return {
			workspacePath: manifest.workspacePath,
			blendPath: manifest.blendPath,
			module: moduleName,
			checkpointPath,
			revertedIteration: target?.iteration ?? 0,
			openedInLiveBlender: true,
			liveBlenderMessage: "Reverted model.blend to the module's pre-run checkpoint and reloaded it in the live Blender session.",
			discardedLaterRuns,
			warning,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			workspacePath: manifest.workspacePath,
			blendPath: manifest.blendPath,
			module: moduleName,
			checkpointPath,
			revertedIteration: target?.iteration ?? 0,
			openedInLiveBlender: false,
			liveBlenderMessage: `Reverted model.blend, but the live Blender session did not reload it automatically: ${message}`,
			discardedLaterRuns,
			warning,
		};
	}
}
