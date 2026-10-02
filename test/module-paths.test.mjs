// Shared module naming, paths, and checkpoint retention.
//
// These are the pure and filesystem-only rules both runners depend on, so a
// disagreement between them would put a live run's script in one directory and
// a branch run's in another -- a failure no render would show.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { loadTs } from "./paths.mjs";

const paths = await loadTs("../blender/module-paths.ts");
const {
	buildModuleScriptPreamble,
	DEFAULT_CHECKPOINT_RETENTION,
	getModuleDir,
	getModuleRunCheckpointName,
	getModuleScriptPath,
	getRunDir,
	getRunDirName,
	LEGACY_CHECKPOINT_FILE,
	MODULE_NAME_RE,
	MODULE_PREAMBLE_MARKER,
	MODULE_SCRIPT_FILE,
	normalizeModuleName,
	planCheckpointRetention,
	pruneOldModuleRuns,
	RENDER_FILE,
} = paths;

const roots = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratchWorkspace() {
	const root = await mkdtemp(join(tmpdir(), "pi-blender-module-paths-"));
	roots.push(root);
	return root;
}

test("module names are restricted because they become script path segments", () => {
	for (const ok of ["mug", "table-top", "arm2", "0abc", "a".repeat(64)]) {
		assert.equal(normalizeModuleName(ok), ok);
	}
	assert.equal(normalizeModuleName("  mug  "), "mug");

	// A traversal, a nested path, a separator, and anything outside the charset
	// are all refused, because each one would resolve somewhere else on disk.
	for (const bad of ["../evil", "a/b", "Mug", "mug_1", "mug.1", "a".repeat(65), "", "  ", "-mug"]) {
		assert.throws(() => normalizeModuleName(bad), /Invalid module name/);
	}
	assert.match("mug", MODULE_NAME_RE);
	assert.equal(MODULE_NAME_RE.test("mug_1"), false);
});

test("paths are derived from the workspace, not the process cwd", () => {
	const workspace = "/tmp/ws";
	assert.equal(getModuleDir(workspace, "mug"), join("/tmp/ws", "modules", "mug"));
	assert.equal(getModuleScriptPath(workspace, "mug"), join("/tmp/ws/modules/mug/script.py"));
	assert.equal(getRunDir(workspace, "mug", 3), join("/tmp/ws/modules/mug/runs/03"));
	assert.equal(MODULE_SCRIPT_FILE, "script.py");
	assert.equal(RENDER_FILE, "render.png");
	assert.equal(LEGACY_CHECKPOINT_FILE, "pre.blend");
});

test("run directories are zero padded and the checkpoint matches its run", () => {
	assert.equal(getRunDirName(1), "01");
	assert.equal(getRunDirName(9), "09");
	assert.equal(getRunDirName(10), "10");
	assert.equal(getModuleRunCheckpointName(3), "pre-03.blend");
	assert.equal(getModuleRunCheckpointName(12), "pre-12.blend");
	// The checkpoint is named for its own run, so a run directory identifies its
	// checkpoint and vice versa without consulting the manifest.
	assert.equal(getModuleRunCheckpointName(7), `pre-${getRunDirName(7)}.blend`);
	assert.equal(getRunDir("/ws", "mug", 7), join("/ws", "modules", "mug", "runs", "07"));
});

test("the preamble hands the script the blend it will really be run against", () => {
	const live = buildModuleScriptPreamble("/ws", "/ws/model.blend", "mug");
	assert.match(live, new RegExp(MODULE_PREAMBLE_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.match(live, /WORKSPACE_PATH = r"\/ws"/);
	assert.match(live, /BLEND_PATH = r"\/ws\/model\.blend"/);
	assert.match(live, /MODULE_NAME = r"mug"/);

	// The branch runner passes its own blend, so a script that saves relative
	// to BLEND_PATH lands in the file the branch actually owns.
	const branch = buildModuleScriptPreamble("/ws", "/ws/modules/mug/branch.blend", "mug");
	assert.match(branch, /BLEND_PATH = r"\/ws\/modules\/mug\/branch\.blend"/);
	assert.equal(live.split("\n").length, branch.split("\n").length);
});

test("retention keeps the newest generations and prunes only what is older", () => {
	assert.equal(DEFAULT_CHECKPOINT_RETENTION, 5);
	// Nothing is prunable until there are more generations than the window.
	assert.deepEqual(planCheckpointRetention(1), []);
	assert.deepEqual(planCheckpointRetention(5), []);
	assert.deepEqual(planCheckpointRetention(6), [1]);
	assert.deepEqual(planCheckpointRetention(8), [1, 2, 3]);
	assert.deepEqual(planCheckpointRetention(3, 1), [1, 2]);
	assert.deepEqual(planCheckpointRetention(3, 2), [1]);
	// A keep of 0 or a fraction still keeps the newest generation, because a
	// comparison with nothing to compare against is not a comparison.
	assert.deepEqual(planCheckpointRetention(4, 0), [1, 2, 3]);
	assert.deepEqual(planCheckpointRetention(4, 1.9), [1, 2, 3]);
	assert.deepEqual(planCheckpointRetention(0), []);
});

test("pruning removes old run directories and keeps the rest of the module", async () => {
	const workspace = await scratchWorkspace();
	const runsRoot = join(workspace, "modules", "mug", "runs");
	await mkdir(join(workspace, "modules", "mug"), { recursive: true });
	for (const iteration of [1, 2, 3, 4, 5, 6]) {
		const runDir = join(runsRoot, getRunDirName(iteration));
		await mkdir(runDir, { recursive: true });
		await writeFile(join(runDir, getModuleRunCheckpointName(iteration)), "BLENDER");
	}
	// Not a run directory, and not a checkpoint: a stray render beside the runs
	// must survive, because only whole run directories are ours to delete.
	await writeFile(join(workspace, "modules", "mug", RENDER_FILE), "PNG");
	await writeFile(join(workspace, "modules", "mug", "notes.txt"), "keep me");

	const removed = await pruneOldModuleRuns(workspace, "mug", 6);
	assert.deepEqual(removed, [1]);

	const left = (await readdir(runsRoot)).sort();
	assert.deepEqual(left, ["02", "03", "04", "05", "06"]);
	assert.equal(existsSync(join(workspace, "modules", "mug", RENDER_FILE)), true);
	assert.equal(existsSync(join(workspace, "modules", "mug", "notes.txt")), true);
	assert.equal((await stat(join(runsRoot, "02", "pre-02.blend"))).isFile(), true);
});

test("pruning is a no-op on a module that has no runs yet", async () => {
	const workspace = await scratchWorkspace();
	await mkdir(join(workspace, "modules", "mug"), { recursive: true });
	assert.deepEqual(await pruneOldModuleRuns(workspace, "mug", 1), []);
	assert.deepEqual(await pruneOldModuleRuns(workspace, "no-such-module", 9), []);
});
