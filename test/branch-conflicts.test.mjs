/**
 * Behavioural tests for the branch conflict rule.
 *
 * computeBranchConflicts and findRecordConflicts are the whole of the
 * no-auto-merge policy, and they are pure functions over manifest records. That
 * is deliberate: the policy is worth testing without needing a Blender to run,
 * and worth testing hard, because the failure it prevents is silent. An apply
 * that quietly takes a winner produces a model that looks built and is not.
 *
 * Every case here is about WHICH branches contest WHICH datablock, so these
 * tests stay meaningful when the branch machinery changes underneath them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const { computeBranchConflicts, findRecordConflicts, recordOwnedDatablocks } = await loadTs(
	`${fileURLToPath(new URL("../blender/branch.ts", import.meta.url))}`,
);

/** A staged branch run record, with only the fields the conflict rule reads. */
function record(module, { apply = [], materials = [], removed = [] } = {}) {
	return {
		module,
		iteration: 1,
		sequence: 1,
		branchPath: `/tmp/${module}/branch.blend`,
		scriptPath: `/tmp/${module}/script.py`,
		checkpointPath: `/tmp/${module}/runs/01/pre-01.blend`,
		at: "2026-01-01T00:00:00.000Z",
		touchedObjects: apply,
		touchedMaterials: materials,
		addedObjects: [],
		removedObjects: removed,
		applyObjects: apply,
		status: "staged",
	};
}

test("two branches claiming the same object conflict, naming both", () => {
	const conflicts = computeBranchConflicts([
		record("body", { apply: ["Mug"] }),
		record("handle", { apply: ["Mug"] }),
	]);
	assert.deepEqual(conflicts.get("Mug"), ["body", "handle"]);
});

test("two branches claiming the same MATERIAL conflict, not just objects", () => {
	// A paint module changes a material with no object moving. If the rule only
	// looked at objects, two modules painting one material would apply in turn
	// and the second would silently win.
	const conflicts = computeBranchConflicts([
		record("glaze", { materials: ["MugGlaze"] }),
		record("decal", { materials: ["MugGlaze"] }),
	]);
	assert.deepEqual(conflicts.get("MugGlaze"), ["glaze", "decal"]);
});

test("one branch listing a datablock twice is not a conflict with itself", () => {
	// A parent and its own child both listing the parent is one module being
	// internally consistent, and treating it as a contest would leave every
	// parented module permanently unappliable.
	const conflicts = computeBranchConflicts([record("arm", { apply: ["Mug", "Handle", "Arm"] })]);
	assert.equal(conflicts.size, 0);
});

test("branches claiming different objects do not conflict", () => {
	const conflicts = computeBranchConflicts([
		record("body", { apply: ["Mug"] }),
		record("handle", { apply: ["Handle"] }),
	]);
	assert.equal(conflicts.size, 0);
});

test("a removal contests another branch's claim on the same object", () => {
	// One module deleting what another module is building is the same authoring
	// disagreement as both editing it, and applying either silently would delete
	// or resurrect the other's work.
	const conflicts = computeBranchConflicts([
		record("body", { apply: ["Mug"] }),
		record("cleanup", { removed: ["Mug"] }),
	]);
	assert.deepEqual(conflicts.get("Mug"), ["body", "cleanup"]);
});

test("a third uncontested branch still applies while two others contest", () => {
	const mine = record("lid", { apply: ["Lid"] });
	const others = [record("body", { apply: ["Mug"] }), record("handle", { apply: ["Mug"] })];
	assert.deepEqual(findRecordConflicts(mine, others), [], "lid touches nothing contested");
	assert.equal(findRecordConflicts(others[0], [others[1]]).length, 1);
});

test("findRecordConflicts reports only MY conflicts, not the other pair's", () => {
	// The three modules: body and handle contest Mug; lid is clean. A body
	// record must hear about Mug only -- reporting handle's conflict would make
	// body look contested by a module it has nothing to do with.
	const body = record("body", { apply: ["Mug"] });
	const handle = record("handle", { apply: ["Mug", "Handle"] });
	const lid = record("lid", { apply: ["Lid"] });
	const conflicts = findRecordConflicts(body, [handle, lid]);
	assert.deepEqual(conflicts, [{ objectName: "Mug", modules: ["body", "handle"] }]);
});

test("a module cannot be listed twice as one side of a conflict", () => {
	// applyObjects and removedObjects can both name the same datablock in a
	// malformed record, and a duplicate module in the owners list would read as
	// a two-way contest.
	const weird = { ...record("body", { apply: ["Mug"] }), removedObjects: ["Mug"] };
	const conflicts = computeBranchConflicts([weird]);
	assert.equal(conflicts.size, 0, "one module listing one datablock is not a contest");
});

test("the owned set is the union of applied, materials, and removed", () => {
	const owned = recordOwnedDatablocks(record("body", { apply: ["Mug"], materials: ["Clay"], removed: ["Old"] }));
	assert.deepEqual([...owned].sort(), ["Clay", "Mug", "Old"]);
});

test("an empty pending set produces no conflicts rather than throwing", () => {
	// The apply path calls this on an empty staged list when a caller names
	// nothing, and an exception there would read as a workspace fault.
	assert.equal(computeBranchConflicts([]).size, 0);
});
