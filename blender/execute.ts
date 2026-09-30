import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requestLiveBlenderExecutePython } from "./bridge.js";
import type { ExecutePythonOptions, ExecutePythonResult } from "./types.js";
import { fileExists, formatBlenderFailure, normalizeUserPath } from "./utils.js";
import {
	ensureWorkspaceInitialized,
	ensureWorkspaceScriptExists,
	getIterationPaths,
	loadWorkspaceManifest,
	releaseReservedIteration,
	updateManifest,
} from "./workspace.js";

export async function blenderExecutePython(options: ExecutePythonOptions): Promise<ExecutePythonResult> {
	const initResult = await ensureWorkspaceInitialized({
		cwd: options.cwd,
		workspace: options.workspace,
		continueExisting: true,
		signal: options.signal,
	});
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const workspaceScriptPath = await ensureWorkspaceScriptExists(manifest.workspacePath);
	const sourceScriptPath = normalizeUserPath(options.cwd, options.script_path);
	// Validate before claiming an iteration: throwing after the claim would
	// strand the number, because this path has no releaseReservedIteration
	// (only a Blender failure does).
	if (sourceScriptPath !== workspaceScriptPath) {
		throw new Error(
			`blender_execute_python expects script_path to point to the workspace root script: ${workspaceScriptPath}`,
		);
	}
	if (!(await fileExists(sourceScriptPath))) {
		throw new Error(`Blender script not found: ${sourceScriptPath}`);
	}

	// Claim the iteration under the manifest lock instead of reading
	// latestIteration from a snapshot: a concurrent blender_module_run (or a
	// parallel pi session) would otherwise compute the same N+1 and both runs
	// would write into the same iteration_NN directory.
	//
	// The claim MUST be assigned onto `current` — updateManifest persists the
	// mutated manifest, not the callback's return value. A callback that only
	// returned the number published nothing, so every run re-derived 1 and
	// clobbered the previous run's directory.
	//
	// An unclaimed run still needs a private directory for its copied script
	// and log, or concurrent ad-hoc runs would overwrite each other. The
	// timestamp-and-pid suffix keeps those unique without touching the
	// manifest, so a throwaway camera nudge no longer shows up as progress.
	const claimIteration = options.claimIteration ?? true;
	let iteration: number | null = null;
	let runDir: string;
	if (claimIteration) {
		const claimed = await updateManifest(
			manifest.manifestPath,
			(current) => {
				const value = current.latestIteration + 1;
				current.latestIteration = value;
				return { iteration: value, iterationDir: getIterationPaths(current.workspacePath, value).iterationDir };
			},
			{ signal: options.signal },
		);
		iteration = claimed.iteration;
		runDir = claimed.iterationDir;
	} else {
		runDir = join(
			manifest.workspacePath,
			"runs",
			"ad-hoc",
			`${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
		);
	}
	await mkdir(runDir, { recursive: true });

	const scriptPath = join(runDir, "script.py");
	const logPath = join(runDir, "blender.log");
	await copyFile(sourceScriptPath, scriptPath);

	const result = await requestLiveBlenderExecutePython({
		blendPath: manifest.blendPath,
		workspacePath: manifest.workspacePath,
		iterationPath: runDir,
		userScriptPath: scriptPath,
		saveBeforePath: options.saveBefore ? join(runDir, "model.before.blend") : undefined,
		saveAfter: options.saveAfter ?? true,
		label: options.label,
		timeoutMs: (options.timeoutSeconds ?? 120) * 1000,
		signal: options.signal,
	});

	// Record the run dir even on failure: it holds the copied script and
	// the log for exactly the run that failed, which is the first thing anyone
	// debugging wants. A claimed counter was reserved above, so give the number
	// back on failure — a failed run must not look like progress in the manifest.
	await writeFile(logPath, `${result.stdout}${result.stderr}`, "utf-8");
	if (result.exitCode !== 0) {
		if (iteration !== null) {
			await releaseReservedIteration(manifest.manifestPath, iteration).catch(() => undefined);
		}
		// Both streams, not stderr-or-stdout: a failing script's traceback is on
		// stderr and its own diagnostics are usually on stdout, so preferring
		// stderr throws away the half that explains what the script was doing.
		throw new Error(
			formatBlenderFailure({
				streams: { stdout: result.stdout, stderr: result.stderr },
				subject: `Blender exited with code ${result.exitCode}`,
			}),
		);
	}

	return {
		workspacePath: initResult.workspacePath,
		blendPath: initResult.blendPath,
		manifestPath: initResult.manifestPath,
		iteration,
		sourceScriptPath,
		runDir,
		scriptPath,
		logPath,
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		changed: result.changed,
	};
}
