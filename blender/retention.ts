/**
 * Workspace retention.
 *
 * Checkpoints have their own bounded history; iteration renders and copied
 * references do not. A workspace that runs several modules through several
 * iterations otherwise grows a render set per iteration with no stated policy
 * and no way to see what deleting one would cost.
 *
 * This is deliberately NOT part of a run: a run must never delete the evidence
 * a critic may still be reading. Pruning is an explicit, dry-run-first call.
 */

import { lstat, readdir, rm, rmdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { parseCritiqueLog } from "./ranking.js";
import { markBranchRetired, planBlendStorage } from "./blend-storage.js";
import type { BlenderWorkspaceManifest, WorkspacePruneResult } from "./types.js";
import { getWorkspaceCritiqueLogPath, loadWorkspaceManifest } from "./workspace.js";
import { readFile } from "node:fs/promises";

const DEFAULT_KEEP_ITERATIONS = 2;

interface FileEntry {
	path: string;
	bytes: number;
	module?: string;
	iteration: number;
	kind?: "render" | "checkpoint" | "branch";
}

/** True when `path` resolves inside `root`; a symlink out of the tree is not. */
function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function walkFiles(dir: string): Promise<string[]> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry);
		// lstat, not stat: a link to a copied reference or to the user's home
		// must be reported as a link, never followed and then deleted.
		const info = await lstat(path).catch(() => undefined);
		if (!info) continue;
		if (info.isSymbolicLink()) files.push(path);
		else if (info.isDirectory()) files.push(...(await walkFiles(path)));
		else files.push(path);
	}
	return files;
}

/**
 * Render paths that must survive whatever their iteration:
 * the newest render for each module, and the render the module's latest
 * critique was based on. Deleting either would remove the picture the loop is
 * currently reasoning about.
 */
function protectedRenders(manifest: BlenderWorkspaceManifest, latestCritiqueIteration: Map<string, number>): Map<string, string> {
	const kept = new Map<string, string>();
	const newest = new Map<string, { path: string; iteration: number; createdAt: string }>();
	for (const output of manifest.renderOutputs) {
		if (!output.module) continue;
		const current = newest.get(output.module);
		if (
			!current ||
			output.iteration > current.iteration ||
			(output.iteration === current.iteration && output.createdAt > current.createdAt)
		) {
			newest.set(output.module, output);
		}
	}
	for (const [moduleName, output] of newest) {
		kept.set(output.path, `newest render for ${moduleName}`);
	}
	for (const [moduleName, iteration] of latestCritiqueIteration) {
		const matching = manifest.renderOutputs
			.filter((output) => output.module === moduleName && output.iteration === iteration)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const output =
			matching[0] ??
			// blender_render writes renders with no module attached; if that was
			// the picture a critique judged, fall back to the newest render of
			// that iteration rather than leave it unprotected.
			manifest.renderOutputs
				.filter((candidate) => candidate.iteration === iteration)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
		if (output) kept.set(output.path, `render judged by ${moduleName}'s latest critique`);
	}
	return kept;
}

