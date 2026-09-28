import { appendFile, readFile } from "node:fs/promises";
import type { CritiqueLogOptions, CritiqueLogResult } from "./types.js";
import { nowIso } from "./utils.js";
import { ensureWorkspaceCritiqueLogExists, loadWorkspaceManifest } from "./workspace.js";

/**
 * The guidance tells the agent to stop after 5 iterations per instruction.
 * The critique log is the only place that history exists, so the cap is
 * counted here rather than trusted as prose the model may drift from.
 */
export const MAX_ITERATIONS_PER_INSTRUCTION = 5;

/** Matches a critique block header line, e.g. `[2026-01-02T03:04:05.678Z] iteration_03`. */
const CRITIQUE_HEADER_RE = /^\[[^\]]+\] iteration_\d+$/;

/** Marks a critique that ended its instruction, so the next one starts a fresh budget. */
const CRITIQUE_PRESENT_DECISION = "Decision: present to user";

/**
 * Count critique entries logged since the last present-to-user decision.
 *
 * This deliberately does NOT count by iteration number. `iteration` is a global
 * run counter shared with module runs and ad-hoc `blender_execute_python`
 * calls, so consecutive critiques of one instruction routinely land on
 * different numbers — the previous implementation counted only entries with a
 * matching number, which meant `priorCritiques` was almost always 0 and
 * `MAX_ITERATIONS_PER_INSTRUCTION` could never fire. The cap was decorative.
 *
 * An "instruction" therefore ends at the first critique that presents to the
 * user, and the next one starts a fresh budget.
 */
async function countCritiquesSinceLastPresent(critiqueLogPath: string): Promise<number> {
	try {
		const raw = await readFile(critiqueLogPath, "utf-8");
		// Split into one chunk per entry, each starting at a header line. The
		// header is the only line that *defines* an entry: counting lines that
		// merely contain the marker would let an `issues` bullet quoting a
		// header count as a whole extra critique.
		const entries: string[] = [];
		let current: string[] | null = null;
		for (const line of raw.split("\n")) {
			if (CRITIQUE_HEADER_RE.test(line.trim())) {
				current = [];
				entries.push("");
			}
			if (current) {
				current.push(line);
				// Patch the tail entry: a single append per line, no re-splitting.
				entries[entries.length - 1] = current.join("\n");
			}
		}

		// Walk back to the most recent present-to-user decision; the entries
		// after it are the current instruction's.
		let count = 0;
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry === undefined) {
				continue;
			}
			if (entry.includes(CRITIQUE_PRESENT_DECISION)) {
				break;
			}
			count += 1;
		}
		return count;
	} catch {
		return 0;
	}
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

	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const critiqueLogPath = await ensureWorkspaceCritiqueLogExists(manifest.workspacePath);
	const iteration = options.iteration ?? manifest.latestIteration;
	const score = options.accuracy + options.geometry + options.materials + options.completeness + options.quality;
	const loggedAt = nowIso();
	const shouldPresent = score >= 8;
	// Counted since the last present-to-user decision, not by iteration number:
	// see countCritiquesSinceLastPresent for why the iteration number is the
	// wrong key.
	// `priorCritiques` counts entries already in the log, so the critique being
	// written is number priorCritiques + 1. Compare that against the cap rather
	// than the prior count, or the budget only trips on the sixth critique.
	const critiquesIncludingThisOne = (await countCritiquesSinceLastPresent(critiqueLogPath)) + 1;
	const iterationBudgetExceeded = !shouldPresent && critiquesIncludingThisOne >= MAX_ITERATIONS_PER_INSTRUCTION;
	const entry = {
		iteration,
		score,
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

	const logBlock = [
		`[${loggedAt}] iteration_${String(iteration).padStart(2, "0")}`,
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
				? `Decision: iteration budget reached (${MAX_ITERATIONS_PER_INSTRUCTION}) — stop and present the current state to the user`
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
