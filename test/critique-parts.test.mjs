/**
 * A part the reference names is either vouched for or it is a gap.
 *
 * The failure this covers is specific and was shipping: a mug with no handle
 * scored completeness 1, totalled 11/12, cleared the 8/12 present threshold, and
 * was presented. One point off an axis is not enough to stop a build that
 * otherwise reads well, so a named part gets its own gate — and the gate fails
 * closed, because the dangerous case is not a critic saying "there is no handle",
 * it is a critic that never mentions the handle. An omitted answer is how "I did
 * not look" used to read as "it is fine".
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadTs } from "./paths.mjs";

const { resolveCritiqueVerdict, findPartGaps, MAX_ITERATIONS_PER_MODULE, PRESENT_SCORE_THRESHOLD } = await loadTs(
	"../blender/critique.ts",
);
const { extractReferenceParts } = await loadTs("../blender/reference.ts");

/** What a mug reference declares, and the five axes a good build earns. */
const MUG_PARTS = ["body", "handle"];
const GOOD_AXES = { accuracy: 2, geometry: 2, materials: 2, completeness: 2, quality: 2, validity: 2 };

function verdict({ axes = GOOD_AXES, parts = MUG_PARTS, checklist, budgetUsed = 1, viewAdequacy = 2 } = {}) {
	return resolveCritiqueVerdict({
		axes,
		viewAdequacy,
		budgetUsed,
		expectedParts: parts,
		partChecklist: checklist,
	});
}

describe("part presence", () => {
	it("presents a build whose parts are all vouched for", () => {
		const r = verdict({
			checklist: [
				{ part: "body", present: true, evidence: "the whole body is in frame" },
				{ part: "handle", present: true, evidence: "handle on the right, as in the reference" },
			],
		});
		assert.deepEqual(r.partGaps, []);
		assert.equal(r.score, 12);
		assert.equal(r.shouldPresent, true);
		assert.equal(r.verdict, "present");
	});

	it("caps completeness and blocks present when the handle is marked absent", () => {
		// Five axes at 2: 11/12 is a good build by the old rule, which is exactly
		// the build that shipped without a handle.
		const r = verdict({
			checklist: [
				{ part: "body", present: true, evidence: "the body is in frame" },
				{ part: "handle", present: false, evidence: "smooth body where the handle should be" },
			],
		});
		assert.deepEqual(r.partGaps, ["handle"]);
		assert.equal(r.axes.completeness, 1);
		assert.equal(r.axes.quality, 2, "the other axes are not rewritten");
		assert.equal(r.score, 11);
		assert.ok(r.score >= PRESENT_SCORE_THRESHOLD, "the score alone would still have cleared the threshold");
		assert.equal(r.shouldPresent, false);
		assert.equal(r.verdict, "continue");
	});

	it("treats a part the critic never answered as missing", () => {
		const r = verdict({
			checklist: [{ part: "body", present: true, evidence: "the body is in frame" }],
		});
		assert.deepEqual(r.partGaps, ["handle"]);
		assert.equal(r.score, 11);
		assert.equal(r.shouldPresent, false);
	});

	it("treats a checklist with no answers at all as every part missing", () => {
		// The fail-closed case the issue exists for: a reference names parts, the
		// critic answers nothing, and the run must not come out present.
		const r = verdict({ checklist: [] });
		assert.deepEqual(r.partGaps, ["body", "handle"]);
		assert.equal(r.score, 11);
		assert.equal(r.shouldPresent, false);
		assert.equal(r.verdict, "continue");
	});

	it("does not count a present with no evidence as a vouched part", () => {
		const r = verdict({
			checklist: [
				{ part: "body", present: true, evidence: "the body is in frame" },
				{ part: "handle", present: true, evidence: "   " },
			],
		});
		assert.deepEqual(r.partGaps, ["handle"]);
		assert.equal(r.shouldPresent, false);
	});

	it("catches a part on the far side through the checklist", () => {
		// The case no single view can settle: the handle is out of frame, so the
		// render looks correct from here. The critic has to say it cannot vouch for
		// it and name the panel that would, which is a gap, not a pass.
		const r = verdict({
			checklist: [
				{ part: "body", present: true, evidence: "the body is in frame" },
				{
					part: "handle",
					present: false,
					evidence: "on the far side here; the side panel shows the body only, no handle",
				},
			],
		});
		assert.deepEqual(r.partGaps, ["handle"]);
		assert.equal(r.axes.completeness, 1);
		assert.equal(r.shouldPresent, false);
	});

	it("still presents an asset whose reference names no parts", () => {
		const r = verdict({ parts: [], checklist: [] });
		assert.deepEqual(r.partGaps, []);
		assert.equal(r.shouldPresent, true);
	});

	it("matches a part name the critic wrote in different case", () => {
		const r = verdict({
			checklist: [
				{ part: "Body", present: true, evidence: "the body is in frame" },
				{ part: "HANDLE", present: true, evidence: "handle on the right" },
			],
		});
		assert.deepEqual(r.partGaps, []);
		assert.equal(r.shouldPresent, true);
	});

	it("rejects on a part gap when the iteration budget is spent", () => {
		const r = verdict({
			budgetUsed: MAX_ITERATIONS_PER_MODULE,
			checklist: [
				{ part: "body", present: true, evidence: "the body is in frame" },
				{ part: "handle", present: false, evidence: "no handle anywhere" },
			],
		});
		assert.equal(r.shouldPresent, false);
		assert.equal(r.verdict, "reject");
		assert.equal(r.iterationBudgetExceeded, true);
		assert.equal(r.rejectReason, undefined, "a spent budget is not a stated reason");
	});
});

describe("findPartGaps", () => {
	it("reports a part the critic marked absent that the reference never named", () => {
		// A critic that looked and found nothing is a finding even when the
		// reference was vague, so absence is not only a reference-side question.
		assert.deepEqual(findPartGaps([], [{ part: "lid", present: false, evidence: "no lid on the pot" }]), ["lid"]);
	});

	it("does not report the same part twice", () => {
		const gaps = findPartGaps(
			["handle", "Handle"],
			[{ part: "handle", present: false, evidence: "missing" }],
		);
		assert.deepEqual(gaps, ["handle"]);
	});
});

describe("where the parts come from", () => {
	it("recovers the parts from the describer's report line", () => {
		// The manager's brief is built from this text, so the parts the describer
		// saw are already in the caption it handed to blender_add_reference.
		const parts = extractReferenceParts(
			"Subject: a ceramic mug\nParts: body, handle, rim\nNotable features: matte glaze, thick handle",
		);
		assert.deepEqual(parts, ["body", "handle", "rim"]);
	});

	it("recovers them from a notable-features line when no parts line exists", () => {
		const parts = extractReferenceParts("Notable features: tall body, thick handle, flared base");
		assert.deepEqual(parts, ["tall body", "thick handle", "flared base"]);
	});

	it("declares no parts rather than inventing them from prose", () => {
		// Inventing parts turns "the critic answered nothing" into "the model is
		// missing something", which is the worse of the two errors.
		assert.deepEqual(extractReferenceParts("A mug on a table, lit from the left."), []);
		assert.deepEqual(extractReferenceParts("A white ceramic mug with a handle."), []);
	});
});
