/**
 * Rank assets against each other, not against a line in the log.
 *
 * Why this exists: an absolute threshold can decide whether an asset is good
 * enough, and it can never decide whether it is the BEST of a thousand. The
 * gap between the 60th percentile and the 95th is invisible to a rubric that
 * has only ever seen one asset at a time — each looks fine in isolation — but it
 * is the whole difference between a dataset that trains well and one that
 * trains on ordinary examples. Training data wants the top slice of the
 * distribution, so selection has to happen across the batch.
 *
 * It also gives a cheap sanity check on the batch itself: if the verdict rates
 * and the percentile cut disagree, the briefs are wrong rather than the assets.
 *
 * The log is parsed for STRUCTURE only — headers, the score line, the axis
 * lines, the decision line. Never the prose: an `issues:` bullet may say
 * anything at all, and a ranking that read it would rank on English.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadWorkspaceManifest } from "./workspace.js";
import type { CritiqueVerdict, CritiqueVerdictRecord } from "./types.js";

/** One parsed entry, ready to be ranked against its peers. */
export interface RankedAsset extends CritiqueVerdictRecord {
	/** Where this asset sits among the eligible ones, 0 = best. */
	rank: number;
	/** Its score as a fraction of the best score in the batch, for reading. */
	relativeScore: number;
}

export interface CritiqueRankingResult {
	workspacePath: string;
	critiqueLogPath: string;
	/** Every entry found, newest entry per module winning. */
	entries: CritiqueVerdictRecord[];
	/** The ones a ranking can compare: presented, judged from a usable view. */
	eligible: number;
	/** The selected slice, best first. */
	selected: RankedAsset[];
	/** The percentile cut the selection was taken at, as a fraction. */
	topFraction: number;
	/** Per-verdict counts, so a batch that is mostly rejects says so plainly. */
	counts: Record<CritiqueVerdict, number>;
	/**
	 * Batch-level warnings, in plain language. These are about the BRIEF, not
	 * the assets: a batch where most assets fail validity is a batch that was
	 * pointed at the wrong category.
	 */
	warnings: string[];
}

const HEADER_MODULE = /^\[\S+\] iteration_(\d+) module=(\S+) budget (\d+)\/(\d+)$/;
const SCORE_LINE = /^Score: (\d+)\/(\d+)$/;
const AXIS_LINE = /^([A-Za-z][A-Za-z& ]*): (\d+)\/(\d+)$/;
const VIEW_LINE = /^View adequacy: (\d+)\/(\d+)\b/;
const DECISION_LINE = /^Decision: (present to user|continue iterating|REJECT)/;
const REJECT_REASON = /^Decision: REJECT — (.*)$/;

/**
 * Parse the critique log into records.
 *
 * Exported and pure over text so the whole parser is testable without a
 * workspace — a parser that can only be exercised through a real run is a
 * parser whose edge cases get discovered in production.
 */
export function parseCritiqueLog(text: string): CritiqueVerdictRecord[] {
	const entries: CritiqueVerdictRecord[] = [];
	let current: (Partial<CritiqueVerdictRecord> & { iteration: number; validity?: number }) | null = null;
	let sawView = false;

	const flush = () => {
		// An entry needs a score, a module, a view and a decision to be
		// rankable. A partial one means the log was truncated or hand-edited,
		// and silently ranking half an entry would be a number with no
		// provenance.
		if (current && current.moduleName && current.score !== undefined && current.verdict && sawView) {
			entries.push({
				moduleName: current.moduleName,
				iteration: current.iteration,
				verdict: current.verdict,
				score: current.score,
				validity: current.validity ?? 0,
				viewUsable: current.viewUsable ?? false,
				iterationBudgetExceeded: current.iterationBudgetExceeded ?? false,
				rejectReason: current.rejectReason,
			});
		}
		current = null;
		sawView = false;
	};

	for (const line of text.split("\n")) {
		const header = HEADER_MODULE.exec(line);
		if (header) {
			flush();
			current = { iteration: Number(header[1]), moduleName: header[2] };
			continue;
		}
		if (!current) continue;

		const score = SCORE_LINE.exec(line);
		if (score) {
			current.score = Number(score[1]);
			continue;
		}
		const view = VIEW_LINE.exec(line);
		if (view) {
			sawView = true;
			current.viewUsable = Number(view[1]) >= 1;
			continue;
		}
		const decision = DECISION_LINE.exec(line);
		if (decision) {
			const verdict = decision[1] === "present to user" ? "present" : decision[1] === "continue iterating" ? "continue" : "reject";
			current.verdict = verdict;
			const reason = REJECT_REASON.exec(line);
			// A reject carrying a reason is a rejected ATTEMPT; a reject with
			// none and the budget spent is a finished-but-failed one. Only the
			// first has a `rejectReason`, so this assignment is what separates
			// them, and it is why the two are recorded differently.
			current.iterationBudgetExceeded = verdict === "reject" && !reason;
			current.rejectReason = reason?.[1];
			flush();
			continue;
		}
		const axis = AXIS_LINE.exec(line);
		if (axis && axis[1] === "Category validity") {
			current.validity = Number(axis[2]);
		}
	}
	flush();
	return entries;
}

