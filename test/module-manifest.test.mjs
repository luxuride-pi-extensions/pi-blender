import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadTs } from "./paths.mjs";

// Why this file exists as its own suite, and why it tests a pure function:
// the bug it guards is in the ORDER of two events separated by minutes. A
// module run claims its iteration under the manifest lock, then spends minutes
// inside Blender, and only then publishes success. Anything that claims a
// higher iteration in between is normal — a later module run, an ad-hoc
// blender_execute_python — so "publish my own number" is wrong in exactly the
// case the lock was added to survive. Reproducing the two-minute gap needs a
// Blender UI, so the decision it made is factored into applySuccessfulRun and
// asserted here instead.
//
// The manifest publish runs inside BlenderModuleRevert's neighbours, so it is
// exported purely to be assertable here; loading the module still needs jiti,
// because pi-blender is TypeScript with NodeNext ".js" specifiers.
const { applySuccessfulRun, pruneRevertedGenerations } = await loadTs("../blender/module.ts");

function manifest(overrides = {}) {
	return {
		version: 2,
		latestIteration: 0,
		moduleRuns: [],
		renderOutputs: [],
		savedViews: {},
		...overrides,
	};
}

const run = (over = {}) => ({
	moduleName: "table-top",
	iteration: 4,
	sequence: 4,
	checkpointPath: "/w/modules/table-top/runs/04/pre-04.blend",
	exitCode: 0,
	...over,
});

describe("the iteration counter only ever goes up", () => {
	it("keeps a higher number claimed while this run was inside Blender", () => {
		// The bug. Run A claims 4, then spends minutes in Blender. Run B claims 5
		// and finishes. A then publishes success and would set latestIteration
		// back to 4 — after which the next run claims 4 again and writes into
		// B's runs/04 directory.
		const m = manifest({ latestIteration: 5 });

		applySuccessfulRun(m, run({ iteration: 4, sequence: 4 }));

		assert.equal(
			m.latestIteration,
			5,
			"a slow run must not walk the counter back over a later claim",
		);
	});

	it("still advances the counter when nothing else has claimed", () => {
		const m = manifest({ latestIteration: 3 });

		applySuccessfulRun(m, run({ iteration: 4, sequence: 4 }));

		assert.equal(m.latestIteration, 4);
	});

	it("records the run itself even when the counter was left alone", () => {
		// The run happened; refusing to record it would lose the checkpoint and
		// make the module un-revertable. The counter and the history are separate
		// facts and the fix must not confuse them.
		const m = manifest({ latestIteration: 5 });

		applySuccessfulRun(m, run({ iteration: 4, sequence: 4 }));

		assert.equal(m.moduleRuns.length, 1);
		assert.equal(m.moduleRuns[0].iteration, 4);
		assert.equal(m.moduleRuns[0].status, "ok");
	});

	it("keeps two runs of the same module distinct, which is what revert compares", () => {
		// blender_module_revert decides what "later" means by comparing sequence.
		// Two records sharing a sequence would make that comparison a coin toss
		// and the guard that refuses to discard another module's work would stop
		// working.
		const m = manifest({ latestIteration: 4 });
		applySuccessfulRun(m, run({ iteration: 4, sequence: 4 }));
		applySuccessfulRun(m, run({ iteration: 5, sequence: 5 }));

		const sequences = m.moduleRuns.map((r) => r.sequence);
		assert.deepEqual(sequences, [4, 5]);
		assert.equal(new Set(sequences).size, sequences.length, "sequences must be unique");
	});

	it("appends to existing history rather than replacing it", () => {
		const m = manifest({
			latestIteration: 1,
			moduleRuns: [{ name: "other-part", iteration: 1, sequence: 1, at: "x", exitCode: 0, status: "ok" }],
		});

		applySuccessfulRun(m, run({ moduleName: "table-top", iteration: 2, sequence: 2 }));

		assert.deepEqual(
			m.moduleRuns.map((r) => r.name),
			["other-part", "table-top"],
			"a concurrent run already on disk must survive",
		);
	});

	it("tolerates a legacy manifest with no moduleRuns key at all", () => {
		// readManifest normalises the key, so a real caller never sees this — but
		// a callback that throws here would take down the whole publish, and the
		// run would be lost with nothing recorded.
		const m = manifest();
		delete m.moduleRuns;

		applySuccessfulRun(m, run());

		assert.equal(m.moduleRuns.length, 1);
	});

	it("records the render against the run that produced it", () => {
		const m = manifest();

		applySuccessfulRun(m, run(), { path: "/w/modules/table-top/render.png", view: "front" });

		assert.equal(m.renderOutputs.length, 1);
		assert.equal(m.renderOutputs[0].iteration, 4);
		assert.equal(m.renderOutputs[0].view, "front");
		assert.equal(m.renderOutputs[0].module, "table-top");
	});

	it("records the digest and ownership so the next run has a subject", () => {
		const m = manifest();

		applySuccessfulRun(m, run({ ownedObjects: ["Mug"], stateDigest: "abc" }));

		assert.deepEqual(m.moduleRuns[0].ownedObjects, ["Mug"]);
		assert.equal(m.moduleRuns[0].stateDigest, "abc");
	});

	it("records no render when there was none", () => {
		const m = manifest();

		applySuccessfulRun(m, run(), null);

		assert.deepEqual(m.renderOutputs, []);
	});
});

describe("a revert retires the generations it removed from model.blend", () => {
	const branchRun = (module, sequence, status) => ({ module, sequence, status });

	it("drops applied branch records at or after the target, and the matching live runs", () => {
		const current = {
			moduleRuns: [
				{ name: "mug", sequence: 1 },
				{ name: "mug", sequence: 3 },
				{ name: "arm", sequence: 4 },
			],
			branchRuns: [
				branchRun("mug", 1, "applied"),
				branchRun("mug", 3, "applied"),
				branchRun("arm", 4, "applied"),
			],
		};

		pruneRevertedGenerations(current, { name: "mug", sequence: 2 });

		assert.deepEqual(
			current.moduleRuns.map((run) => run.sequence),
			[1],
			"a later module run no longer describes model.blend",
		);
		assert.deepEqual(
			current.branchRuns.map((run) => `${run.module}:${run.sequence}`),
			["mug:1", "arm:4"],
			"the reverted-away applied record must not remain a comparison baseline",
		);
	});

	it("keeps a staged branch record, whose work is still in its branch blend", () => {
		const current = {
			moduleRuns: [],
			branchRuns: [branchRun("mug", 2, "staged"), branchRun("mug", 3, "applied")],
		};

		pruneRevertedGenerations(current, { name: "mug", sequence: 2 });

		assert.deepEqual(
			current.branchRuns.map((run) => `${run.sequence}:${run.status}`),
			["2:staged"],
		);
	});

	it("changes nothing when there is no target record", () => {
		const current = {
			moduleRuns: [{ name: "mug", sequence: 3 }],
			branchRuns: [branchRun("mug", 3, "applied")],
		};

		pruneRevertedGenerations(current, undefined);

		assert.equal(current.moduleRuns.length, 1);
		assert.equal(current.branchRuns.length, 1);
	});
});
