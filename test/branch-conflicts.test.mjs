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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const { computeBranchConflicts, contestableStagedRuns, findRecordConflicts, appendBranchRun, latestStagedBranch, pruneBranchRunHistory, recordOwnedDatablocks } = await loadTs(
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

function manifest(runs, moduleRuns = []) {
	return { branchRuns: runs, moduleRuns };
}

test("a superseded staged branch stops contesting the objects it used to own", () => {
	// A module was re-run before its abandoned first branch was applied. The old
	// branch still exists, but it is no longer the module's live claim: the
	// re-run replaced it, so a sibling touching its old object must not be
	// refused forever by a branch nobody will apply.
	const old = record("body", { apply: ["OldMug"] });
	old.sequence = 1;
	const rerun = record("body", { apply: ["NewMug"] });
	rerun.sequence = 2;
	const active = contestableStagedRuns(manifest([old, rerun]));
	assert.deepEqual(active.map((run) => run.sequence), [2]);
	assert.equal(findRecordConflicts(record("handle", { apply: ["OldMug"] }), active).length, 0);
});

test("an applied branch retires the staged record before it", () => {
	const old = record("body", { apply: ["Mug"] });
	old.sequence = 1;
	const applied = record("body", { apply: ["Mug"] });
	applied.sequence = 2;
	applied.status = "applied";
	assert.deepEqual(contestableStagedRuns(manifest([old, applied])), []);
});

test("a successful live run also supersedes an older staged branch", () => {
	const old = record("body", { apply: ["Mug"] });
	old.sequence = 1;
	const live = { name: "body", iteration: 2, sequence: 2, status: "ok" };
	assert.deepEqual(contestableStagedRuns(manifest([old], [live])), []);
});

test("a failed later run does not retire a staged branch that still has work", () => {
	// Nothing landed from the later run, so the staged branch is still the only
	// description of that module's pending work.
	const old = record("body", { apply: ["Mug"] });
	old.sequence = 1;
	const failed = { name: "body", iteration: 2, sequence: 2, status: "failed" };
	assert.deepEqual(contestableStagedRuns(manifest([old], [failed])).map((run) => run.sequence), [1]);
});

test("branch history keeps five records per module, not five globally", () => {
	const runs = Array.from({ length: 9 }, (_, index) => ({ ...record("body"), iteration: index + 1, sequence: index + 1 }));
	const kept = pruneBranchRunHistory(runs);
	assert.deepEqual(kept.sort((a, b) => a.iteration - b.iteration).map((run) => run.iteration), [5, 6, 7, 8, 9]);
});

test("a staged branch survives pruning while it is a module's newest work", () => {
	const staged = { ...record("body", { apply: ["Mug"] }), iteration: 8, sequence: 8 };
	const earlier = Array.from({ length: 6 }, (_, index) => ({ ...record("body"), iteration: index + 2, sequence: index + 2, status: "applied" }));
	assert.deepEqual(
		pruneBranchRunHistory([staged, ...earlier]).map((run) => run.sequence).sort((a, b) => a - b),
		[4, 5, 6, 7, 8],
		"the pending newest record is inside the window; the sixth-newest goes",
	);
	const superseded = { ...staged, sequence: 1, iteration: 1 };
	assert.equal(pruneBranchRunHistory([superseded, ...earlier]).some((run) => run.sequence === 1), false);
});

test("a second round of a 40-module build still sees round one's ownership", () => {
	// Sequences are globally unique and monotonic in production: one round of 40
	// modules advances the clock by 40. An iteration-keyed window erased every
	// module's previous record here, which killed the ownedObjects carry-forward.
	let clock = 0;
	let runs = [];
	const modules = Array.from({ length: 40 }, (_, index) => `part-${index}`);
	for (let round = 1; round <= 2; round += 1) {
		for (const module of modules) {
			clock += 1;
			runs.push({
				...record(module, { apply: [`${module}-object`] }),
				ownedObjects: [`${module}-object`],
				iteration: clock,
				sequence: clock,
				status: "applied",
			});
		}
		runs = pruneBranchRunHistory(runs);
	}
	assert.equal(runs.length, modules.length * 2, "each module keeps both of its records");
	const body = runs.filter((run) => run.module === "part-7" && run.ownedObjects?.includes("part-7-object"));
	assert.equal(body.length, 2);
	assert.ok(body.some((run) => run.sequence <= modules.length), "round two still has round one's ownership to carry");
});

test("an apply takes the newest staged record by sequence, not by append order", () => {
	const newer = { ...record("body", { apply: ["New"] }), sequence: 9, iteration: 9 };
	const older = { ...record("body", { apply: ["Old"] }), sequence: 4, iteration: 4 };
	assert.equal(latestStagedBranch({ branchRuns: [newer, older] }, "body")?.sequence, 9);
	assert.equal(latestStagedBranch({ branchRuns: [older, newer] }, "body")?.sequence, 9);
	assert.equal(latestStagedBranch({ branchRuns: [{ ...older, status: "applied" }] }, "body"), undefined);
});

test("an applied re-run retires the staged record it superseded", () => {
	// The apply's newest-by-sequence lookup must not resurrect a branch that the
	// contract calls dead just because it is the only record still marked staged.
	const old = { ...record("body", { apply: ["Old"] }), sequence: 1, iteration: 1 };
	const superseding = { ...record("body"), sequence: 2, iteration: 2, status: "applied" };
	assert.equal(latestStagedBranch({ branchRuns: [old, superseding] }, "body"), undefined);
});

test("a long multi-module build does not grow the manifest without bound", () => {
	// 40 modules x 20 rounds with a global clock: the retained history must be
	// five records per module, not five shaped by the iteration counter.
	let clock = 0;
	let runs = [];
	const modules = Array.from({ length: 40 }, (_, index) => `part-${index}`);
	for (let round = 1; round <= 20; round += 1) {
		for (const module of modules) {
			clock += 1;
			runs.push({ ...record(module), iteration: clock, sequence: clock, status: "applied" });
		}
		runs = pruneBranchRunHistory(runs);
	}
	assert.equal(runs.length, modules.length * 5);
	const bytes = Buffer.byteLength(JSON.stringify(runs), "utf8");
	assert.ok(bytes < 300_000, `retained history is ${bytes} bytes; the manifest is a state file, not a log`);
});

test("the branch run path appends through the retention window", () => {
	// The window is only useful if the run path uses it: a helper-only test stays
	// green after the wiring is deleted.
	const source = readFileSync(new URL("../blender/branch.ts", import.meta.url), "utf8");
	assert.match(source, /current\.branchRuns = appendBranchRun\(current, record\)/);
	assert.match(source, /latestStagedBranch\(manifest, name\)/);
	const current = { branchRuns: Array.from({ length: 5 }, (_, index) => ({ ...record("body"), sequence: index + 1, iteration: index + 1 })) };
	const appended = appendBranchRun(current, { ...record("body"), sequence: 6, iteration: 6 });
	assert.deepEqual(appended.map((run) => run.sequence).sort((a, b) => a - b), [2, 3, 4, 5, 6]);
});
