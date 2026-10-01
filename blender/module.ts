import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLiveBridgeAlive } from "../launch.js";
import { blenderBranchApply, blenderBranchRun } from "./branch.js";
import { requestLiveBlenderExecutePython, requestLiveBlenderReloadBlend, requestLiveBlenderRender } from "./bridge.js";
import type {
	BlenderModuleRunRecord,
	BlenderWorkspaceManifest,
	ModuleRevertOptions,
	ModuleRevertResult,
	ModuleRunOptions,
	ModuleRunResult,
} from "./types.js";
import { fileExists, formatBlenderFailure, getSavedViewCameraObjectName, LIVE_BRIDGE_INIT_TIMEOUT_MS, nowIso } from "./utils.js";
import {
	buildModuleScriptPreamble,
	getModuleDir,
	getModuleRunCheckpointName,
	getModuleScriptPath,
	getRunDir,
	LEGACY_CHECKPOINT_FILE,
	MODULE_PREAMBLE_MARKER,
	MODULE_SCRIPT_FILE,
	normalizeModuleName,
	RENDER_FILE,
} from "./module-paths.js";
import { loadWorkspaceManifest, releaseReservedIteration, updateManifest } from "./workspace.js";

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

/**
 * Run a module, on the live session when there is one and headlessly when there
 * is not.
 *
 * THE FALLBACK IS NOT AN OPTIMIZATION, it is the common case. `/blender` no
 * longer opens a window, so a session that has not run `/blender-watch` has no
 * live session at all — and refusing to run modules there would leave the
 * extension unable to do its main job in its default state. The headless path
 * delegates to the branch machinery and then applies, which is the same work a
 * windowed run does (checkpoint, execute, save, render, record) against the one
 * file that is actually shared.
 *
 * The differences that remain are reported rather than hidden: the run happened
 * in a copy and was merged by an apply, which is visible in
 * `executionMode` and in the moduleRuns record's `viaBranchApply`.
 */
export async function blenderModuleRun(options: ModuleRunOptions): Promise<ModuleRunResult> {
	if (!isLiveBridgeAlive()) {
		return runModuleHeadless(options);
	}
	return runModuleInLiveBlender(options);
}

/**
 * The no-window path: branch, then apply, in one call.
 *
 * Reusing the branch pair rather than writing a second headless executor is
 * deliberate. A module run that has just authored against a copy and merged it
 * back IS a one-module branch apply; the code that decides what a run touched,
 * what the apply moves, and what makes revert possible already exists and is
 * tested for exactly this. A second executor would be a second answer to
 * "which objects does this module own", and the two would drift.
 */
async function runModuleHeadless(options: ModuleRunOptions): Promise<ModuleRunResult> {
	const moduleName = normalizeModuleName(options.moduleName);
	const branchResult = await blenderBranchRun({
		cwd: options.cwd,
		workspace: options.workspace,
		moduleName,
		render: options.render,
		view: options.view,
		resolution: options.resolution,
		samples: options.samples,
		timeoutSeconds: options.timeoutSeconds,
		signal: options.signal,
	});

	// A single staged branch cannot contest itself, so a conflict here would mean
	// the conflict rule is wrong rather than that the operator must choose. It is
	// still reported rather than applied blindly: a merge that silently skipped
	// would leave the caller believing model.blend has the module's work.
	const applyResult = await blenderBranchApply({
		cwd: options.cwd,
		workspace: options.workspace,
		modules: [moduleName],
		signal: options.signal,
	});
	const skipped = applyResult.skipped.filter((entry) => entry.module === moduleName);
	if (skipped.length > 0 || applyResult.missing.includes(moduleName)) {
		throw new Error(
			`Module "${moduleName}" ran headlessly but was NOT merged into model.blend: ` +
				`${skipped[0]?.conflicts.map((conflict) => `this run and ${conflict.modules.filter((name) => name !== moduleName).join(", ")} both touched object "${conflict.objectName}"`).join("; ") ?? "its branch blend went missing"}. ` +
				`The work is intact in ${branchResult.branchPath}. Resolve the conflict and re-run.`,
		);
	}

	return {
		workspacePath: branchResult.workspacePath,
		blendPath: branchResult.blendPath,
		module: branchResult.module,
		moduleDir: branchResult.moduleDir,
		scriptPath: branchResult.scriptPath,
		iteration: branchResult.iteration,
		checkpointPath: branchResult.checkpointPath,
		createdCheckpoint: true,
		stdout: branchResult.stdout.trim(),
		exitCode: branchResult.exitCode,
		renderOutputPath: branchResult.renderOutputPath,
		changed: branchResult.applyObjects.length > 0,
		executionMode: "headless-apply",
		liveBlenderMessage: applyResult.liveBlenderMessage,
		cameras: branchResult.cameras,
	};
}

