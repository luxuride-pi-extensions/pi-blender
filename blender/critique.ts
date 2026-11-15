import { recordBuildStage } from "./build-state.js";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getRunDirName } from "./module-paths.js";
import type {
	BlenderReference,
	BlenderWorkspaceManifest,
	CritiqueLogOptions,
	CritiqueLogResult,
	CritiqueVerdict,
	PartChecklistEntry,
} from "./types.js";
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

/**
 * Below this total the work is not presentable.
 *
 * Summed over SIX axes, so the equivalent bar on the old five was 8/10. Raising
 * it would be wrong: `validity` exists precisely to catch the failure that
 * totals cannot, and a 0 there has to be able to sink an otherwise excellent
 * asset, which only works while the bar sits where a 0-on-validity + perfect
 * elsewhere still fails it.
 */
export const PRESENT_SCORE_THRESHOLD = 8;

export const MAX_SCORE_PER_AXIS = 2;

/**
 * The axes a judgement is the SUM of, in the order the log prints them.
 *
 * `viewAdequacy` is deliberately not here: it gates whether the rest of the
 * judgement means anything, so folding it into the total would let a good view
 * buy a bad asset and a bad view hide a bad asset.
 */
const SIX_AXES = ["accuracy", "geometry", "materials", "completeness", "quality", "validity"] as const;

/** Printed labels, so the log's wording is defined once beside the axis list. */
const AXIS_LABELS: Record<(typeof SIX_AXES)[number], string> = {
	accuracy: "Accuracy",
	geometry: "Geometry & Proportions",
	materials: "Materials & Appearance",
	completeness: "Completeness",
	quality: "Quality",
	validity: "Category validity",
};

/**
 * Mark the end of an instruction in the log header.
 *
 * One function rather than three constants, so a new verdict cannot be added
 * to the type without also having to say how it reads in the log — a verdict
 * that exists in the entry but not in the file is a verdict a filter misses.
 */
function decisionLine(entry: {
	verdict: CritiqueVerdict;
	rejectReason?: string;
	iterationBudgetExceeded: boolean;
}): string {	if (entry.verdict === "present") return "Decision: present to user";
	if (entry.verdict === "continue") return "Decision: continue iterating";
	if (entry.rejectReason) return `Decision: REJECT — ${entry.rejectReason}`;
	if (entry.iterationBudgetExceeded) {
		return `Decision: REJECT (iteration budget reached at ${MAX_ITERATIONS_PER_MODULE}) — not brought up to standard, not shipped`;
	}
	return "Decision: REJECT";
}

/**
 * Claim this critique's position in its module's budget, under the manifest
 * lock.
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

/**
 * Lowercase, single-spaced form of a part name, so "Handle" and "handle "
 * answer each other. Only used for matching, never for output.
 */
