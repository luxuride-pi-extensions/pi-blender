import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requestLiveBlenderReadOnlyPython } from "./bridge.js";
import type { ReadOnlyPythonOptions, ReadOnlyPythonResult } from "./types.js";
import { formatBlenderFailure, LIVE_BRIDGE_TIMEOUT_MS } from "./utils.js";
import { ensureWorkspaceInitialized, loadWorkspaceManifest } from "./workspace.js";

/**
 * Exit code the bridge uses for a REFUSAL, as opposed to a script that failed.
 * The two are different answers: a refusal names an operation outside the
 * role's scope, so the caller can rewrite the script, while a failure means
 * the script itself is wrong.
 */
const REFUSED = 2;

export async function blenderReadOnlyPython(options: ReadOnlyPythonOptions): Promise<ReadOnlyPythonResult> {
	const initResult = await ensureWorkspaceInitialized({
		cwd: options.cwd,
		workspace: options.workspace,
		continueExisting: true,
		signal: options.signal,
	});
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const runDir = join(manifest.workspacePath, "runs", "ad-hoc", `readonly-${Date.now()}-${process.pid}`);
	await mkdir(runDir, { recursive: true });
	const scriptPath = join(runDir, "script.py");
	// Kept next to the run so a refusal can be read against the exact text that
	// caused it.
	await writeFile(scriptPath, options.script, "utf-8");

	const result = await requestLiveBlenderReadOnlyPython({
		blendPath: manifest.blendPath,
		workspacePath: manifest.workspacePath,
		iterationPath: runDir,
		userScriptPath: scriptPath,
		timeoutMs: options.timeoutMs ?? LIVE_BRIDGE_TIMEOUT_MS,
		signal: options.signal,
	});

	if (result.exitCode === REFUSED) {
		return {
			workspacePath: initResult.workspacePath,
			blendPath: manifest.blendPath,
			scriptPath,
			runDir,
			stdout: result.stdout,
			stderr: result.stderr,
			exitCode: result.exitCode,
			refused: true,
		};
	}
	if (result.exitCode !== 0) {
		throw new Error(
			formatBlenderFailure({
				streams: { stdout: result.stdout, stderr: result.stderr },
				subject: `Read-only script failed (exit ${result.exitCode})`,
			}),
		);
	}

	return {
		workspacePath: initResult.workspacePath,
		blendPath: manifest.blendPath,
		scriptPath,
		runDir,
		stdout: result.stdout,
		stderr: result.stderr,
		exitCode: result.exitCode,
		refused: false,
	};
}
