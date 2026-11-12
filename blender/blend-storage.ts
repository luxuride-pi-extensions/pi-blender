/**
 * Plan and apply `.blend` file retention.
 *
 * Checkpoints and branch copies are whole-file copies, so their budget has to be
 * global: five per module times twenty modules is a different number from five.
 * The rules here mirror the render policy: the newest generation of each module
 * is never a candidate, and applied branch files are retired with a tombstone
 * rather than left looking like corruption.
 */

import { constants } from "node:fs";
import { copyFile, rm, stat } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { updateManifest } from "./workspace.js";
import type { BlenderWorkspaceManifest } from "./types.js";

function isInside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export const DEFAULT_CHECKPOINT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;

export function checkpointBudgetBytes(env: NodeJS.ProcessEnv = process.env): number {
	const megabytes = Number(env.PI_BLENDER_CHECKPOINT_BUDGET_MB ?? 2048);
	if (!Number.isFinite(megabytes) || megabytes < 0) return DEFAULT_CHECKPOINT_BUDGET_BYTES;
	return Math.floor(megabytes * 1024 * 1024);
}

/** Copy-on-write when the filesystem supports it, a normal copy otherwise. */
export async function copyBlendFile(source: string, destination: string): Promise<void> {
	await copyFile(source, destination, constants.COPYFILE_FICLONE);
}

export interface BlendStorageCandidate {
	path: string;
	bytes: number;
	module: string;
	iteration: number;
	kind: "checkpoint" | "branch";
}

interface CandidateMeta {
	path: string;
	module: string;
	iteration: number;
	sequence: number;
}

/**
 * The newest and previous generation of each module are both protected:
 * compare judges against the previous checkpoint, and revert may name any run
 * still in the history. A budget that evicted the second-newest would break
 * both while reporting nothing.
 */
function newestTwoPerModule(entries: CandidateMeta[]): Set<string> {
	// Dedupe by path first: a branch run and its apply companion record the
	// SAME checkpoint at the same sequence, so taking two records would protect
	// one file twice and leave the real previous generation evictable.
	const byModule = new Map<string, Map<string, number>>();
	for (const entry of entries) {
		const byPath = byModule.get(entry.module) ?? new Map<string, number>();
		byPath.set(entry.path, Math.max(byPath.get(entry.path) ?? 0, entry.sequence));
		byModule.set(entry.module, byPath);
	}
	const protectedPaths = new Set<string>();
	for (const byPath of byModule.values()) {
		const ordered = [...byPath.entries()].sort((a, b) => b[1] - a[1]);
		for (const [path] of ordered.slice(0, 2)) protectedPaths.add(path);
	}
	return protectedPaths;
}

function sequenceOf(record: { sequence?: number; iteration: number }): number {
	return record.sequence ?? record.iteration;
}

