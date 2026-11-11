// One definition of "a generation", shared by the digest comparison and the
// iteration state. The bug these pin down is a rejected merge counting as
// history: a staged branch that was never applied, or a run that failed, is not
// a state the next run can be compared against.

import assert from "node:assert/strict";
import test from "node:test";

import { loadTs } from "./paths.mjs";

const generations = await loadTs("../blender/generations.ts");
const {
	collectModuleGenerations,
	collectModuleOwnership,
	isComparableStateDigest,
	previousModuleGeneration,
} = generations;

function branchRun(sequence, status, { digest, owned, materials } = {}) {
	return {
		module: "mug",
		iteration: sequence,
		sequence,
		status,
		stateDigest: digest,
		ownedObjects: owned,
		ownedMaterials: materials,
	};
}

function liveRun(sequence, { digest, owned, materials, viaBranchApply, status = "ok", name = "mug" } = {}) {
	return {
		name,
		iteration: sequence,
		sequence,
		status,
		stateDigest: digest,
		ownedObjects: owned,
		ownedMaterials: materials,
		viaBranchApply,
	};
}

test("only applied branch runs are generations", () => {
	const manifest = {
		branchRuns: [
			branchRun(1, "applied", { digest: "one" }),
			branchRun(2, "staged", { digest: "two" }),
			branchRun(3, "failed", { digest: "three" }),
			branchRun(4, "conflict", { digest: "four" }),
			branchRun(5, "applied", { digest: "five" }),
		],
		moduleRuns: [],
	};

	const collected = collectModuleGenerations(manifest, "mug");
	assert.deepEqual(
		collected.map((generation) => generation.iteration),
		[1, 5],
	);
});

test("a failed or conflicted run between two applied ones is skipped, not the newest applied", () => {
	const manifest = {
		branchRuns: [
			branchRun(1, "applied", { digest: "good-one" }),
			branchRun(2, "failed", { digest: "bad" }),
			branchRun(3, "conflict", { digest: "also-bad" }),
			branchRun(4, "applied", { digest: "good-four" }),
		],
		moduleRuns: [],
	};

	assert.equal(previousModuleGeneration(manifest, "mug", 5)?.iteration, 4);
	assert.equal(collectModuleGenerations(manifest, "mug")[1].stateDigest, "good-four");
	// The old predicate took the newest run below the target regardless of
	// status, which would answer 3 here. Only the applied one may be a baseline.
	assert.equal(previousModuleGeneration(manifest, "mug", 3)?.stateDigest, "good-one");
});

test("the moduleRun a branch apply writes is not a second generation", () => {
	const manifest = {
		branchRuns: [branchRun(1, "applied", { digest: "branch", owned: ["Mug"] })],
		moduleRuns: [liveRun(1, { digest: "branch", owned: ["Mug"], viaBranchApply: "/ws/branch.blend" })],
	};

	assert.equal(collectModuleGenerations(manifest, "mug").length, 1);
});

test("a live run is a generation and its ownership is carried", () => {
	const manifest = {
		branchRuns: [],
		moduleRuns: [liveRun(1, { digest: "live", owned: ["Mug", "Arm"] })],
	};

	const collected = collectModuleGenerations(manifest, "mug");
	assert.equal(collected.length, 1);
	assert.equal(collected[0].executionMode, "live");
	assert.deepEqual(collectModuleOwnership(manifest, "mug"), { objects: ["Arm", "Mug"], materials: [] });
});

test("legacy records without ownership fall back to known ownership, not empty", () => {
	const manifest = {
		branchRuns: [
			branchRun(1, "applied", { digest: "one", owned: ["Mug"] }),
			branchRun(2, "applied", { digest: "two" }),
		],
		moduleRuns: [],
	};

	assert.deepEqual(collectModuleOwnership(manifest, "mug"), { objects: ["Mug"], materials: [] });
});

test("an explicit empty ownership is a real answer, not a fallback", () => {
	const manifest = {
		branchRuns: [
			branchRun(1, "applied", { digest: "one", owned: ["Mug"] }),
			branchRun(2, "applied", { digest: "two", owned: [] }),
		],
		moduleRuns: [],
	};

	assert.deepEqual(collectModuleOwnership(manifest, "mug"), { objects: [], materials: [] });
});

test("material ownership is carried, so a paint module keeps a digest subject", () => {
	const manifest = {
		branchRuns: [branchRun(1, "applied", { digest: "one", owned: ["Mug"], materials: ["Glaze"] })],
		moduleRuns: [],
	};

	assert.deepEqual(collectModuleOwnership(manifest, "mug"), {
		objects: ["Mug"],
		materials: ["Glaze"],
	});
});

test("only other modules' runs are ignored", () => {
	const manifest = {
		branchRuns: [branchRun(1, "applied", { digest: "mug" }), { ...branchRun(2, "applied", { digest: "arm" }), module: "arm" }],
		moduleRuns: [liveRun(3, { digest: "mug-live" })],
	};

	assert.deepEqual(
		collectModuleGenerations(manifest, "mug").map((generation) => generation.sequence),
		[1, 3],
	);
});

test("an empty digest is not comparable, so it can never read as unchanged", () => {
	assert.equal(isComparableStateDigest(""), false);
	assert.equal(isComparableStateDigest(undefined), false);
	assert.equal(isComparableStateDigest(null), false);
	// A 32-hex legacy MD5 value is not a SHA-256 digest; comparing it with a new
	// run would report a change that did not happen.
	assert.equal(isComparableStateDigest("abc"), false);
	assert.equal(isComparableStateDigest("0".repeat(32)), false);
	assert.equal(isComparableStateDigest("0".repeat(64)), true);
});