function normalizePart(part: string): string {
	return part.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The parts the reference behind this critique declares.
 *
 * Two routes, because the guarantee must not depend on the critic remembering to
 * ask for the check:
 *  - an explicit `referenceId`, for a critic judging a reference the run was not
 *    rendered against;
 *  - otherwise the reference recorded in this iteration's `packet.json`, which is
 *    the reference the render was actually paired with. A critic cannot dodge
 *    the checklist by omitting an argument, and a brief written before any of
 *    this existed still gets checked.
 *
 * A `referenceId` that resolves to nothing throws. Answering "no parts, nothing
 * to verify" would be precisely the silent pass the checklist exists to remove.
 */
async function resolveExpectedParts(
	manifest: BlenderWorkspaceManifest,
	moduleName: string,
	iteration: number,
): Promise<string[]> {
	const references: BlenderReference[] = manifest.references ?? [];
	const packetPath = join(
		manifest.workspacePath,
		"modules",
		moduleName,
		"iterations",
		getRunDirName(iteration),
		"packet.json",
	);
	let packet: { reference?: { path?: string } | null };
	try {
		packet = JSON.parse(await readFile(packetPath, "utf8")) as { reference?: { path?: string } | null };
	} catch {
		// No packet is not an error: a critique can judge a render that was never
		// run through a branch, and there is then no reference to check against.
		return [];
	}
	const path = packet.reference?.path;
	if (!path) return [];
	return references.find((entry) => entry.path === path)?.parts ?? [];
}

/**
 * The parts this checklist fails to vouch for: named absent, skipped, or claimed
 * present with nothing behind the claim.
 *
 * The direction of the rule is the whole point of the checklist. A part the
 * reference names is a part the model was asked to have, so the checklist's job
 * is to prove presence — and a critic that answers nothing has proved nothing.
 * Reading silence as a pass is how an occluded back panel went unnoticed: the
 * one view never showed it, so no issue was ever raised, and the score was the
 * same as for a complete model.
 */
export function findPartGaps(expectedParts: string[], checklist: PartChecklistEntry[]): string[] {
	const gaps: string[] = [];
	const answers = checklist.map((entry) => ({
		name: normalizePart(entry.part),
		part: entry.part,
		present: entry.present,
		// A `present` with no evidence is a tick, not a finding: the evidence is
		// what a reader checks the claim against. An absent part needs no evidence
		// beyond its absence, which the view itself shows.
		evidenced: entry.evidence.trim().length > 0,
	}));
	const answered = (key: string) =>
		answers.find((answer) => answer.name === key || answer.name.includes(key) || key.includes(answer.name));

	for (const expected of expectedParts) {
		const key = normalizePart(expected);
		if (key.length === 0) continue;
		const answer = answered(key);
		if (!answer) gaps.push(expected);
		else if (!answer.present) gaps.push(expected);
		else if (!answer.evidenced) gaps.push(expected);
	}

	// A part the critic itself marks absent is a gap whether or not the reference
	// named it: the critic looked and found nothing, which is a finding.
	for (const answer of answers) {
		if (answer.present || answer.name.length === 0) continue;
		if (expectedParts.some((expected) => normalizePart(expected) === answer.name)) continue;
		gaps.push(answer.part);
	}

	// One part, one line: "handle" and "Handle" are the same part, and a report
	// that lists it twice reads as two problems.
	const unique: string[] = [];
	for (const gap of gaps) {
		if (unique.some((existing) => existing.toLowerCase() === gap.toLowerCase())) continue;
		unique.push(gap);
	}
	return unique;
}

/**
 * The decision table, as a pure function of the inputs.
 *
 * Split out from blenderLogCritique because the table is the whole policy and
 * the rest is bookkeeping — and because "budget exhausted" can only be decided
 * after the claim, so the caller must be able to call this twice: once to know
 * whether presenting (which is what the claim's reset behaviour depends on) and
 * once with the claimed position in hand.
 */
export function resolveCritiqueVerdict(options: {
	axes: Record<(typeof SIX_AXES)[number], number>;
	viewAdequacy: number;
	rejectReason?: string;
	budgetUsed: number;
	maxBudget?: number;
	presentThreshold?: number;
	maxScorePerAxis?: number;
	/** The parts the reference says the subject has. */
	expectedParts?: string[];
	partChecklist?: PartChecklistEntry[];
}): {
	verdict: CritiqueVerdict;
	score: number;
	viewUsable: boolean;
	shouldPresent: boolean;
	iterationBudgetExceeded: boolean;
	rejectReason?: string;
	/** The axes actually scored, with `completeness` capped for a part gap. */
	axes: Record<(typeof SIX_AXES)[number], number>;
	/** Parts named absent, skipped, or claimed without evidence. */
	partGaps: string[];
} {
	const partGaps = findPartGaps(options.expectedParts ?? [], options.partChecklist ?? []);
	// A model missing a named part is not complete, whatever the critic typed, so
	// the axis is capped here rather than trusted. It is capped at 1 and not 0
	// because a part gap is one failing among the rest of the build; the forcing
	// below is what keeps the total from presenting it.
	const axes =
		partGaps.length > 0
			? { ...options.axes, completeness: Math.min(options.axes.completeness, 1) }
			: options.axes;
	const score = SIX_AXES.reduce<number>((total, axis) => total + axes[axis], 0);
	const viewUsable = options.viewAdequacy >= 1;
	const rejectReason = (options.rejectReason ?? "").trim();
	// A view that cannot show the subject cannot make an asset presentable, so
	// it gates the threshold rather than sitting in the total: otherwise a
	// perfect render of nothing would score its way to present.
	//
	// A part gap gates it for the same reason and independently: a near-perfect
	// total is exactly the shape of the failure this catches — the model reads
	// well, the proportion is right, and one part is simply not there.
	const shouldPresent =
		score >= (options.presentThreshold ?? PRESENT_SCORE_THRESHOLD) &&
		viewUsable &&
		rejectReason.length === 0 &&
		partGaps.length === 0;

	let verdict: CritiqueVerdict = "continue";
	if (rejectReason.length > 0) verdict = "reject";
	else if (viewUsable) {
		if (shouldPresent) verdict = "present";
		else if (options.budgetUsed >= (options.maxBudget ?? MAX_ITERATIONS_PER_MODULE)) verdict = "reject";
	}

	return {
		verdict,
		score,
		viewUsable,
		shouldPresent,
		// Only a reject with no stated reason can be a spent budget, and the two
		// must stay distinguishable: one means the attempt was exhausted, the
		// other means the brief was wrong, and only the first is worth retrying.
		iterationBudgetExceeded: verdict === "reject" && rejectReason.length === 0,
		rejectReason: rejectReason.length > 0 ? rejectReason : undefined,
		axes,
		partGaps,
	};
}

export async function blenderLogCritique(options: CritiqueLogOptions): Promise<CritiqueLogResult> {
	for (const axis of ["accuracy", "geometry", "materials", "completeness", "quality", "validity", "viewAdequacy"] as const) {
		validateCritiqueScore(axis, options[axis]);
	}
	if (options.viewNote.trim().length === 0) {
		throw new Error('Critique field "viewNote" must be a non-empty string.');
	}
	const moduleName = options.moduleName.trim();
	if (moduleName.length === 0) {
		throw new Error(
			"blender_log_critique requires the moduleName it judged. The iteration number alone cannot identify what was judged once several modules are being reviewed at once.",
		);
	}

	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const critiqueLogPath = await ensureWorkspaceCritiqueLogExists(manifest.workspacePath);
	const axes = SIX_AXES.reduce<Record<(typeof SIX_AXES)[number], number>>(
		(carried, axis) => ({ ...carried, [axis]: options[axis] }),
		{} as Record<(typeof SIX_AXES)[number], number>,
	);
	const rejectReason = (options.rejectReason ?? "").trim();
	// Resolved twice, and deliberately: the claim's budget reset depends on
	// whether this presents, so the position has to be asked for before the
	// claim and settled after it. `preClaim` answers only the question the claim
	// needs — is this presenting? — and its budgetUsed is a placeholder that no
	// branch reads, because a presenting critique never looks at the budget.
	// Zero is safe to pass because it can only ever read as "budget not spent",
	// which is the same answer a claim about to happen would give.
	let expectedParts = await resolveExpectedParts(manifest, moduleName, options.iteration ?? manifest.latestIteration);
	const preClaim = resolveCritiqueVerdict({
		axes,
		viewAdequacy: options.viewAdequacy,
		rejectReason,
		budgetUsed: 0,
		expectedParts,
		partChecklist: options.partChecklist,
	});

	// Read the manifest first to find the log, then claim under its lock: the
	// callback needs to know whether this critique presents (the score says so)
	// and only then is it known whether the claim resets the budget. Only
	// `present` resets — a reject ends the instruction just as surely, but
	// resetting on it would hand a rejected module a fresh budget if the
	// instruction were ever retried against the same name.
	const claimed = await updateManifest(
		manifest.manifestPath,
		(current) => ({
			budgetUsed: claimCritiqueBudget(current, moduleName, preClaim.shouldPresent),
			iteration: options.iteration ?? current.latestIteration,
		}),
	);

	// The claimed iteration is read inside the lock for the same reason the
	// budget is claimed there: manifest.latestIteration read outside it is
	// whichever module run finished last, not the run that produced the image
	// this critique is about.
	const iteration = claimed.iteration;
	// The packet belongs to the claimed iteration, which can differ from the one
	// read above when a sibling module finished in between.
	if (options.iteration === undefined && iteration !== manifest.latestIteration) {
		expectedParts = await resolveExpectedParts(manifest, moduleName, iteration);
	}

	const { verdict, score, viewUsable, shouldPresent, iterationBudgetExceeded, axes: scoredAxes, partGaps } =
		resolveCritiqueVerdict({
			axes,
			viewAdequacy: options.viewAdequacy,
			rejectReason,
			budgetUsed: claimed.budgetUsed,
			expectedParts,
			partChecklist: options.partChecklist,
		});
	const partChecklist = options.partChecklist ?? [];
	const silhouetteIoU = options.silhouetteIoU;
	const loggedAt = nowIso();
	const entry = {
		iteration,
		score,
		moduleName,
		budgetUsed: claimed.budgetUsed,
		iterationBudgetExceeded,
		viewUsable,
		verdict,
		accuracy: scoredAxes.accuracy,
		geometry: scoredAxes.geometry,
		materials: scoredAxes.materials,
		completeness: scoredAxes.completeness,
		quality: scoredAxes.quality,
		validity: scoredAxes.validity,
		viewAdequacy: options.viewAdequacy,
		viewNote: options.viewNote,
		issues: options.issues,
		nextAction: options.nextAction,
		rejectReason: rejectReason.length > 0 ? rejectReason : undefined,
		partChecklist,
		partGaps,
		silhouetteIoU,
		loggedAt,
		shouldPresent,
	};

	// module= and budget= are in the header because the header is the only line
	// that defines an entry, so those two facts are the ones a reader can find
	// without parsing prose. The score's own denominator is printed from the
	// axes rather than hardcoded, because a hardcoded one is exactly the number
	// that silently lies after an axis is added.
	const axisLines = SIX_AXES.map((axis) => `${AXIS_LABELS[axis]}: ${scoredAxes[axis]}/${MAX_SCORE_PER_AXIS}`);
	// The checklist is printed in full because its consequences are silent
	// otherwise: a capped axis and a withheld present cannot say WHICH part was
	// missing, and a reader who has to reconstruct that from the render stops
	// trusting the log. Only printed when there is something to print, so the
	// common no-reference critique does not grow two empty lines.
	const partLines: string[] = [];
	if (partChecklist.length > 0 || expectedParts.length > 0) {
		const present = partChecklist.filter((entry) => entry.present).length;
		partLines.push(
			`Parts: ${present}/${partChecklist.length} marked present` +
				(expectedParts.length > 0 ? ` of ${expectedParts.length} the reference names` : "") +
				(partGaps.length > 0 ? ` — unvouched: ${partGaps.join(", ")}` : ""),
		);
		for (const item of partChecklist) {
			partLines.push(`- ${item.part}: ${item.present ? "present" : "ABSENT"} — ${item.evidence}`);
		}
		for (const gap of partGaps) {
			if (partChecklist.some((item) => item.part === gap)) continue;
			partLines.push(`- ${gap}: not answered by the checklist`);
		}
	}
	const silhouetteLine = silhouetteIoU && Object.keys(silhouetteIoU).length > 0
		? `Silhouette IoU: ${Object.entries(silhouetteIoU).map(([view, value]) => `${view} ${value}`).join(", ")}`
		: undefined;
	const logBlock = [
		`[${loggedAt}] iteration_${String(iteration).padStart(2, "0")} module=${moduleName} budget ${claimed.budgetUsed}/${MAX_ITERATIONS_PER_MODULE}`,
		`Score: ${score}/${SIX_AXES.length * MAX_SCORE_PER_AXIS}`,
		...axisLines,
		`View adequacy: ${options.viewAdequacy}/${MAX_SCORE_PER_AXIS} — ${options.viewNote}`,
		...(silhouetteLine ? [silhouetteLine] : []),
		...partLines,
		"Issues:",
		...(options.issues.length > 0 ? options.issues.map((issue) => `- ${issue}`) : ["- none"]),
		`Next action: ${options.nextAction}`,
		decisionLine(entry),
		"",
	].join("\n");

	await appendFile(critiqueLogPath, logBlock, "utf-8");
	await recordBuildStage(manifest.manifestPath, "critiqued", `module ${moduleName} iteration ${iteration}`, {
		actor: "blender-critic",
	});

	return {
		workspacePath: manifest.workspacePath,
		critiqueLogPath,
		entry,
	};
}