export async function blenderWorkspacePrune(options: {
	cwd: string;
	workspace: string;
	/** Report without deleting. Defaults to true on purpose. */
	dryRun?: boolean;
	/** How many of the newest iterations stay. Default 2, minimum 1. */
	keepIterations?: number;
	/** Include old checkpoints over the global budget. */
	includeCheckpoints?: boolean;
	/** Include applied branch files whose checkpoint already made them history. */
	includeBranches?: boolean;
	signal?: AbortSignal;
}): Promise<WorkspacePruneResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const keepIterations = options.keepIterations ?? DEFAULT_KEEP_ITERATIONS;
	if (!Number.isInteger(keepIterations) || keepIterations < 1) {
		throw new Error(`keepIterations must be a whole number of at least 1; got ${keepIterations}. Keeping zero would delete the render the current critique was judged from.`);
	}
	const dryRun = options.dryRun ?? true;
	const latestIteration = Number.isFinite(manifest.latestIteration) ? manifest.latestIteration : 0;
	const cutoff = latestIteration - keepIterations;

	let latestCritiqueIteration = new Map<string, number>();
	try {
		const entries = parseCritiqueLog(await readFile(getWorkspaceCritiqueLogPath(manifest.workspacePath), "utf8"));
		for (const entry of entries) {
			if (entry.iteration !== undefined) latestCritiqueIteration.set(entry.moduleName, entry.iteration);
		}
	} catch {
		latestCritiqueIteration = new Map();
	}
	const kept = protectedRenders(manifest, latestCritiqueIteration);

	const candidates: FileEntry[] = [];
	const seen = new Set<string>();
	for (const output of manifest.renderOutputs) {
		if (output.iteration > cutoff) continue;
		if (kept.has(output.path)) continue;
		if (!isInside(manifest.workspacePath, output.path)) continue;
		const info = await stat(output.path).catch(() => undefined);
		if (!info?.isFile()) continue;
		seen.add(output.path);
		candidates.push({ path: output.path, bytes: info.size, module: output.module, iteration: output.iteration, kind: "render" });
	}

	const unlisted: FileEntry[] = [];
	for (let iteration = 0; iteration <= cutoff; iteration += 1) {
		const rendersDir = join(manifest.workspacePath, `iteration_${String(iteration).padStart(2, "0")}`, "renders");
		for (const path of await walkFiles(rendersDir)) {
			if (seen.has(path) || kept.has(path) || !isInside(manifest.workspacePath, path)) continue;
			const info = await stat(path).catch(() => undefined);
			if (!info?.isFile()) continue;
			seen.add(path);
			unlisted.push({ path, bytes: info.size, iteration, kind: "render" });
		}
	}

	const blendPlan = await planBlendStorage(manifest, {
		includeCheckpoints: options.includeCheckpoints === true,
		includeBranches: options.includeBranches === true,
	});
	const blendEntries: FileEntry[] = [...blendPlan.checkpoints, ...blendPlan.branches].map((entry) => ({
		path: entry.path,
		bytes: entry.bytes,
		module: entry.module,
		iteration: entry.iteration,
		kind: entry.kind,
	}));
	const checkpointBytes = blendPlan.checkpoints.reduce((sum, entry) => sum + entry.bytes, 0);
	const branchBytes = blendPlan.branches.reduce((sum, entry) => sum + entry.bytes, 0);
	const checkpointFiles = blendPlan.checkpoints.length;
	const branchFiles = blendPlan.branches.length;

	const referenceDir = join(manifest.workspacePath, "references");
	const referenceFiles = await walkFiles(referenceDir);
	let referenceBytes = 0;
	for (const path of referenceFiles) referenceBytes += (await stat(path).catch(() => undefined))?.size ?? 0;

	const byModule = new Map<string, { module: string; files: number; bytes: number }>();
	const count = (moduleName: string, bytes: number) => {
		const current = byModule.get(moduleName) ?? { module: moduleName, files: 0, bytes: 0 };
		current.files += 1;
		current.bytes += bytes;
		byModule.set(moduleName, current);
	};
	for (const entry of candidates) count(entry.module ?? "unlisted", entry.bytes);
	for (const entry of unlisted) count("unlisted", entry.bytes);
	for (const entry of blendEntries) count(entry.module ?? "unlisted", entry.bytes);

	const totalBytes = [...candidates, ...unlisted, ...blendEntries].reduce((total, entry) => total + entry.bytes, 0);
	if (options.signal?.aborted) throw new Error("Pruning was cancelled before anything was removed.");
	if (!dryRun) {
		for (const entry of [...candidates, ...unlisted, ...blendEntries]) {
			await rm(entry.path, { force: true });
		}
		await markBranchRetired(manifest.manifestPath, blendPlan.branches.map((entry) => entry.path));
		for (let iteration = 0; iteration <= cutoff; iteration += 1) {
			// rmdir, not rm -r: a protected render can live in an old iteration,
			// and removing the directory would delete it with the rest.
			await rmdir(join(manifest.workspacePath, `iteration_${String(iteration).padStart(2, "0")}`, "renders")).catch(() => undefined);
		}
	}

	return {
		workspacePath: manifest.workspacePath,
		dryRun,
		keepIterations,
		cutoff,
		kept: [...kept].map(([path, reason]) => ({ path, reason })),
		wouldRemove: [...candidates, ...unlisted, ...blendEntries].map((entry) => ({
			path: entry.path,
			bytes: entry.bytes,
			module: entry.module,
			iteration: entry.iteration,
			kind: entry.kind,
		})),
		byModule: [...byModule.values()].sort((a, b) => b.bytes - a.bytes),
		totalBytes,
		references: {
			path: referenceDir,
			files: referenceFiles.length,
			bytes: referenceBytes,
			retained: true,
			reason: "References are inputs, not evidence. Nothing here can prove a copied file is unused, so pruning reports them and never deletes them.",
		},
		checkpoints: { files: checkpointFiles, bytes: checkpointBytes },
		branches: { files: branchFiles, bytes: branchBytes },
		note:
			`${dryRun ? "Dry run" : "Removed"}: ${candidates.length + unlisted.length + blendEntries.length} file(s), ${totalBytes} bytes ` +
			`(renders ${candidates.length + unlisted.length}, checkpoints ${checkpointFiles}/${checkpointBytes} bytes, branches ${branchFiles}/${branchBytes} bytes).` +
			(dryRun ? " Pass dryRun: false to remove them." : ""),
	};
}
