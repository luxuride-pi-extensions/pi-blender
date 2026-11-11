import type { BlenderWorkspaceManifest } from "./types.js";

/**
 * One module generation whose content is in model.blend.
 *
 * This is the single answer to "what counts as a generation", shared by the
 * digest comparison and the iteration state. They used to disagree: the digest
 * compared against any branch run with a digest, including one that was staged
 * and never applied, failed, or was skipped on a conflict, while the iteration
 * state counted staged-but-unapplied runs as history. A rejected merge is not a
 * generation the next run can be compared with, and counting it as one made an
 * unchanged iteration look changed.
 *
 * A branch apply writes BOTH a branch record with status "applied" and a
 * companion moduleRuns record carrying `viaBranchApply`. Only the branch record
 * is a generation; the companion is the revert hook for the same work.
 */
export interface ModuleGeneration {
	module: string;
	iteration: number;
	sequence: number;
	stateDigest?: string;
	ownedObjects?: string[];
	ownedMaterials?: string[];
	/** Where the generation ran, for the iteration report. */
	executionMode: "branch" | "live";
}

type RunManifest = Pick<BlenderWorkspaceManifest, "branchRuns" | "moduleRuns">;

/** Newest first would be cheaper, but callers need a stable order to compare. */
export function collectModuleGenerations(manifest: RunManifest, moduleName: string): ModuleGeneration[] {
	const generations: ModuleGeneration[] = [];
	for (const run of manifest.branchRuns ?? []) {
		if (run.module !== moduleName || run.status !== "applied") continue;
		generations.push({
			module: run.module,
			iteration: run.iteration,
			sequence: run.sequence,
			stateDigest: run.stateDigest,
			ownedObjects: run.ownedObjects,
			ownedMaterials: run.ownedMaterials,
			executionMode: "branch",
		});
	}
	for (const run of manifest.moduleRuns ?? []) {
		if (run.name !== moduleName || run.status !== "ok" || run.viaBranchApply) continue;
		generations.push({
			module: run.name,
			iteration: run.iteration,
			sequence: run.sequence,
			stateDigest: run.stateDigest,
			ownedObjects: run.ownedObjects,
			ownedMaterials: run.ownedMaterials,
			executionMode: "live",
		});
	}
	return generations.sort((a, b) => a.sequence - b.sequence);
}

/** The most recent generation strictly before `sequence`, if any. */
export function previousModuleGeneration(
	manifest: RunManifest,
	moduleName: string,
	sequence: number,
): ModuleGeneration | undefined {
	return collectModuleGenerations(manifest, moduleName)
		.filter((generation) => generation.sequence < sequence)
		.at(-1);
}

/**
 * What this module owns as of its latest generation.
 *
 * Ownership is carried forward by the runner, so the latest generation is the
 * answer. Records written before ownership was recorded have no field at all,
 * which is different from owning nothing: the fallback unions the known
 * ownership of earlier generations rather than restarting the digest subject at
 * empty and reporting the next unchanged run as a change.
 */
export function collectModuleOwnership(
	manifest: RunManifest,
	moduleName: string,
): { objects: string[]; materials: string[] } {
	const generations = collectModuleGenerations(manifest, moduleName);
	const latest = (pick: (generation: ModuleGeneration) => string[] | undefined): string[] | undefined => {
		for (let index = generations.length - 1; index >= 0; index -= 1) {
			const owned = pick(generations[index]!);
			if (owned !== undefined) return [...owned].sort();
		}
		return undefined;
	};
	const objects = latest((generation) => generation.ownedObjects);
	const materials = latest((generation) => generation.ownedMaterials);
	return {
		objects: objects ?? union(generations, (generation) => generation.ownedObjects),
		materials: materials ?? union(generations, (generation) => generation.ownedMaterials),
	};
}

function union(
	generations: ModuleGeneration[],
	pick: (generation: ModuleGeneration) => string[] | undefined,
): string[] {
	const known = new Set<string>();
	for (const generation of generations) {
		for (const name of pick(generation) ?? []) known.add(name);
	}
	return [...known].sort();
}

/**
 * A digest is comparable when there is one.
 *
 * An empty subject produces no digest, and an empty string must never be
 * compared: every empty run would match it and read as "unchanged" for a module
 * whose subject was never recorded. Digests recorded before the shared
 * accounting used MD5 while current ones use SHA-256; those two values can never
 * be equal, so an upgrade reports one changed run rather than a false all-clear,
 * which is the safe direction for the one number the loop trusts.
 */
export function isComparableStateDigest(digest: string | undefined | null): digest is string {
	// SHA-256 output only. An MD5 digest from a pre-#57 workspace and an empty
	// subject both mean "no comparable state": comparing either would report a
	// change that did not happen, or an unchanged build that did.
	return typeof digest === "string" && /^[0-9a-f]{64}$/i.test(digest);
}