export async function planBlendStorage(
	manifest: BlenderWorkspaceManifest,
	options: {
		includeCheckpoints?: boolean;
		includeBranches?: boolean;
		budgetBytes?: number;
	} = {},
): Promise<{ checkpoints: BlendStorageCandidate[]; branches: BlendStorageCandidate[]; totalBytes: number }> {
	const budget = options.budgetBytes ?? checkpointBudgetBytes();
	const checkpointMeta: CandidateMeta[] = [];
	const branchMeta: CandidateMeta[] = [];
	// There is exactly ONE branch.blend per module, rewritten by every run, so a
	// path shared with a staged or unchanged record is live work, not history.
	const liveBranchPaths = new Set(
		(manifest.branchRuns ?? [])
			.filter((run) => (run.status === "staged" || run.status === "unchanged") && !run.branchRetired)
			.map((run) => run.branchPath),
	);
	for (const run of manifest.branchRuns ?? []) {
		checkpointMeta.push({ path: run.checkpointPath, module: run.module, iteration: run.iteration, sequence: sequenceOf(run) });
		if (
			run.status === "applied" &&
			!run.branchRetired &&
			run.branchPath !== manifest.blendPath &&
			!liveBranchPaths.has(run.branchPath)
		) {
			branchMeta.push({ path: run.branchPath, module: run.module, iteration: run.iteration, sequence: sequenceOf(run) });
		}
	}
	for (const run of manifest.moduleRuns ?? []) {
		checkpointMeta.push({ path: run.checkpointPath, module: run.name, iteration: run.iteration, sequence: sequenceOf(run) });
	}

	const protectedCheckpoints = newestTwoPerModule(checkpointMeta);
	const checkpoints: BlendStorageCandidate[] = [];
	if (options.includeCheckpoints) {
		const seen = new Set<string>();
		const all: BlendStorageCandidate[] = [];
		for (const entry of checkpointMeta) {
			if (!isInside(manifest.workspacePath, entry.path)) continue;
			if (seen.has(entry.path) || protectedCheckpoints.has(entry.path)) continue;
			seen.add(entry.path);
			const info = await stat(entry.path).catch(() => undefined);
			if (!info?.isFile()) continue;
			all.push({ path: entry.path, bytes: info.size, module: entry.module, iteration: entry.iteration, kind: "checkpoint" });
		}
		let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
		for (const path of protectedCheckpoints) {
			if (!isInside(manifest.workspacePath, path)) continue;
			const info = await stat(path).catch(() => undefined);
			if (info?.isFile()) total += info.size;
		}
		const withTimes = await Promise.all(
			all.map(async (entry) => ({ entry, mtime: (await stat(entry.path).catch(() => undefined))?.mtimeMs ?? 0 })),
		);
		withTimes.sort((a, b) => a.mtime - b.mtime);
		for (const { entry } of withTimes) {
			if (total <= budget) break;
			checkpoints.push(entry);
			total -= entry.bytes;
		}
	}

	const branches: BlendStorageCandidate[] = [];
	if (options.includeBranches) {
		for (const entry of branchMeta) {
			if (!isInside(manifest.workspacePath, entry.path)) continue;
			const info = await stat(entry.path).catch(() => undefined);
			if (!info?.isFile()) continue;
			branches.push({ path: entry.path, bytes: info.size, module: entry.module, iteration: entry.iteration, kind: "branch" });
		}
	}

	return {
		checkpoints,
		branches,
		totalBytes: [...checkpoints, ...branches].reduce((sum, entry) => sum + entry.bytes, 0),
	};
}

/** Delete the files a plan selected. Caller reports the plan before this runs. */
export async function removeBlendStorage(candidates: BlendStorageCandidate[]): Promise<void> {
	for (const entry of candidates) await rm(entry.path, { force: true }).catch(() => undefined);
}

/**
 * Tombstone applied branches whose file is no longer needed.
 *
 * The checkpoint is the revert subject; an applied branch is only history. A
 * direct run's `branchPath` IS model.blend, so it is never deleted, only marked.
 */
export async function retireAppliedBranches(manifestPath: string, manifest: BlenderWorkspaceManifest): Promise<number> {
	const live = new Set(
		(manifest.branchRuns ?? [])
			.filter((run) => run.status === "staged" || run.status === "unchanged")
			.map((run) => run.branchPath),
	);
	const retired: string[] = [];
	for (const run of manifest.branchRuns ?? []) {
		if (run.status !== "applied" || run.branchRetired) continue;
		if (live.has(run.branchPath)) continue;
		if (run.branchPath !== manifest.blendPath && isInside(manifest.workspacePath, run.branchPath)) {
			await rm(run.branchPath, { force: true }).catch(() => undefined);
			retired.push(run.branchPath);
		}
	}
	if (retired.length === 0) return 0;
	await markBranchRetired(manifestPath, retired);
	return retired.length;
}

/** Tombstone exactly the branch records whose files a prune removed. */
export async function markBranchRetired(manifestPath: string, paths: string[]): Promise<void> {
	if (paths.length === 0) return;
	const removed = new Set(paths);
	const at = new Date().toISOString();
	await updateManifest(manifestPath, (current) => {
		const live = new Set(
			(current.branchRuns ?? [])
				.filter((run) => run.status === "staged" || run.status === "unchanged")
				.map((run) => run.branchPath),
		);
		for (const run of current.branchRuns ?? []) {
			if (run.status !== "applied" || !removed.has(run.branchPath) || live.has(run.branchPath)) continue;
			run.branchRetired = true;
			run.retiredAt = at;
		}
	});
}