async function runModuleInLiveBlender(options: ModuleRunOptions): Promise<ModuleRunResult> {
	const moduleName = normalizeModuleName(options.moduleName);

	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const moduleDir = getModuleDir(manifest.workspacePath, moduleName);
	const scriptPath = getModuleScriptPath(manifest.workspacePath, moduleName);
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
	const runDir = getRunDir(manifest.workspacePath, moduleName, iteration);
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

	const checkpointPath = join(runDir, getModuleRunCheckpointName(iteration));
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
			formatBlenderFailure({
				streams: { stdout: result.stdout, stderr: result.stderr },
				subject: `Module "${moduleName}" script failed (exit ${result.exitCode}). The blend was not saved to the workspace, and this failed attempt was not recorded in moduleRuns (nothing to revert — model.blend still holds the pre-run state, backstopped by ${checkpointPath}).\nScript that ran: ${effectiveScriptPath}\nSource: ${scriptPath}`,
			}),
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
		applySuccessfulRun(
			current,
			{ moduleName, iteration, sequence, checkpointPath, exitCode: result.exitCode },
			renderOutputPath ? { path: renderOutputPath, view: viewLabel } : null,
		);
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
		executionMode: "live-session",
	};
}

/**
 * Fold a successful module run into the manifest state on disk.
 *
 * Extracted from the run itself so the one rule that matters here is a rule
 * with a test, rather than a line buried in a function that cannot run without
 * a Blender UI to talk to.
 *
 * THE RULE: the iteration counter only ever goes up. It is claimed under the
 * manifest lock before the script runs, and the run can take minutes, so by the
 * time it succeeds the number on disk may already be higher — a later module
 * run, or an ad-hoc blender_execute_python, having claimed and finished in the
 * meantime. Publishing this run's own (older) number unconditionally walks the
 * counter back, and the damage is not a cosmetic one:
 *
 *   - the next run claims the same number again and writes into the SAME
 *     runs/NN directory, overwriting a completed run's script, log and
 *     checkpoint;
 *   - moduleRuns then holds two records with the same sequence, and
 *     blender_module_revert decides what "later" means by comparing sequences,
 *     so the guard that refuses to discard another module's work silently
 *     stops working.
 *
 * Reclaiming the number happened on the failure path, in
 * releaseReservedIteration, which only lowers it when no later run has claimed
 * a higher one.
 */
export function applySuccessfulRun(
	current: BlenderWorkspaceManifest,
	record: {
		moduleName: string;
		iteration: number;
		sequence: number;
		checkpointPath: string;
		exitCode: number;
	},
	renderOutput?: { path: string; view: string } | null,
): void {
	current.latestIteration = Math.max(current.latestIteration, record.iteration);
	current.moduleRuns = [
		...(current.moduleRuns ?? []),
		{
			name: record.moduleName,
			iteration: record.iteration,
			checkpointPath: record.checkpointPath,
			at: nowIso(),
			sequence: record.sequence,
			exitCode: record.exitCode,
			status: "ok",
		},
	];
	if (renderOutput) {
		current.renderOutputs.push({
			path: renderOutput.path,
			view: renderOutput.view,
			iteration: record.iteration,
			createdAt: nowIso(),
			module: record.moduleName,
		});
	}
}

export async function blenderModuleRevert(options: ModuleRevertOptions): Promise<ModuleRevertResult> {
	const moduleName = normalizeModuleName(options.moduleName);
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const moduleRuns = getModuleRuns(manifest);

	// Prefer the recorded history: it tells us exactly which blend state this
	// checkpoint represents and what would be silently discarded.
	const target = options.iteration !== undefined
		? moduleRuns.find((run) => run.name === moduleName && run.iteration === options.iteration)
		: getLatestRun(manifest, moduleName);
	const checkpointPath = target?.checkpointPath ?? join(getModuleDir(manifest.workspacePath, moduleName), LEGACY_CHECKPOINT_FILE);

	if (!(await fileExists(checkpointPath))) {
		// Distinct from "there is no such recorded run", because a caller who
		// asked for iteration N and gets this has been given no way to tell
		// that N was never run from N having been recorded and then lost. The
		// history is the only place that distinction is recorded at all.
		if (target) {
			throw new Error(
				`Recorded checkpoint for module "${moduleName}" iteration ${target.iteration} is missing at ${checkpointPath}. Nothing to revert.`,
			);
		}
		if (options.iteration !== undefined) {
			const known = moduleRuns.filter((run) => run.name === moduleName).map((run) => run.iteration);
			throw new Error(
				`No recorded run of module "${moduleName}" at iteration ${options.iteration}${
					known.length > 0
						? `. Recorded iterations: ${known.join(", ")}.`
						: ". That module has no recorded runs at all — its history is in moduleRuns, so an iteration was probably never claimed, or the manifest was restored from an older copy."
				} Nothing to revert.`,
			);
		}
		throw new Error(
			`No checkpoint for module "${moduleName}" at ${checkpointPath}. Nothing to revert.`,
		);
	}

	// Guard against the destructive case: reverting module A after module B ran
	// throws away B's work too, because they share one model.blend.
	const laterRuns = moduleRuns.filter((run) => run.sequence > (target?.sequence ?? Number.MAX_SAFE_INTEGER));
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
	// This runs whether or not a record was found, and the filter depends on
	// which. With a target, its own record and everything after it no longer
	// describe model.blend, so they are dropped. WITHOUT one, the only reason
	// we got here is the legacy pre.blend path — there is no sequence to
	// compare against, so keeping everything is the only non-destructive
	// option: dropping the whole history would remove a later run's ability to
	// revert itself, and the only durable record of it.
	//
	// The merge is against the state on disk, so a run that landed since this
	// snapshot is filtered by the same rule rather than being clobbered.
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
