/**
 * The verdict, and the three things that decide it.
 *
 * Before this, an exhausted budget and a success both ended at "present to
 * user" — correct when someone is watching to receive it, wrong when a
 * generator is running unattended, and ambiguous either way for anything
 * downstream reading the log. These assert the decision table, because the
 * table is the whole change and the rest is bookkeeping.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadTs } from "./paths.mjs";

const { resolveCritiqueVerdict, PRESENT_SCORE_THRESHOLD, MAX_ITERATIONS_PER_MODULE, MAX_SCORE_PER_AXIS } =
	await loadTs("../blender/critique.ts");

/** Six axes at 2 = the best possible asset, i.e. 12. */
const PERFECT = { accuracy: 2, geometry: 2, materials: 2, completeness: 2, quality: 2, validity: 2 };
const axes = (overrides = {}) => ({ ...PERFECT, ...overrides });

function verdict(options = {}) {
	const a = axes(options.axes ?? {});
	return resolveCritiqueVerdict({
		axes: a,
		viewAdequacy: options.viewAdequacy ?? 2,
		rejectReason: options.rejectReason,
		budgetUsed: options.budgetUsed ?? 1,
		maxBudget: options.maxBudget ?? MAX_ITERATIONS_PER_MODULE,
		presentThreshold: options.presentThreshold ?? PRESENT_SCORE_THRESHOLD,
		maxScorePerAxis: options.maxScorePerAxis ?? MAX_SCORE_PER_AXIS,
	});
}

describe("the verdict", () => {
	it("presents an excellent asset from a usable view", () => {
		const r = verdict();
		assert.equal(r.verdict, "present");
		assert.equal(r.score, 12);
		assert.equal(r.viewUsable, true);
	});

	it("REJECTS when the budget is spent and the score is short", () => {
		// The case that motivated this: five iterations of an asset that never
		// got there used to be handed to a user as if it were finished. Three
		// failed axes puts the score at 6 of 12, genuinely short.
		const r = verdict({ axes: { accuracy: 0, materials: 0, validity: 0 }, budgetUsed: MAX_ITERATIONS_PER_MODULE });
		assert.equal(r.verdict, "reject");
		assert.equal(r.iterationBudgetExceeded, true, "the reason for the reject has to survive into the entry, or the log cannot distinguish an exhausted budget from an abandoned attempt");
	});

	it("keeps iterating while the budget lasts", () => {
		assert.equal(verdict({ axes: { accuracy: 0, materials: 0, validity: 0 }, budgetUsed: 2 }).verdict, "continue");
	});

	it("lets an explicit reject stand against a perfect score", () => {
		const r = verdict({ rejectReason: "this brief cannot yield a chair", budgetUsed: MAX_ITERATIONS_PER_MODULE });
		assert.equal(r.verdict, "reject");
		assert.equal(r.iterationBudgetExceeded, false, "a named reason is a different failure from a spent budget, and merging them loses which one happened");
		assert.equal(r.rejectReason, "this brief cannot yield a chair");
	});

	it("does NOT let an unusable view present or reject", () => {
		// The asset may be fine; the render is what failed. Reporting either
		// terminal state would be asserting something about the asset that the
		// critic had no way of seeing.
		const r = verdict({ viewAdequacy: 0 });
		assert.equal(r.verdict, "continue");
		assert.equal(r.viewUsable, false);
		assert.equal(r.shouldPresent, false, "a perfect score judged from a render that shows nothing is not presentable");
	});

	it("refuses to present on an unusable view even at the budget limit", () => {
		const r = verdict({ viewAdequacy: 0, budgetUsed: MAX_ITERATIONS_PER_MODULE });
		assert.equal(r.verdict, "continue", "burning the budget on unjudgeable renders is a framing bug, not an asset failure, and rejecting the asset for it would throw away good work");
	});

	it("counts validity in the score, so a wrong category can still sink an asset", () => {
		// The whole reason validity is an axis and not a comment.
		const r = verdict({ axes: { validity: 0 } });
		assert.equal(r.score, 10, "validity is part of the total");
		assert.equal(r.shouldPresent, true, "10 clears the bar, which is the interesting case");
		assert.equal(
			verdict({ axes: { accuracy: 0, validity: 0 }, presentThreshold: 12 }).verdict,
			"continue",
			"but a category failure that also fails the brief does not present",
		);
	});

	it("states the threshold in axes rather than out of ten", () => {
		// 8 of 12 is a different bar than 8 of 10. Hardcoding the old
		// denominator would let an added axis silently lower the bar.
		assert.equal(PRESENT_SCORE_THRESHOLD, 8);
		assert.equal(MAX_SCORE_PER_AXIS, 2);
		assert.equal(
			verdict({ axes: { accuracy: 1, geometry: 1, materials: 1, completeness: 1, quality: 1, validity: 1 } }).verdict,
			"continue",
			"6 of 12 is below the bar",
		);
	});
});