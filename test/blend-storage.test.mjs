import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTs } from "./paths.mjs";

const storage = await loadTs("../blender/blend-storage.ts");

function manifest(root, overrides = {}) {
	return {
		version: 2,
		manifestPath: join(root, "blender-workspace.json"),
		workspacePath: root,
		blendPath: join(root, "model.blend"),
		latestIteration: 4,
		updatedAt: new Date().toISOString(),
		branchRuns: [],
		moduleRuns: [],
		renderOutputs: [],
		references: [],
		...overrides,
	};
}

function record(path, module, iteration, sequence, extra = {}) {
	return {
		module,
		name: module,
		iteration,
		sequence,
		branchPath: path,
		checkpointPath: extra.checkpointPath ?? path,
		status: "applied",
		...extra,
	};
}

test("a clone copy is a real independent file", async () => {
	const root = mkdtempSync(join(tmpdir(), "blend-storage-"));
	try {
		const source = join(root, "source.blend");
		const target = join(root, "copy.blend");
		writeFileSync(source, "BLENDER-source");
		await storage.copyBlendFile(source, target);
		assert.equal(readFileSync(target, "utf8"), "BLENDER-source");
		writeFileSync(source, "changed");
		assert.equal(readFileSync(target, "utf8"), "BLENDER-source", "the copy did not follow the source");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the global budget evicts old checkpoints but keeps each module's newest", async () => {
	const root = mkdtempSync(join(tmpdir(), "blend-storage-"));
	try {
		const paths = ["a1", "a2", "b1", "b2"].map((name) => join(root, `${name}.blend`));
		for (const path of paths) writeFileSync(path, Buffer.alloc(100));
		const runs = [
			record(join(root, "branch-a1.blend"), "a", 1, 1, { checkpointPath: paths[0] }),
			record(join(root, "branch-a2.blend"), "a", 2, 2, { checkpointPath: paths[1] }),
			record(join(root, "branch-b1.blend"), "b", 1, 3, { checkpointPath: paths[2] }),
			record(join(root, "branch-b2.blend"), "b", 2, 4, { checkpointPath: paths[3] }),
		];
		const plan = await storage.planBlendStorage(manifest(root, { branchRuns: runs }), {
			includeCheckpoints: true,
			budgetBytes: 150,
		});
		assert.equal(plan.checkpoints.length, 1, "one eviction brings the total under budget");
		assert.equal([paths[0], paths[2]].includes(plan.checkpoints[0].path), true);
		assert.equal(plan.checkpoints.some((entry) => entry.path === paths[1] || entry.path === paths[3]), false);
		assert.equal(plan.totalBytes, 100);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("applied copies are retired with a tombstone and staged work is untouched", async () => {
	const root = mkdtempSync(join(tmpdir(), "blend-storage-"));
	try {
		const manifestPath = join(root, "blender-workspace.json");
		const applied = join(root, "applied.blend");
		const staged = join(root, "staged.blend");
		const model = join(root, "model.blend");
		for (const path of [applied, staged, model]) writeFileSync(path, "BLENDER");
		const state = manifest(root, {
			branchRuns: [
				record(applied, "a", 1, 1),
				record(staged, "b", 2, 2, { status: "staged" }),
				record(model, "c", 3, 3),
			],
		});
		writeFileSync(manifestPath, JSON.stringify(state));
		assert.equal(await storage.retireAppliedBranches(manifestPath, state), 2);
		await assert.rejects(stat(applied));
		assert.equal(readFileSync(staged, "utf8"), "BLENDER");
		assert.equal(readFileSync(model, "utf8"), "BLENDER", "model.blend is never deleted");
		const next = JSON.parse(readFileSync(manifestPath, "utf8"));
		assert.equal(next.branchRuns[0].branchRetired, true);
		assert.equal(next.branchRuns[2].branchRetired, true);
		assert.equal(next.branchRuns[1].branchRetired, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a branch plan includes applied copies and never staged ones", async () => {
	const root = mkdtempSync(join(tmpdir(), "blend-storage-"));
	try {
		const applied = join(root, "applied.blend");
		const staged = join(root, "staged.blend");
		for (const path of [applied, staged]) writeFileSync(path, Buffer.alloc(10));
		const state = manifest(root, {
			branchRuns: [record(applied, "a", 1, 1), record(staged, "b", 2, 2, { status: "staged" })],
		});
		const plan = await storage.planBlendStorage(state, { includeBranches: true });
		assert.deepEqual(plan.branches.map((entry) => entry.path), [applied]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
