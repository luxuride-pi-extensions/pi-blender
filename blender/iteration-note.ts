import { loadWorkspaceManifest, updateManifest } from "./workspace.js";
import { normalizeModuleName } from "./module-paths.js";
import type { IterationProbeFact } from "./types.js";

const MAX_FACTS_PER_MODULE = 24;

export interface IterationNoteResult {
	workspacePath: string;
	module: string;
	recorded: IterationProbeFact;
	facts: IterationProbeFact[];
	superseded: number;
}

/**
 * A fact survives the critic that measured it. Without a durable copy the next
 * critic re-measures it, and a fold in between means it never sees the answer
 * at all, so the loop spends a render to rediscover a number it already had.
 */
export async function blenderRecordIterationFact(options: {
	cwd: string;
	workspace: string;
	moduleName: string;
	statement: string;
	source: string;
	iteration?: number;
	signal?: AbortSignal;
}): Promise<IterationNoteResult> {
	const moduleName = normalizeModuleName(options.moduleName);
	const statement = options.statement.trim();
	const source = options.source.trim();
	if (!statement) {
		throw new Error(
			"blender_record_iteration_fact needs the measured statement itself. \"The handle is thin\" is a fact; \"the handle\" is not.",
		);
	}
	if (!source) {
		throw new Error(
			"blender_record_iteration_fact needs the tool the fact came from, so a later critic can re-measure it instead of trusting it.",
		);
	}

	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const at = new Date().toISOString();
	const recorded: IterationProbeFact = {
		statement,
		source,
		iteration: options.iteration,
		at,
	};

	return await updateManifest(
		manifest.manifestPath,
		(current) => {
			const existing = current.iterationNotes?.[moduleName] ?? [];
			// Same statement, same measurement: the newer run is the one that
			// holds, so re-recording is an update rather than a duplicate line.
			const deduped = existing.filter((fact) => fact.statement !== statement);
			const facts = [...deduped, recorded].slice(-MAX_FACTS_PER_MODULE);
			current.iterationNotes = { ...current.iterationNotes, [moduleName]: facts };
			return {
				workspacePath: current.workspacePath,
				module: moduleName,
				recorded,
				facts,
				superseded: existing.length - deduped.length,
			} satisfies IterationNoteResult;
		},
		{ signal: options.signal },
	);
}
