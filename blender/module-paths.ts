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

import { readdir, rm } from "node:fs/promises";
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
 * How many run directories -- and therefore checkpoints -- survive per module.
 *
 * Every run copies model.blend whole, so an uncapped history turns a
 * multi-iteration loop into gigabytes nobody can navigate. The floor is set by
 * what the tools still need: blender_compare renders the PREVIOUS generation as
 * its baseline, so one generation is the absolute minimum, and
 * blender_module_revert can be pointed at any recorded iteration, so a small
 * history keeps the useful reverts reachable without asking for force.
 */
export const DEFAULT_CHECKPOINT_RETENTION = 5;

/**
 * Iterations whose run directory may be deleted once `latestIteration` exists.
 *
 * Pure so the retention rule is testable without touching a filesystem, and so
 * the live and branch runners cannot disagree about what to keep.
 */
export function planCheckpointRetention(latestIteration: number, keep = DEFAULT_CHECKPOINT_RETENTION): number[] {
	const window = Math.max(1, Math.trunc(keep));
	const floor = latestIteration - window + 1;
	const prunable: number[] = [];
	for (let iteration = 1; iteration < floor; iteration += 1) prunable.push(iteration);
	return prunable;
}

/**
 * Delete run directories older than the retention window.
 *
 * Best-effort by design: a leftover checkpoint costs disk, a failed history
 * operation mid-loop costs the session. Manifest records are deliberately left
 * alone -- blender_module_revert already reports a recorded-but-deleted
 * checkpoint as missing, which is a truer history than silently rewriting it.
 */
export async function pruneOldModuleRuns(
	workspacePath: string,
	moduleName: string,
	latestIteration: number,
	keep = DEFAULT_CHECKPOINT_RETENTION,
): Promise<number[]> {
	const prunable = planCheckpointRetention(latestIteration, keep);
	if (prunable.length === 0) return [];
	const wanted = new Set(prunable.map((iteration) => getRunDirName(iteration)));
	const runsRoot = join(getModuleDir(workspacePath, moduleName), "runs");
	let entries: string[];
	try {
		entries = await readdir(runsRoot);
	} catch {
		return [];
	}
	const removed: number[] = [];
	for (const entry of entries) {
		const iteration = Number.parseInt(entry, 10);
		if (!wanted.has(entry) || !Number.isFinite(iteration)) continue;
		try {
			await rm(join(runsRoot, entry), { recursive: true, force: true });
			removed.push(iteration);
		} catch {
			// Left on disk; the next run tries again.
		}
	}
	return removed.sort((a, b) => a - b);
}

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
