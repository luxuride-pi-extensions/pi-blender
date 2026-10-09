/**
 * Which generation a comparison sheet gets compared against.
 *
 * blender_compare's contract is "the baseline is the run immediately before
 * this module's latest one". Two ways that was quietly untrue, both about a run
 * record that carries no checkpoint:
 *
 *   - the baseline candidate filter SKIPPED such a run, so with three runs
 *     where the middle one has no checkpoint, `at(-2)` over the filtered list
 *     and "the run before the latest" disagree -- and `at(-2)` handed back the
 *     FIRST run, a sheet comparing against a generation two steps back, which
 *     the tool reported as the latest comparison;
 *   - if the LATEST run itself has no checkpoint, the same filter hid it and
 *     the function silently compared two generations ago rather than saying
 *     there is nothing to compare.
 *
 * The branch/module mix is the reason this cannot be tested by reading. A
 * branch run and its apply write two records sharing one sequence; the apply's
 * record also lands in moduleRuns. Sequences are global, so a sequence
 * belonging to a DIFFERENT module interleaves this module's generations, and
 * "second-to-last by sequence" is not "the previous run of this module" unless
 * the filtering and the ordering both key on the module.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./paths.mjs";

const { resolvePreviousCheckpoint } = await loadTs("../blender/compare.ts");

const MODULE = "table-top";
const OTHER = "door-handle";

const branchRun = (over = {}) => ({
	module: MODULE,
	sequence: 1,
	iteration: 1,
	checkpointPath: "/w/runs/01/pre-01.blend",
	...over,
});

const moduleRun = (over = {}) => ({
	name: MODULE,
	sequence: 1,
	iteration: 1,
	checkpointPath: "/w/runs/01/pre-01.blend",
	...over,
});

test("three generations: the baseline is the one immediately before the latest", () => {
	const manifest = {
		moduleRuns: [
			moduleRun({ sequence: 1, iteration: 1, checkpointPath: "/w/runs/01/pre-01.blend" }),
			moduleRun({ sequence: 2, iteration: 2, checkpointPath: "/w/runs/02/pre-02.blend" }),
			moduleRun({ sequence: 3, iteration: 3, checkpointPath: "/w/runs/03/pre-03.blend" }),
		],
	};
	assert.deepEqual(resolvePreviousCheckpoint(manifest, MODULE), {
		checkpointPath: "/w/runs/02/pre-02.blend",
		iteration: 2,
	});
});

test("a run with no checkpoint is skipped, and the generation after it is the baseline", () => {
	// The filter and the ordering disagreeing. The middle run cannot be a
	// baseline -- there is no file to hand the bridge -- so the answer is the
	// first run, which is the run immediately before the latest CHECKPOINTED
	// generation, and NOT `at(-2)` of the filtered list.
	const manifest = {
		moduleRuns: [
			moduleRun({ sequence: 1, iteration: 1, checkpointPath: "/w/runs/01/pre-01.blend" }),
			moduleRun({ sequence: 2, iteration: 2, checkpointPath: undefined }),
			moduleRun({ sequence: 3, iteration: 3, checkpointPath: "/w/runs/03/pre-03.blend" }),
		],
	};
	assert.deepEqual(resolvePreviousCheckpoint(manifest, MODULE), {
		checkpointPath: "/w/runs/01/pre-01.blend",
		iteration: 1,
	});
});

test("the latest run with no checkpoint raises rather than comparing two generations ago", () => {
	const manifest = {
		moduleRuns: [
			moduleRun({ sequence: 1, iteration: 1, checkpointPath: "/w/runs/01/pre-01.blend" }),
			moduleRun({ sequence: 2, iteration: 2, checkpointPath: "/w/runs/02/pre-02.blend" }),
			moduleRun({ sequence: 3, iteration: 3, checkpointPath: undefined }),
		],
	};
	assert.throws(
		() => resolvePreviousCheckpoint(manifest, MODULE),
		/latest one records no checkpoint/,
	);
});

test("a branch run and its apply share one sequence and count once", () => {
	// The headless path: the run writes a branchRuns record, and the apply
	// writes a moduleRuns record with the same sequence and checkpoint. Counting
	// both would make one generation look like two and compare the build with
	// itself -- a sheet of identical pairs that reads as proof of stability.
	const manifest = {
		branchRuns: [
			branchRun({ sequence: 1, iteration: 1, checkpointPath: "/w/runs/01/pre-01.blend" }),
			branchRun({ sequence: 2, iteration: 2, checkpointPath: "/w/runs/02/pre-02.blend" }),
			branchRun({ sequence: 3, iteration: 3, checkpointPath: "/w/runs/03/pre-03.blend" }),
		],
		moduleRuns: [
			moduleRun({ sequence: 3, iteration: 3, checkpointPath: "/w/runs/03/pre-03.blend" }),
		],
	};
	assert.deepEqual(resolvePreviousCheckpoint(manifest, MODULE), {
		checkpointPath: "/w/runs/02/pre-02.blend",
		iteration: 2,
	});
});

test("another module's sequences do not become this module's baseline", () => {
	// Sequences are global, so a sequence belonging to another module
	// interleaves this module's generations. Filtering has to key on the module
	// before the ordering, or `at(-2)` is another module's run.
	const manifest = {
		branchRuns: [
			branchRun({ sequence: 1, iteration: 1, checkpointPath: "/w/runs/01/pre-01.blend" }),
			branchRun({ module: OTHER, sequence: 2, iteration: 2, checkpointPath: "/w/other/runs/02/pre-02.blend" }),
			branchRun({ sequence: 3, iteration: 3, checkpointPath: "/w/runs/03/pre-03.blend" }),
		],
	};
	assert.deepEqual(resolvePreviousCheckpoint(manifest, MODULE), {
		checkpointPath: "/w/runs/01/pre-01.blend",
		iteration: 1,
	});
});

test("a branch run wins a shared sequence over the moduleRun for the same apply", () => {
	// The branchRun names the state the run STARTED from; the apply's
	// moduleRuns record is the same event written the other way. Either gives
	// the same checkpoint today, so the test pins the ordering rule rather than
	// a number: it must not be whichever happened to be written last.
	const manifest = {
		branchRuns: [
			branchRun({ sequence: 1, iteration: 1, checkpointPath: "/w/branch-01.blend" }),
			branchRun({ sequence: 2, iteration: 2, checkpointPath: "/w/branch-02.blend" }),
		],
		moduleRuns: [
			moduleRun({ sequence: 1, iteration: 1, checkpointPath: "/w/apply-01.blend" }),
			moduleRun({ sequence: 2, iteration: 2, checkpointPath: "/w/apply-02.blend" }),
		],
	};
	assert.equal(resolvePreviousCheckpoint(manifest, MODULE).checkpointPath, "/w/branch-01.blend");
});

test("mixed generations across both lists, with an uncheckpointed latest, still raises", () => {
	const manifest = {
		branchRuns: [
			branchRun({ sequence: 1, iteration: 1, checkpointPath: "/w/runs/01/pre-01.blend" }),
			branchRun({ sequence: 3, iteration: 3, checkpointPath: undefined }),
		],
		moduleRuns: [
			moduleRun({ sequence: 2, iteration: 2, checkpointPath: "/w/runs/02/pre-02.blend" }),
		],
	};
	assert.throws(() => resolvePreviousCheckpoint(manifest, MODULE), /latest one records no checkpoint/);
});

test("mixed generations with a checkpointed latest resolve to the previous checkpointed run", () => {
	const manifest = {
		branchRuns: [
			branchRun({ sequence: 1, iteration: 1, checkpointPath: "/w/runs/01/pre-01.blend" }),
			branchRun({ sequence: 2, iteration: 2, checkpointPath: undefined }),
		],
		moduleRuns: [
			moduleRun({ sequence: 3, iteration: 3, checkpointPath: "/w/runs/03/pre-03.blend" }),
			moduleRun({ sequence: 4, iteration: 4, checkpointPath: "/w/runs/04/pre-04.blend" }),
		],
	};
	assert.deepEqual(resolvePreviousCheckpoint(manifest, MODULE), {
		checkpointPath: "/w/runs/03/pre-03.blend",
		iteration: 3,
	});
});

test("one generation refuses with the reason", () => {
	assert.throws(
		() =>
			resolvePreviousCheckpoint(
				{ moduleRuns: [moduleRun({ sequence: 1, iteration: 1 })] },
				MODULE,
			),
		/there is no previous generation to compare against/,
	);
});

test("no recorded runs at all refuses with its own reason", () => {
	// Not the same message on purpose: with nothing recorded, "its latest one
	// records no checkpoint" would be a sentence about a run that does not
	// exist, and the advice differs (the module was never run, or the caller
	// pointed at the wrong module).
	assert.throws(
		() => resolvePreviousCheckpoint({ moduleRuns: [], branchRuns: [] }, MODULE),
		/has no recorded runs, so there is nothing to compare against/,
	);
});

test("a module with no recorded runs names the module and suggests the way out", () => {
	assert.throws(
		() => resolvePreviousCheckpoint({}, MODULE),
		(error) => {
			assert.match(error.message, new RegExp(`"${MODULE}"`));
			assert.match(error.message, /baselineBlendPath/);
			return true;
		},
	);
});

test("a run with an unrecorded iteration still names its checkpoint", () => {
	// `iteration` is optional on both lists, so a legacy record has a path and
	// no number. The sheet labels fall back to the generation words for that,
	// which is a readable answer; inventing an iteration would not be.
	const manifest = {
		moduleRuns: [
			moduleRun({ sequence: 1, iteration: undefined, checkpointPath: "/w/runs/01/pre-01.blend" }),
			moduleRun({ sequence: 2, iteration: undefined, checkpointPath: "/w/runs/02/pre-02.blend" }),
		],
	};
	assert.deepEqual(resolvePreviousCheckpoint(manifest, MODULE), {
		checkpointPath: "/w/runs/01/pre-01.blend",
		iteration: undefined,
	});
});