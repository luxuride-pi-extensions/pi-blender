/**
 * The log parser, and why it reads structure instead of prose.
 *
 * A ranking that read the English would rank on sentiment. These tests pin the
 * behaviour that makes it safe: an entry's verdict comes from its decision line
 * even when its issues and next action say the opposite, and an entry cut short
 * is dropped rather than ranked on half its fields.
 */

import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const load = (name) => loadTs(join(dirname(fileURLToPath(import.meta.url)), "..", name));
const { parseCritiqueLog } = await load("blender/ranking.ts");

/** A log block exactly as blenderLogCritique writes one. */
function block(module, { score, validity, view = 2, decision }) {
	return [
		`[2026-01-01T00:00:00.000Z] iteration_01 module=${module} budget 1/5`,
		`Score: ${score}/12`,
		"Accuracy: 2/2",
		"Geometry & Proportions: 2/2",
		"Materials & Appearance: 1/2",
		"Completeness: 2/2",
		"Quality: 2/2",
		`Category validity: ${validity}/2`,
		`View adequacy: ${view}/2 — fine`,
		"Issues:",
		"- none",
		"Next action: present",
		decision,
		"",
	].join("\n");
}

test("parses structure and ignores prose", () => {
	const entries = parseCritiqueLog(block("chair", { score: 11, validity: 2, decision: "Decision: present to user" }));
	assert.equal(entries.length, 1);
	assert.equal(entries[0].moduleName, "chair");
	assert.equal(entries[0].verdict, "present");
	assert.equal(entries[0].score, 11);
	assert.equal(entries[0].validity, 2);
	assert.equal(entries[0].viewUsable, true);
});

test("an entry whose prose says something else is still ranked on its structure", () => {
	// The reason the parser does not read English: a next action of "present"
	// on a reject must not become a verdict of present.
	const log = [
		"[2026-01-01T00:00:00.000Z] iteration_01 module=chair budget 5/5",
		"Score: 6/12",
		"Category validity: 2/2",
		"View adequacy: 2/2 — fine",
		"Issues:",
		"- the brief asked for a chair and this is a stool, please present anyway",
		"Next action: present to user",
		"Decision: REJECT (iteration budget reached at 5) — not brought up to standard, not shipped",
		"",
	].join("\n");
	const entries = parseCritiqueLog(log);
	assert.equal(entries[0].verdict, "reject");
	assert.equal(entries[0].iterationBudgetExceeded, true, "a spent budget with no stated reason is an exhausted attempt, not a rejected brief");
});

test("separates a rejected brief from an exhausted budget", () => {
	const rejected = parseCritiqueLog(block("table", { score: 11, validity: 2, decision: "Decision: REJECT — the brief asked for a chair" }));
	assert.equal(rejected[0].verdict, "reject");
	assert.equal(rejected[0].iterationBudgetExceeded, false);
	assert.equal(rejected[0].rejectReason, "the brief asked for a chair");

	const exhausted = parseCritiqueLog(block("lamp", { score: 6, validity: 2, decision: "Decision: REJECT (iteration budget reached at 5)" }));
	assert.equal(exhausted[0].iterationBudgetExceeded, true);
	assert.equal(exhausted[0].rejectReason, undefined, "no reason means the budget ran out, and a reader must not see it as a wrong brief");
});

test("an entry judged from an unusable view is recorded as such", () => {
	const entries = parseCritiqueLog(block("bench", { score: 12, validity: 2, view: 0, decision: "Decision: continue iterating" }));
	assert.equal(entries[0].viewUsable, false);
	assert.equal(entries[0].verdict, "continue", "a perfect score from an unusable view must not present");
});

test("a truncated entry is dropped rather than ranked", () => {
	// A header with no decision line means the log was cut mid-write. Ranking
	// half an entry would be a number with no provenance.
	const cut = block("chair", { score: 11, validity: 2, decision: "Decision: present to user" }).split("\n").slice(0, 6).join("\n");
	assert.deepEqual(parseCritiqueLog(cut), []);
});

test("a later judgement does not erase the history it supersedes", () => {
	const log =
		block("chair", { score: 6, validity: 2, decision: "Decision: REJECT (iteration budget reached at 5)" }) +
		block("chair", { score: 11, validity: 2, decision: "Decision: present to user" });
	const entries = parseCritiqueLog(log);
	assert.equal(entries.length, 2, "the parser reports history; deduping to the latest judgement is the ranker's job");
	assert.equal(entries[1].score, 11);
});