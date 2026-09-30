/**
 * Paths and naming rules shared by the live module runner and the branch
 * runner.
 *
 * These live apart from blender/module.ts rather than beside it so branch.ts
 * can use them without importing the live runner. The live runner is the thing
 * branch runs exist to avoid needing: it pulls in the bridge client and the
 * live-session request helpers, so importing it for a path constant would make
 * every branch run load the code it is deliberately bypassing.
 */

import { join } from "node:path";

/**
 * Module names are constrained because they become path segments, exactly like
 * the instance id in config.ts: "../.." in a module name would resolve
 * `modules/<name>/script.py` out of the workspace, and the result is read and
 * then EXECUTED.
 */
export const MODULE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const MODULE_SCRIPT_FILE = "script.py";
export const MODULE_PREAMBLE_MARKER = "# --- pi-blender module preamble";
/** Read-only pre-run checkpoint from a workspace predating per-run checkpoints. */
export const LEGACY_CHECKPOINT_FILE = "pre.blend";
export const RENDER_FILE = "render.png";

/**
 * The one place a module name is turned into a directory, validated first.
 *
 * Both runners go through this rather than each pattern-matching independently,
 * because the two error messages then cannot drift: a name accepted by one
 * runner and refused by the other is how a module ends up with a branch blend
 * the apply can never find.
 */
export function normalizeModuleName(raw: string): string {
	const moduleName = raw.trim();
	if (!MODULE_NAME_RE.test(moduleName)) {
		throw new Error(
			`Invalid module name "${raw}". Use lowercase letters, digits, and dashes (max 64 chars), e.g. "table-top".`,
		);
	}
	return moduleName;
}

export function getModuleDir(workspacePath: string, moduleName: string): string {
	return join(workspacePath, "modules", moduleName);
}

export function getModuleScriptPath(workspacePath: string, moduleName: string): string {
	return join(getModuleDir(workspacePath, moduleName), MODULE_SCRIPT_FILE);
}

/** Runs directory name for one iteration, e.g. runs/03. */
export function getRunDirName(iteration: number): string {
	return String(iteration).padStart(2, "0");
}

/** Per-run checkpoint name, e.g. pre-03.blend. */
export function getModuleRunCheckpointName(iteration: number): string {
	return `pre-${getRunDirName(iteration)}.blend`;
}

export function getRunDir(workspacePath: string, moduleName: string, iteration: number): string {
	return join(getModuleDir(workspacePath, moduleName), "runs", getRunDirName(iteration));
}

/**
 * Deterministic preamble prepended to every module script, mirroring what
 * blenderExecutePython injects in the root loop.
 *
 * Without it, a module script had to re-derive the workspace and blend paths
 * itself, and its only documented contract (the prose in the skill: "use
 * explicit `workspace`") was not something an error message could point at.
 * Now a worker that gets it wrong sees the contract in its own traceback.
 *
 * The blend path it injects is whichever blend the script is about to run
 * against, which differs by runner: the live runner passes model.blend, the
 * branch runner passes the module's own branch.blend. A script that saved
 * relative to BLEND_PATH therefore behaves the same either way.
 */
export function buildModuleScriptPreamble(workspacePath: string, blendPath: string, moduleName: string): string {
	return [
		"# --- pi-blender module preamble (do not edit) ---",
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