/**
 * Rank a batch and take its best slice.
 *
 * Only PRESENTED entries are eligible. A `continue` entry is a work in
 * progress and a `reject` is a failure, and ranking either against presented
 * work would compare things that are not the same kind of thing.
 */
export async function blenderRankAssets(options: {
	cwd: string;
	workspace: string;
	/** Fraction of eligible assets to keep, 0..1. Default 0.1. */
	topFraction?: number;
	/** Score every entry needs to be comparable. Default the present threshold's implicit 0. */
	minScore?: number;
	signal?: AbortSignal;
}): Promise<CritiqueRankingResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const critiqueLogPath = join(manifest.workspacePath, "critique.log");
	const topFraction = options.topFraction ?? 0.1;
	if (topFraction <= 0 || topFraction > 1) {
		throw new Error(`topFraction must be in (0, 1]; got ${topFraction}. A ranking that keeps nothing, or everything, is not a ranking.`);
	}
	const minScore = options.minScore ?? 0;

	let text: string;
	try {
		text = await readFile(critiqueLogPath, "utf-8");
	} catch (error) {
		throw new Error(`Could not read the critique log at ${critiqueLogPath}: ${error instanceof Error ? error.message : String(error)}. A ranking needs at least one critique to rank; log one with blender_log_critique first.`);
	}

	const entries = parseCritiqueLog(text);
	const warnings: string[] = [];

	// One entry per module, LAST write wins: a module's final judgement is the
	// one that describes its current state, and ranking a module on a judgement
	// that has since been superseded would select on stale information. A plain
	// set-in-order pass, because the log is append-only and the log IS the
	// order — no timestamps to compare and none needed.
	const latest = new Map<string, CritiqueVerdictRecord>();
	for (const entry of entries) {
		latest.set(entry.moduleName, entry);
	}
	const counts: Record<CritiqueVerdict, number> = { continue: 0, present: 0, reject: 0 };
	for (const entry of latest.values()) counts[entry.verdict]++;

	const ranked = [...latest.values()]
		.filter((entry) => entry.verdict === "present" && entry.viewUsable && entry.score >= minScore)
		// Score first, then validity as a tie-break: two assets can share a score
		// while one is unmistakably the category and the other is merely close,
		// and the more definite one is the better training example.
		.sort((a, b) => b.score - a.score || b.validity - a.validity || a.moduleName.localeCompare(b.moduleName));

	const keep = Math.max(1, Math.round(ranked.length * topFraction));
	const best = ranked[0]?.score ?? 0;
	const selected: RankedAsset[] = ranked.slice(0, keep).map((entry, index) => ({
		...entry,
		rank: index + 1,
		relativeScore: best === 0 ? 0 : Math.round((entry.score / best) * 100) / 100,
	}));

	if (latest.size > 0 && counts.present === 0) {
		warnings.push(
			`No module in this batch reached a verdict of present (${counts.reject} rejected, ${counts.continue} mid-iteration). Nothing can be selected: a ranking sorts presented assets against each other, and there are none.`,
		);
	}
	if (counts.reject > counts.present && latest.size > 0) {
		warnings.push(
			`${counts.reject} of ${latest.size} modules were rejected against ${counts.present} presented. When rejects outnumber presents the brief is usually wrong, not the assets: check that the category and the failure mode in the reject reasons match what was asked for.`,
		);
	}
	if (ranked.length > 0 && keep === ranked.length && ranked.length > 1) {
		warnings.push(
			`The top ${Math.round(topFraction * 100)}% slice kept all ${ranked.length} eligible assets. Either raise topFraction's precision (fewer assets) or the batch is too small to rank; a selection that keeps everything has not selected.`,
		);
	}

	return {
		workspacePath: manifest.workspacePath,
		critiqueLogPath,
		entries: [...latest.values()],
		eligible: ranked.length,
		selected,
		topFraction,
		counts,
		warnings,
	};
}