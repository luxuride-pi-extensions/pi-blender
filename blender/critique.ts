import { appendFile } from "node:fs/promises";
import type { CritiqueLogOptions, CritiqueLogResult } from "./types.js";
import { nowIso } from "./utils.js";
import { ensureWorkspaceCritiqueLogExists, loadWorkspaceManifest, updateManifest } from "./workspace.js";

/**
 * The guidance tells the agent to stop after 5 iterations per module. The cap
 * is counted here rather than trusted as prose the model may drift from.
 *
 * Per module, not per instruction: several modules are judged at once and a
 * shared budget would be spent by the first two, leaving the rest unlimited.
 */
export const MAX_ITERATIONS_PER_MODULE = 5;

/** Marks a critique that ended its module's instruction, resetting its budget. */
const CRITIQUE_PRESENT_DECISION = "Decision: present to user";

/**
 * Claim this critique's position in its module's budget, under the manifest
 * lock.
 *
 * The claim MUST be assigned onto `current` — updateManifest persists the
 * mutated manifest, not the callback's return value.
 *
 * A present resets the counter to 1 rather than 0, because this critique is
 * itself the first of the next instruction's budget. Reading the count back out
 * of critique.log instead would race: two critics for one module would both
 * read the same file, both compute the same position, and both proceed, which
 * is exactly when the cap is meant to hold.
 */
export function claimCritiqueBudget(
	current: { critiqueCounts?: Record<string, number> },
	moduleName: string,
	shouldPresent: boolean,
): number {
	const counts = current.critiqueCounts ?? {};
	const previous = counts[moduleName] ?? 0;
	const budgetUsed = shouldPresent || previous === 0 ? 1 : previous + 1;
	current.critiqueCounts = { ...counts, [moduleName]: budgetUsed };
	return budgetUsed;
}

function validateCritiqueScore(name: string, value: number): void {
	if (!Number.isFinite(value) || value < 0 || value > 2) {
		throw new Error(`Critique score "${name}" must be a number between 0 and 2.`);
	}
}

export async function blenderLogCritique(options: CritiqueLogOptions): Promise<CritiqueLogResult> {
	validateCritiqueScore("accuracy", options.accuracy);
	validateCritiqueScore("geometry", options.geometry);
	validateCritiqueScore("materials", options.materials);
	validateCritiqueScore("completeness", options.completeness);
	validateCritiqueScore("quality", options.quality);
	if (options.viewAdequacy.trim().length === 0) {
		throw new Error('Critique field "viewAdequacy" must be a non-empty string.');
	}
	const moduleName = options.moduleName.trim();
	if (moduleName.length === 0) {
		throw new Error(
			"blender_log_critique requires the moduleName it judged. The iteration number alone cannot identify what was judged once several modules are being reviewed at once.",
		);
	}

	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const critiqueLogPath = await ensureWorkspaceCritiqueLogExists(manifest.workspacePath);
	const score = options.accuracy + options.geometry + options.materials + options.completeness + options.quality;
	const shouldPresent = score >= 8;

	// Read the manifest first to find the log, then claim under its lock: the
	// callback needs to know whether this critique presents (the score says so)
	// and only then is it known whether the claim resets the budget.
	const claimed = await updateManifest(
		manifest.manifestPath,
		(current) => ({
			budgetUsed: claimCritiqueBudget(current, moduleName, shouldPresent),
			iteration: options.iteration ?? current.latestIteration,
		}),
	);

	// The claimed iteration is read inside the lock for the same reason the
	// budget is claimed there: manifest.latestIteration read outside it is
	// whichever module run finished last, not the run that produced the image
	// this critique is about.
	const iteration = claimed.iteration;
	const iterationBudgetExceeded = !shouldPresent && claimed.budgetUsed >= MAX_ITERATIONS_PER_MODULE;
	const loggedAt = nowIso();
	const entry = {
		iteration,
		score,
		moduleName,
		budgetUsed: claimed.budgetUsed,
		iterationBudgetExceeded,
		accuracy: options.accuracy,
		geometry: options.geometry,
		materials: options.materials,
		completeness: options.completeness,
		quality: options.quality,
		viewAdequacy: options.viewAdequacy,
		issues: options.issues,
		nextAction: options.nextAction,
		loggedAt,
		shouldPresent,
	};

	// module= and budget= are in the header because the header is the only line
	// that defines an entry, so those two facts are the ones a reader can find
	// without parsing prose.
	const logBlock = [
		`[${loggedAt}] iteration_${String(iteration).padStart(2, "0")} module=${moduleName} budget ${claimed.budgetUsed}/${MAX_ITERATIONS_PER_MODULE}`,
		`Score: ${score}/10`,
		`Accuracy: ${options.accuracy}/2`,
		`Geometry & Proportions: ${options.geometry}/2`,
		`Materials & Appearance: ${options.materials}/2`,
		`Completeness: ${options.completeness}/2`,
		`Quality: ${options.quality}/2`,
		`View adequacy: ${options.viewAdequacy}`,
		"Issues:",
		...(options.issues.length > 0 ? options.issues.map((issue) => `- ${issue}`) : ["- none"]),
		`Next action: ${options.nextAction}`,
		shouldPresent
			? "Decision: present to user"
			: iterationBudgetExceeded
				? `Decision: iteration budget reached (${MAX_ITERATIONS_PER_MODULE}) — stop and present the current state to the user`
				: "Decision: continue iterating",
		"",
	].join("\n");

	await appendFile(critiqueLogPath, logBlock, "utf-8");

	return {
		workspacePath: manifest.workspacePath,
		critiqueLogPath,
		entry,
	};
}
