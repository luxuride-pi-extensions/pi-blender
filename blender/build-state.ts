import { updateManifest } from "./workspace.js";
import type { BlenderWorkspaceManifest } from "./types.js";

/**
 * The stages a build passes through, in the order the manager prompt names
 * them. `merged` is the batch apply that writes the staged branches into
 * model.blend; `finalized` is the finalizer's pass over the assembled scene.
 */
export const BUILD_STAGES = [
	"intake",
	"planned",
	"staged",
	"applied",
	"merged",
	"critiqued",
	"finalized",
	"exported",
] as const;

export type BuildStage = (typeof BUILD_STAGES)[number];

export interface BuildHistoryEntry {
	stage: BuildStage;
	at: string;
	actor: string;
	evidence?: string;
}

export interface BuildState {
	stage: BuildStage;
	history: BuildHistoryEntry[];
}

/**
 * Which stages may follow the current one.
 *
 * This is deliberately a graph rather than a single next stage: a critic can
 * log before the batch apply (the branch render is what it judges), a merged
 * build may be critiqued again, and a direct live save skips staging entirely.
 * What it refuses is the ordering that loses work — export before finalize,
 * critique before anything was applied, a second finalize.
 */
const NEXT: Record<BuildStage, readonly BuildStage[]> = {
	intake: ["planned", "staged", "applied"],
	planned: ["staged", "applied"],
	staged: ["staged", "applied", "critiqued"],
	applied: ["applied", "staged", "merged", "critiqued"],
	merged: ["merged", "critiqued", "finalized"],
	critiqued: ["critiqued", "applied", "merged", "finalized", "exported"],
	finalized: ["finalized", "exported"],
	exported: [],
};

export function readBuildState(manifest: Pick<BlenderWorkspaceManifest, "build">): BuildState {
	return {
		stage: manifest.build?.stage ?? "intake",
		history: manifest.build?.history ?? [],
	};
}

export function assertBuildTransition(current: BuildStage, next: BuildStage): void {
	if (current === next && next !== "finalized" && next !== "exported") return;
	if (NEXT[current].includes(next)) return;
	throw new Error(
		`The build is at "${current}" and cannot move to "${next}". Allowed: ${NEXT[current].join(", ") || "nothing (it is exported)"}. Finish the missing stage instead of skipping it.`,
	);
}

export async function recordBuildStage(
	manifestPath: string,
	stage: BuildStage,
	evidence: string | undefined,
	options?: { actor?: string; signal?: AbortSignal },
): Promise<BuildState> {
	return updateManifest(
		manifestPath,
		(manifest) => {
			const before = readBuildState(manifest);
			assertBuildTransition(before.stage, stage);
			const entry: BuildHistoryEntry = {
				stage,
				at: new Date().toISOString(),
				actor: options?.actor ?? "blender",
				evidence,
			};
			const history = before.stage === stage && stage !== "finalized" ? before.history : [...before.history, entry];
			manifest.build = { stage, history };
			return manifest.build;
		},
		{ signal: options?.signal },
	);
}

export function buildExportGate(manifest: Pick<BlenderWorkspaceManifest, "build">, allowUnfinalized: boolean): string | null {
	const state = readBuildState(manifest);
	if (allowUnfinalized || state.stage === "finalized" || state.stage === "exported") return null;
	if (!manifest.build) return null;
	return `The build is at "${state.stage}", not "finalized". Run the finalizer first, or pass allowUnfinalized: true when exporting a deliberate intermediate state.`;
}

export async function blenderBuildStatus(options: { cwd: string; workspace: string; signal?: AbortSignal }) {
	const { loadWorkspaceManifest } = await import("./workspace.js");
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const state = readBuildState(manifest);
	const modules = [...new Set((manifest.branchRuns ?? []).map((run) => run.module))];
	return {
		workspacePath: manifest.workspacePath,
		stage: state.stage,
		history: state.history,
		modules,
		next: NEXT[state.stage],
	};
}

export async function blenderBuildAdvance(options: {
	cwd: string;
	workspace: string;
	stage: BuildStage;
	evidence: string;
	actor?: string;
	signal?: AbortSignal;
}) {
	const { loadWorkspaceManifest } = await import("./workspace.js");
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const evidence = options.evidence.trim();
	if (evidence.length === 0) throw new Error("blender_build_advance needs evidence: what was checked or produced for this stage.");
	return recordBuildStage(manifest.manifestPath, options.stage, evidence, {
		actor: options.actor ?? "blender-manager",
		signal: options.signal,
	});
}
