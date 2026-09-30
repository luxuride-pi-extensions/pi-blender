/**
 * End-to-end tests for branch runs and applies, against a real headless Blender.
 *
 * The conflict RULE is unit-tested in branch-conflicts.test.mjs with no Blender
 * at all. This file covers the part that rule cannot: does the apply actually
 * bring the branch's datablocks into model.blend and leave everything else
 * alone. That is a question about Blender's own append and library-load
 * semantics, so nothing short of running Blender answers it — a mock would
 * only assert that the code calls the API the way the mock expects, which is
 * the thing in doubt.
 *
 * Skipped, not failed, when no Blender is resolvable, so the suite stays green
 * on a machine without one. Everything here is real: real workspaces, real
 * blends, real headless runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const branch = await loadTs(`${fileURLToPath(new URL("../blender/branch.ts", import.meta.url))}`);
const workspace = await loadTs(`${fileURLToPath(new URL("../blender/workspace.ts", import.meta.url))}`);
const module = await loadTs(`${fileURLToPath(new URL("../blender/module.ts", import.meta.url))}`);

/** Whether a real headless Blender can be launched at all. */
async function blenderAvailable() {
	try {
		const { resolveBlenderArgv } = await loadTs(fileURLToPath(new URL("../launch.ts", import.meta.url)));
		const { command, args } = await resolveBlenderArgv();
		const { execFileSync } = await import("node:child_process");
		execFileSync(command, [...args, "--version"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

const hasBlender = await blenderAvailable();
const skip = hasBlender ? false : "no headless Blender available on this machine";

/**
 * A scratch root a headless Blender can actually write into.
 *
 * NOT /tmp: the flatpak sandbox cannot see it, and studio blend creation then
 * fails with "Cannot open file ... for writing" rather than anything naming the
 * cause -- the same reason config.ts keeps its temp dir under the XDG cache
 * home. Callers remove the directory in a finally.
 */
function scratchRoot() {
	const base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-blender", "test-scratch");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "branch-"));
}

/**
 * A workspace with a real model.blend and no camera clutter to confuse things.
 */
async function makeWorkspace() {
	const root = scratchRoot();
	const created = await workspace.blenderWorkspaceInit({ cwd: root, template: "studio" });
	return { root, workspacePath: created.workspacePath, blendPath: created.blendPath };
}

function writeScript(workspacePath, moduleName, source) {
	const dir = join(workspacePath, "modules", moduleName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "script.py"), source, "utf-8");
}

/** Object names currently in a blend file, via a headless probe. */
async function objectNames(cwd, blendPath) {
	const utils = await loadTs(fileURLToPath(new URL("../blender/utils.ts", import.meta.url)));
	return await utils.runBlenderJson({
		cwd,
		blendPath,
		scriptSource: `
import bpy, json, sys
payload = json.loads(sys.argv[sys.argv.index("--") + 1])
print("__PI_BLENDER_JSON_START__")
print(json.dumps(sorted(o.name for o in bpy.data.objects)))
print("__PI_BLENDER_JSON_END__")
`,
		payload: {},
		timeoutMs: 120_000,
	});
}

/** Material names in a blend file, the same way. */
async function materialNames(cwd, blendPath) {
	const utils = await loadTs(fileURLToPath(new URL("../blender/utils.ts", import.meta.url)));
	return await utils.runBlenderJson({
		cwd,
		blendPath,
		scriptSource: `
import bpy, json, sys
json.loads(sys.argv[sys.argv.index("--") + 1])
print("__PI_BLENDER_JSON_START__")
print(json.dumps(sorted(m.name for m in bpy.data.materials)))
print("__PI_BLENDER_JSON_END__")
`,
		payload: {},
		timeoutMs: 120_000,
	});
}

const ADD_CUBE = `
import bpy
bpy.ops.mesh.primitive_cube_add()
bpy.context.object.name = "Mug"
`;

const MOVE_CUBE = `
import bpy
obj = bpy.data.objects.get("Mug")
obj.location.x = 5.0
`;

test("a branch run stages changes WITHOUT touching model.blend", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "body", ADD_CUBE);
		const before = await objectNames(ws.root, ws.blendPath);

		const result = await branch.blenderBranchRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "body",
			render: false,
			timeoutSeconds: 300,
		});

		const after = await objectNames(ws.root, ws.blendPath);
		assert.deepEqual(after, before, "model.blend must not change during a branch run");
		assert.ok(existsSync(result.branchPath), "the branch blend should exist after a successful run");
		assert.equal(result.status, "staged");
		assert.ok(result.applyObjects.includes("Mug"), `expected Mug in the apply set, got ${JSON.stringify(result.applyObjects)}`);

		// And the branch itself really did have the change, or nothing above proves anything.
		const inBranch = await objectNames(ws.root, result.branchPath);
		assert.ok(inBranch.includes("Mug"), `the branch should contain Mug, got ${JSON.stringify(inBranch)}`);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("applying a branch brings its object into model.blend", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "body", ADD_CUBE);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "body", render: false, timeoutSeconds: 300 });

		const result = await branch.blenderBranchApply({
			cwd: ws.root,
			workspace: ws.workspacePath,
			modules: ["body"],
			timeoutSeconds: 300,
		});

		assert.deepEqual(result.skipped, [], `unexpected conflict: ${JSON.stringify(result.skipped)}`);
		assert.equal(result.applied.length, 1);
		assert.ok(result.applied[0].appended.includes("Mug"));
		const names = await objectNames(ws.root, ws.blendPath);
		assert.ok(names.includes("Mug"), `Mug should be in model.blend, got ${JSON.stringify(names)}`);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("two branches touching the same object are both reported and skipped", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "base", ADD_CUBE);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "base", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["base"], timeoutSeconds: 300 });

		// Both of these claim Mug, so both must be refused, and the refusal must
		// name the object. A silent single-winner here is the exact bug the rule
		// exists to prevent.
		writeScript(ws.workspacePath, "mover", MOVE_CUBE);
		writeScript(ws.workspacePath, "painter", `${MOVE_CUBE}\nbpy.data.materials.new("Clay")`);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "mover", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "painter", render: false, timeoutSeconds: 300 });

		const result = await branch.blenderBranchApply({
			cwd: ws.root,
			workspace: ws.workspacePath,
			modules: ["mover", "painter"],
			timeoutSeconds: 300,
		});

		assert.equal(result.applied.length, 0, "neither side of a contested object may apply");
		assert.equal(result.skipped.length, 2, "both sides must be reported, not just one");
		for (const skip of result.skipped) {
			assert.ok(
				skip.conflicts.some((conflict) => conflict.objectName === "Mug"),
				`${skip.module} should be blocked by Mug, got ${JSON.stringify(skip.conflicts)}`,
			);
		}
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a clean branch applies even while a sibling is contested", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "base", ADD_CUBE);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "base", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["base"], timeoutSeconds: 300 });

		writeScript(ws.workspacePath, "mover", MOVE_CUBE);
		writeScript(ws.workspacePath, "rival", MOVE_CUBE);
		writeScript(ws.workspacePath, "clean", `
import bpy
bpy.ops.mesh.primitive_uv_sphere_add()
bpy.context.object.name = "Lid"
`);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "mover", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "rival", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "clean", render: false, timeoutSeconds: 300 });

		const result = await branch.blenderBranchApply({
			cwd: ws.root,
			workspace: ws.workspacePath,
			modules: ["mover", "rival", "clean"],
			timeoutSeconds: 300,
		});

		assert.deepEqual(result.applied.map((entry) => entry.module), ["clean"]);
		assert.deepEqual(result.skipped.map((entry) => entry.module).sort(), ["mover", "rival"]);
		const names = await objectNames(ws.root, ws.blendPath);
		assert.ok(names.includes("Lid"), "the uncontested module's work must land");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a material-only change survives the apply", { skip }, async () => {
	// A paint module moves no object at all. If the apply tracked only objects,
	// this would apply cleanly and change nothing -- the worst outcome, because
	// it looks like it worked.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "base", ADD_CUBE);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "base", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["base"], timeoutSeconds: 300 });

		writeScript(ws.workspacePath, "glaze", `
import bpy
obj = bpy.data.objects.get("Mug")
material = bpy.data.materials.new("Glaze")
material.use_nodes = True
bsdf = material.node_tree.nodes.get("Principled BSDF")
bsdf.inputs["Base Color"].default_value = (0.1, 0.4, 0.8, 1.0)
obj.data.materials.append(material)
`);
		const run = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "glaze", render: false, timeoutSeconds: 300 });
		assert.ok(run.touchedMaterials.includes("Glaze"), `expected Glaze in touchedMaterials, got ${JSON.stringify(run.touchedMaterials)}`);

		const result = await branch.blenderBranchApply({
			cwd: ws.root,
			workspace: ws.workspacePath,
			modules: ["glaze"],
			timeoutSeconds: 300,
		});
		assert.equal(result.applied.length, 1, `skipped: ${JSON.stringify(result.skipped)}`);
		assert.ok(result.applied[0].appended.includes("Mug"), "the material's object comes across too");

		const materials = await materialNames(ws.root, ws.blendPath);
		assert.ok(materials.includes("Glaze"), `Glaze should be in model.blend, got ${JSON.stringify(materials)}`);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a removal is applied, not just an addition", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "base", `${ADD_CUBE}\nbpy.ops.mesh.primitive_uv_sphere_add()\nbpy.context.object.name = "Stray"`);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "base", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["base"], timeoutSeconds: 300 });
		assert.ok((await objectNames(ws.root, ws.blendPath)).includes("Stray"));

		writeScript(ws.workspacePath, "cleanup", `
import bpy
bpy.data.objects.remove(bpy.data.objects.get("Stray"), do_unlink=True)
`);
		const result = await branch.blenderBranchApply({
			cwd: ws.root,
			workspace: ws.workspacePath,
			modules: [],
			timeoutSeconds: 300,
		}).then(async () => {
			await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "cleanup", render: false, timeoutSeconds: 300 });
			return await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["cleanup"], timeoutSeconds: 300 });
		});

		assert.equal(result.applied.length, 1, `skipped: ${JSON.stringify(result.skipped)}`);
		assert.ok(result.applied[0].removed.includes("Stray"), "the removed object should be reported as removed");
		const names = await objectNames(ws.root, ws.blendPath);
		assert.ok(!names.includes("Stray"), `Stray should be gone, got ${JSON.stringify(names)}`);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("an apply is recorded as a module run, so revert can restore what it replaced", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "body", ADD_CUBE);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "body", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["body"], timeoutSeconds: 300 });

		const manifest = JSON.parse(readFileSync(join(ws.workspacePath, "blender-workspace.json"), "utf-8"));
		assert.equal(manifest.moduleRuns.length, 1, "the apply must leave a run record for revert to use");
		assert.equal(manifest.moduleRuns[0].name, "body");
		assert.ok(existsSync(manifest.moduleRuns[0].checkpointPath), "the recorded checkpoint must exist on disk");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("blender_module_run works with NO window, by branching and applying", { skip }, async () => {
	// The default state of a session: /blender no longer opens a window, so this
	// is the path a manager takes unless the user ran /blender-watch. Asserted
	// here rather than in a unit test because what has to hold is that the
	// object actually arrives in model.blend, which is a question about
	// Blender's append semantics and not about this codebase.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "body", ADD_CUBE);
		const before = await objectNames(ws.root, ws.blendPath);

		const result = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "body",
			render: true,
			timeoutSeconds: 300,
		});

		assert.equal(result.executionMode, "headless-apply", "with no window the run must report that it branched and applied");
		assert.equal(result.exitCode, 0);
		assert.notDeepEqual(await objectNames(ws.root, ws.blendPath), before, "the module's object never reached model.blend");
		assert.ok(result.renderOutputPath && existsSync(result.renderOutputPath), "the headless path must still produce the render a critic needs");

		// Revert has to work through the same record, because a headless run
		// wrote model.blend exactly as a live one did.
		const manifest = JSON.parse(readFileSync(join(ws.workspacePath, "blender-workspace.json"), "utf-8"));
		assert.equal(manifest.moduleRuns.length, 1, "a headless module run must leave one run record");
		assert.ok(manifest.moduleRuns[0].viaBranchApply, "the record must say it came from a branch apply, so a caller can tell the two paths apart");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a failed branch run leaves model.blend untouched and reports the traceback", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "broken", "raise RuntimeError('deliberate failure')");
		const before = await objectNames(ws.root, ws.blendPath);

		await assert.rejects(
			() => branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "broken", render: false, timeoutSeconds: 300 }),
			/deliberate failure/,
		);
		assert.deepEqual(await objectNames(ws.root, ws.blendPath), before, "a failed run must not change model.blend");
		assert.ok(!existsSync(join(ws.workspacePath, "modules", "broken", "branch.blend")), "a failed branch is removed");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});
