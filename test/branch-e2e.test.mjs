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
const render = await loadTs(`${fileURLToPath(new URL("../blender/render.ts", import.meta.url))}`);
const compare = await loadTs(`${fileURLToPath(new URL("../blender/compare.ts", import.meta.url))}`);
const png = await loadTs(`${fileURLToPath(new URL("../blender/png.ts", import.meta.url))}`);

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

/**
 * An idempotent version of box(): the object is REMOVED before being rebuilt,
 * so running it twice leaves the same datablocks rather than accumulating
 * Arm.001. Needed by the digest test, whose whole point is that a re-run of an
 * unchanged script changes nothing — a script that quietly adds a second box
 * is not that.
 */
function replaceBox(name, sx, sy, sz, x = 0, y = 0, z = 0) {
	return `
import bpy
existing = bpy.data.objects.get("${name}")
if existing is not None:
    mesh = existing.data
    bpy.data.objects.remove(existing, do_unlink=True)
    if mesh.users == 0:
        bpy.data.meshes.remove(mesh)
${box(name, sx, sy, sz, x, y, z).replace(/^import bpy\n/, "")}`;
}

const ADD_BOX_AT = `
import bpy
bpy.ops.mesh.primitive_cube_add(size=1.0)
obj = bpy.context.object
obj.name = "{name}"
obj.scale = ({sx}, {sy}, {sz})
obj.location = ({x}, {y}, {z})
`;

/** A scaled, positioned box, as a module script. */
function box(name, sx, sy, sz, x = 0, y = 0, z = 0) {
	return ADD_BOX_AT.replace("{name}", name)
		.replace("{sx}", String(sx))
		.replace("{sy}", String(sy))
		.replace("{sz}", String(sz))
		.replace("{x}", String(x))
		.replace("{y}", String(y))
		.replace("{z}", String(z));
}

/**
 * A module that builds its own geometry AND its own camera, aimed at the
 * geometry rather than at the world origin. This is the shape the worker prompt
 * now requires, and it is the only way a per-module render is framed on the
 * part instead of on whatever `model.blend`'s shared camera happens to point at.
 */
const CUBE_WITH_OWN_CAMERA = `
import bpy
from mathutils import Vector
bpy.ops.mesh.primitive_cube_add()
obj = bpy.context.object
obj.name = "Mug"

min_corner = Vector((min(v.co[i] for v in obj.data.vertices) for i in range(3)))
max_corner = Vector((max(v.co[i] for v in obj.data.vertices) for i in range(3)))
for i in range(3):
    min_corner[i] += obj.location[i]
    max_corner[i] += obj.location[i]
center = (min_corner + max_corner) / 2.0
extent = max(max_corner[i] - min_corner[i] for i in range(3))

data = bpy.data.cameras.new("MugCam")
data.lens = 50.0
cam = bpy.data.objects.new("MugCam", data)
bpy.context.scene.collection.objects.link(cam)
distance = extent * 2.0
cam.location = center + Vector((distance, -distance, distance * 0.5))
cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
bpy.context.scene.camera = cam
`;

/** The camera a blend file would render from, by name. */
async function activeCameraName(cwd, blendPath) {
	const utils = await loadTs(fileURLToPath(new URL("../blender/utils.ts", import.meta.url)));
	return await utils.runBlenderJson({
		cwd,
		blendPath,
		scriptSource: `
import bpy, json, sys
json.loads(sys.argv[sys.argv.index("--") + 1])
print("__PI_BLENDER_JSON_START__")
print(json.dumps(bpy.context.scene.camera.name if bpy.context.scene.camera else None))
print("__PI_BLENDER_JSON_END__")
`,
		payload: {},
		timeoutMs: 120_000,
	});
}

/** A camera object's transform, its lens, and what its Track To constraint aims at. */
async function cameraReport(cwd, blendPath, name) {
	const utils = await loadTs(fileURLToPath(new URL("../blender/utils.ts", import.meta.url)));
	return await utils.runBlenderJson({
		cwd,
		blendPath,
		scriptSource: `
import bpy, json, sys
json.loads(sys.argv[sys.argv.index("--") + 1])
camera = bpy.data.objects.get(${JSON.stringify(name)})
if camera is None:
    print("__PI_BLENDER_JSON_START__")
    print(json.dumps(None))
    print("__PI_BLENDER_JSON_END__")
    raise SystemExit(0)
constraint = next((c for c in camera.constraints if c.type == "TRACK_TO"), None)
target = constraint.target if constraint is not None else None
print("__PI_BLENDER_JSON_START__")
print(json.dumps({
    "location": [camera.location.x, camera.location.y, camera.location.z],
    "lens": camera.data.lens,
    "target": [target.location.x, target.location.y, target.location.z] if target is not None else None,
    "distance": (camera.location - target.location).length if target is not None else None,
    "rotation": [camera.rotation_euler.x, camera.rotation_euler.y, camera.rotation_euler.z],
    "constraints": len(camera.constraints),
}))
print("__PI_BLENDER_JSON_END__")
`,
		payload: {},
		timeoutMs: 120_000,
	});
}

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

test("a multi-module apply merges the batch in one pass and skips only the branch that is gone", { skip }, async () => {
	// The batch is meant to be one Blender process and one save. The observable
	// half is that the two good modules both land and the missing one is the only
	// thing reported, with its record left unusable rather than half-applied.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "one", box("One", 1.0, 1.0, 1.0, 5, 0, 0));
		writeScript(ws.workspacePath, "two", box("Two", 1.0, 1.0, 1.0, 10, 0, 0));
		writeScript(ws.workspacePath, "gone", box("Gone", 1.0, 1.0, 1.0, 15, 0, 0));
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "one", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "two", render: false, timeoutSeconds: 300 });
		const gone = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "gone", render: false, timeoutSeconds: 300 });
		rmSync(gone.branchPath, { force: true });

		const result = await branch.blenderBranchApply({
			cwd: ws.root,
			workspace: ws.workspacePath,
			modules: ["one", "two", "gone"],
			timeoutSeconds: 300,
		});

		assert.deepEqual(result.applied.map((entry) => entry.module), ["one", "two"]);
		assert.deepEqual(result.missing, ["gone"], `skipped: ${JSON.stringify(result.skipped)}`);
		const names = await objectNames(ws.root, ws.blendPath);
		assert.ok(names.includes("One") && names.includes("Two"), `both good branches must land, got ${JSON.stringify(names)}`);
		assert.ok(!names.includes("Gone"), "a branch that is gone must not be half-applied");

		const manifest = JSON.parse(readFileSync(join(ws.workspacePath, "blender-workspace.json"), "utf-8"));
		const goneRecord = manifest.branchRuns.find((run) => run.module === "gone");
		assert.equal(goneRecord.status, "failed", "the missing branch's record must be retired, not left staged");
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

test("a revert refuses when another module in the same batch shares its checkpoint", { skip }, async () => {
	// One apply pass writes one save, so every module in it names the same
	// pre-batch checkpoint. Reverting one would restore the blend from before
	// all of them and silently drop the others' applied work.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "one", `import bpy\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.object.name = "One"\n`);
		writeScript(ws.workspacePath, "two", `import bpy\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.object.name = "Two"\n`);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "one", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "two", render: false, timeoutSeconds: 300 });
		await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["one", "two"], timeoutSeconds: 300 });
		await assert.rejects(
			() => module.blenderModuleRevert({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "two" }),
			/Refusing to revert module "two"/,
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("an in-process probe skip leaves the siblings applied and the branch untouched", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "one", `import bpy\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.object.name = "One"\n`);
		writeScript(ws.workspacePath, "ghost", `import bpy\nbpy.ops.mesh.primitive_cube_add()\nbpy.context.object.name = "GhostBox"\n`);
		await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "one", render: false, timeoutSeconds: 300 });
		const staged = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "ghost", render: false, timeoutSeconds: 300 });

		// Make the record claim a datablock its branch does not contain, which is
		// what a branch that lost an object looks like to the apply.
		const manifestPath = join(ws.workspacePath, "blender-workspace.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
		const record = manifest.branchRuns.find((run) => run.module === "ghost");
		record.applyObjects = [...record.applyObjects, "Ghost"];
		writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

		const result = await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["one", "ghost"], timeoutSeconds: 300 });
		assert.deepEqual(result.applied.map((run) => run.module), ["one"]);
		assert.deepEqual(result.skipped.map((run) => run.module), ["ghost"]);
		assert.deepEqual(result.skipped[0].conflicts.map((conflict) => conflict.objectName), ["Ghost"]);
		assert.ok(existsSync(staged.branchPath), "a skipped branch is left for the author to fix");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("the revert checkpoint describes the state the run started from", { skip }, async () => {
	// The checkpoint used to be taken AFTER the script, so a sibling's apply that
	// landed while this module was inside Blender ended up in it. Reverting this
	// module then silently kept the sibling's work, which is the one thing a
	// checkpoint exists to prevent.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "base", ADD_CUBE);
		await module.blenderModuleRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "base", render: false, timeoutSeconds: 300 });

		const marker = join(ws.workspacePath, "slow.started");
		const fastDone = join(ws.workspacePath, "fast.done");
		writeScript(
			ws.workspacePath,
			"slow",
			`
import bpy, os, time
bpy.data.objects["Mug"].location.x = 3.0
open(${JSON.stringify(marker)}, "w").write("started")
bpy.context.view_layer.update()
for _ in range(1200):
    if os.path.exists(${JSON.stringify(fastDone)}):
        break
    time.sleep(0.1)
else:
    raise RuntimeError("the fast module never completed")
`,
		);
		const beforeSlow = readFileSync(ws.blendPath);
		const slowPromise = branch.blenderBranchRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "slow",
			render: false,
			timeoutSeconds: 300,
		});

		const deadline = Date.now() + 60_000;
		while (!existsSync(marker)) {
			if (Date.now() > deadline) throw new Error("the slow branch never reached its script");
			await new Promise((resolve) => setTimeout(resolve, 50));
		}

		// Apply a sibling while the slow run is still polling inside its script.
		// The poll keeps the overlap causal rather than a race with a sleep: the
		// slow run cannot finish until this test has seen the fast apply return.
		writeScript(ws.workspacePath, "fast", box("Fast", 1.0, 1.0, 1.0, 0, 5, 0));
		await module.blenderModuleRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "fast", render: false, timeoutSeconds: 300 });
		writeFileSync(fastDone, "done");

		const slow = await slowPromise;
		assert.deepEqual(
			readFileSync(slow.checkpointPath),
			beforeSlow,
			"the checkpoint must be byte-identical to model.blend before the run started, not a later read",
		);
		const checkpointNames = await objectNames(ws.root, slow.checkpointPath);
		assert.ok(checkpointNames.includes("Mug"), "the checkpoint is model.blend before this run");
		assert.ok(
			!checkpointNames.includes("Fast"),
			"a sibling applied during the run must not appear in this run's checkpoint",
		);

		const modelNames = await objectNames(ws.root, ws.blendPath);
		assert.ok(modelNames.includes("Fast"), "the sibling's apply really did land while the slow run was in flight");
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

test("a branch render and a background render resolve the same engine", { skip }, async () => {
	// Both paths used to carry their own copy of the render script. The branch
	// renderer never chose an engine, so a branch image came from an unrecorded
	// one, and blender_render's preference list was silently dropped when the
	// assignment raised. They now share render_scene, so the resolved engine must
	// be identical for the same scene -- that equality is what says the copies
	// are gone. The explicit Cycles request pins the list-walking half.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "engine", ADD_CUBE);
		const staged = await branch.blenderBranchRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "engine",
			render: true,
			timeoutSeconds: 300,
		});
		assert.ok(staged.resolvedEngine, "a branch render must report the engine it used");

		const background = await render.blenderRender({
			cwd: ws.root,
			workspace: ws.workspacePath,
			renderMethod: "background",
			outputName: "engine.png",
		});
		assert.equal(
			background.resolvedEngine,
			staged.resolvedEngine,
			"the branch render and blender_render must not pick different engines",
		);

		// A build without Cycles cannot satisfy the request and says so; the
		// equality above still covers the shared code on that build.
		try {
			const cycles = await render.blenderRender({
				cwd: ws.root,
				workspace: ws.workspacePath,
				renderMethod: "background",
				renderEngine: "cycles",
				outputName: "cycles.png",
			});
			const branchCycles = await branch.blenderBranchRun({
				cwd: ws.root,
				workspace: ws.workspacePath,
				moduleName: "engine",
				render: true,
				renderEngine: "cycles",
				timeoutSeconds: 300,
			});
			assert.equal(cycles.resolvedEngine, "CYCLES", "a requested engine must be used, not dropped into the probe");
			assert.equal(
				branchCycles.resolvedEngine,
				cycles.resolvedEngine,
				"a module render must be able to request an engine too",
			);
		} catch (error) {
			if (!/No usable render engine/.test(String(error))) throw error;
		}
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a failed render keeps the saved branch and names the stage that failed", { skip }, async () => {
	// A render failure used to be indistinguishable from a failed run: the
	// caller saw renderOutputPath null. The branch is saved before the render, so
	// the build must survive and the reason must travel with it.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "broken-render", ADD_CUBE);
		const staged = await branch.blenderBranchRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "broken-render",
			render: true,
			view: "NoSuchCamera",
			timeoutSeconds: 300,
		});
		assert.equal(staged.exitCode, 0);
		assert.equal(staged.renderOutputPath, null);
		assert.match(String(staged.renderError), /Camera not found: NoSuchCamera/);
		assert.ok(existsSync(staged.branchPath), "the geometry was saved before the render failed");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a module's own camera survives the apply, and renders from it", { skip }, async () => {
	// The per-module review loop depends on two things holding at once: the
	// camera the worker authored travels into model.blend with its geometry, so
	// the user's window can be pointed at it, and a run naming that camera
	// renders from it instead of the shared studio camera. If the camera were
	// dropped by the apply it would simply not exist for anyone to point at, and
	// a render ignoring the name would silently fall back to the studio framing.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "mug", CUBE_WITH_OWN_CAMERA);

		const result = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "mug",
			render: true,
			view: "MugCam",
			timeoutSeconds: 300,
		});

		assert.equal(result.exitCode, 0);
		const names = await objectNames(ws.root, ws.blendPath);
		assert.ok(names.includes("Mug"), "the geometry must reach model.blend");
		assert.ok(names.includes("MugCam"), "the module's camera must reach model.blend too, or the window and the critic see different framings");

		const active = await activeCameraName(ws.root, ws.blendPath);
		assert.equal(active, "StudioCamera", "a module must not hijack the shared scene camera: the apply brings datablocks across, not the scene's pointers, and the studio camera is what a whole-build render wants");

		assert.ok(result.renderOutputPath && existsSync(result.renderOutputPath));
		const manifest = JSON.parse(readFileSync(join(ws.workspacePath, "blender-workspace.json"), "utf-8"));
		const recorded = manifest.renderOutputs.at(-1);
		assert.equal(recorded?.view, "MugCam", "the manifest must record which view produced the render, so a later critic is not handed the wrong one");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("the harness frames each module's own camera, with no camera in the brief", { skip }, async () => {
	// Framing is the part of a module's picture that no amount of modelling skill
	// fixes, and doing it in the worker meant a camera fitted to the shape the
	// part had LAST iteration. So the framing is solved here, from the objects the
	// run actually produced -- which is also why the run's render is taken from it
	// by default: a render from the origin-aimed studio camera is a verdict about
	// framing on a model that may be perfect.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "arm", box("Arm", 6.0, 0.2, 0.2, 3.0, 0, 1.0));
		// Deliberately NOT at the origin, and deliberately long and thin: a camera
		// fitted to the world origin, or fitted to the widest axis alone, frames
		// either of those wrongly.
		const result = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: true,
			timeoutSeconds: 300,
		});

		assert.equal(result.exitCode, 0);
		assert.equal(result.cameras?.length, 1, "a run that produced a mesh must report the framing it solved");

		const framing = result.cameras[0];
		assert.equal(framing.cameraName, "armCam", "the camera is named for the module, so a render can ask for it by name");
		assert.deepEqual(framing.subjects, ["Arm"], "the subject is the module's OWN objects: a camera framed on the whole build is the same defect as one framed on the origin");
		assert.ok(framing.extent[0] >= 5.9, `the measured extent must be the part's, not the camera's (got ${JSON.stringify(framing.extent)})`);

		// The numbers must agree with what is actually in the file, because a
		// framing report that describes a camera the apply did not carry is worse
		// than no report: it claims a picture that does not exist.
		const camera = await cameraReport(ws.root, ws.blendPath, "armCam");
		assert.ok(camera, "the camera must reach model.blend, or the window cannot be pointed at it");
		assert.equal(camera.constraints, 0, "the aim is baked into the camera rotation, so coverage is not read from a stale constraint");
		assert.ok(camera.rotation.some((value) => Math.abs(value) > 1e-4), "the camera has a real rotation");
		const distance = Math.hypot(
			camera.location[0] - framing.center[0],
			camera.location[1] - framing.center[1],
			camera.location[2] - framing.center[2],
		);
		assert.ok(
			Math.abs(distance - framing.distance) < 1e-4,
			`the camera's distance must be the solved distance (${distance} vs ${framing.distance})`,
		);
		// The eye must be OUTSIDE the part, at a distance the lens can actually
		// frame: too close and a 50mm lens is inside the geometry.
		assert.ok(distance > framing.extent.reduce((a, b) => Math.hypot(a, b), 0) / 2, "the eye must be outside the part's bounding sphere");

		// The default render must come from that camera, not the studio one.
		const manifest = JSON.parse(readFileSync(join(ws.workspacePath, "blender-workspace.json"), "utf-8"));
		assert.equal(
			manifest.renderOutputs.at(-1)?.view,
			"armCam",
			"with no view given, the render must use the module's own framed camera -- falling back to scene.camera is the origin-aimed studio camera",
		);
		assert.ok(result.renderOutputPath && existsSync(result.renderOutputPath));
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});


test("the declared front and the frame subject change what the camera sees", { skip }, async () => {
	// Two failures this catches, both invisible in a pure plan test: a +Y-facing
	// model must be photographed from +Y, and a detail parented to a body must be
	// framed on the detail rather than on the body the widened apply set carries.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "body", box("Body", 20, 20, 20));
		await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "body",
			render: false,
			timeoutSeconds: 300,
		});

		writeScript(
			ws.workspacePath,
			"detail",
			`
import bpy
bpy.ops.mesh.primitive_cube_add(size=1)
detail = bpy.context.object
detail.name = "Detail"
detail.parent = bpy.data.objects["Body"]
detail.matrix_world.translation = (8.0, 0.0, 0.0)
`,
		);
		const framed = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "detail",
			render: false,
			frameSubject: "module",
			frontAxis: "+Y",
			cameraProfile: "prop",
			timeoutSeconds: 300,
		});
		const framing = framed.cameras?.[0];
		assert.ok(framing, "the detail run must report its framing");
		assert.deepEqual(framing.subjects, ["Detail"], "frameSubject=module frames the detail, not its parent");
		assert.ok(framing.extent[0] < 2, `the detail is ~1 unit wide, not the body's 20 (got ${framing.extent[0]})`);
		assert.equal(framed.cameraPlan?.frontAxis, "+Y");
		assert.ok(framing.direction?.[1] > 0.5, `a +Y front puts the camera at +Y (got ${JSON.stringify(framing.direction)})`);
		assert.ok(framing.coverage, "coverage is reported");
		assert.ok(framing.coverage.minX >= 0.02 && framing.coverage.maxX <= 0.98, "the detail is inside the safe frame");
		assert.ok(framing.coverage.minY >= 0.02 && framing.coverage.maxY <= 0.98, "the detail is inside the safe frame vertically");
		const placed = await cameraReport(ws.root, ws.blendPath, framing.cameraName);
		assert.ok(placed, "the framed camera reached model.blend");
		assert.ok(
			placed.location[1] - framing.center[1] > 0,
			`a +Y front puts the camera at +Y in the file, not only in the report (${JSON.stringify(placed.location)} vs ${JSON.stringify(framing.center)})`,
		);
		assert.ok(
			Math.abs(placed.location[0] - framing.center[0]) < placed.location[1] - framing.center[1],
			"the front shot is not the old fixed three-quarter direction",
		);

		const widened = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "detail",
			render: false,
			frameSubject: "apply",
			frontAxis: "+Y",
			timeoutSeconds: 300,
		});
		const wideFraming = widened.cameras?.[0];
		assert.ok(wideFraming);
		assert.ok(wideFraming.subjects.includes("Body"), "the apply set carries the parent");
		assert.ok(wideFraming.extent[0] >= 19, `framing the apply set frames the body (got ${wideFraming.extent[0]})`);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a portrait frame fits a tall subject instead of cropping it", { skip }, async () => {
	// sensor_fit AUTO fits 36 mm to the LONGER frame dimension, so a portrait
	// render has a narrower horizontal view. Fitting with the landscape formula
	// would under-estimate the required distance and crop the width.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "portrait", box("TallPart", 2, 2, 6));
		const result = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "portrait",
			render: false,
			resolution: { x: 1080, y: 1920 },
			timeoutSeconds: 300,
		});
		const framing = result.cameras?.[0];
		assert.ok(framing, "the run framed a camera");
		assert.ok(framing.coverage, "coverage was measured against the portrait frame");
		assert.ok(framing.coverage.minX >= 0.02 && framing.coverage.maxX <= 0.98, `portrait width crops: ${JSON.stringify(framing.coverage)}`);
		assert.ok(framing.coverage.minY >= 0.02 && framing.coverage.maxY <= 0.98, `portrait height crops: ${JSON.stringify(framing.coverage)}`);
		assert.equal(framing.coverageOk, true);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a review sheet renders the plan's other angles in the same run", { skip }, async () => {
	// One 3/4 image cannot show a collapsed back or left/right asymmetry. The
	// sheet is composed inside the run process from panels rendered there, so it
	// costs renders but no second Blender start, and the hero image stays where
	// every earlier consumer expects it.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "sheet", box("SheetPart", 2, 2, 2) + box("SheetLug", 0.4, 0.4, 0.4, 1.1, 0, 0));
		const result = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "sheet",
			render: false,
			reviewSheet: true,
			cameraProfile: "character",
			timeoutSeconds: 300,
		});
		const sheet = result.reviewSheet;
		assert.ok(sheet, `reviewSheet: true returns the sheet it wrote: ${JSON.stringify(result)}`);
		assert.ok(result.renderOutputPath, "a sheet implies a hero render");
		assert.equal(sheet.panels.length, 4, "character has front, left, back and hero");
		assert.equal(sheet.panels[0].file, result.renderOutputPath, "the hero panel is the ordinary render");
		assert.ok(existsSync(sheet.path), `the sheet file exists: ${JSON.stringify(sheet)}`);
		for (const panel of sheet.panels) {
			assert.ok(existsSync(panel.file), `panel ${panel.name} exists at ${panel.file}`);
			assert.ok(panel.cameraName, `panel ${panel.name} records its camera`);
			assert.ok(panel.distance > 0 && panel.lensMm > 0, `panel ${panel.name} records framing`);
		}
		const sheetImage = png.decodePng(readFileSync(sheet.path));
		assert.equal(sheetImage.width, 1304);
		const tiles = result.reviewSheet.panels.map((panel) => {
			const image = png.decodePng(readFileSync(panel.file));
			let sum = 0;
			let sumSquares = 0;
			for (let index = 0; index < image.pixels.length; index += 4) {
				const luma = 0.2126 * image.pixels[index] + 0.7152 * image.pixels[index + 1] + 0.0722 * image.pixels[index + 2];
				sum += luma;
				sumSquares += luma * luma;
			}
			const count = image.pixels.length / 4;
			const mean = sum / count;
			return { name: panel.name, mean, deviation: Math.sqrt(sumSquares / count - mean * mean), bytes: readFileSync(panel.file) };
		});
		for (const tile of tiles) {
			assert.ok(tile.deviation > 2, `panel ${tile.name} is not a blank tile (deviation ${tile.deviation})`);
		}
		assert.equal(new Set(tiles.map((tile) => tile.bytes.toString("base64"))).size, tiles.length, "panels are distinct renders");
		assert.ok(sheet.width <= 1600 && sheet.height <= 1200, "the sheet stays inside the bounded size");
		assert.equal(sheet.width, 2 * 640 + 3 * 8);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("re-framing follows the part when it changes", { skip }, async () => {
	// A camera fitted once is the defect this replaced, so the test is that the
	// SECOND run moves it. Without this the feature is "creates a camera", which
	// is the behaviour it was meant to remove.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "arm", box("Arm", 2.0, 0.2, 0.2, 0, 0, 0));
		const first = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});

		writeScript(
			ws.workspacePath,
			"arm",
			`
import bpy
${box("Arm", 10.0, 0.4, 0.4, 8.0, 0, 0).replace(/^import bpy\n/, "")}
`,
		);
		const second = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});

		assert.equal(first.cameras?.[0].created, true, "the first run creates the camera");
		assert.equal(second.cameras?.[0].created, false, "the second run reuses it rather than making a second camera");
		assert.ok(
			second.cameras[0].distance > first.cameras[0].distance * 1.5,
			`a part five times bigger must pull the camera back (${first.cameras[0].distance} then ${second.cameras[0].distance})`,
		);
		assert.ok(
			Math.abs(second.cameras[0].center[0] - 8.0) < 0.2,
			`the aim must follow the part to where it now is (centre ${JSON.stringify(second.cameras[0].center)})`,
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("an unchanged iteration is reported as unchanged, without a render", { skip }, async () => {
	// The loop's own failure mode: re-brief, re-run, re-render, spawn a fresh
	// critic, and get the same verdict from the same picture. A digest of what
	// the run applied makes that decidable BEFORE the render is looked at, which
	// is the only point at which stopping saves anything.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "arm", replaceBox("Arm", 2.0, 0.2, 0.2, 0, 0, 0));
		const first = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});
		assert.ok(first.stateDigest, "every headless run reports the digest of what it applied");
		assert.equal(first.unchangedSinceLastRun, undefined, "the first run has nothing to be unchanged against");

		// The same script again: an idempotent rebuild writes the same bytes.
		const repeat = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});
		assert.equal(repeat.unchangedSinceLastRun, true, "re-running the same script must be reported as no change");
		assert.equal(repeat.comparedWithIteration, first.iteration);
		assert.ok(
			repeat.stateDigest && first.stateDigest && repeat.stateDigest === first.stateDigest,
			"unchanged must come from two real, equal digests — not from both sides being empty",
		);

		// Now change the geometry, which must move the digest.
		writeScript(ws.workspacePath, "arm", replaceBox("Arm", 9.0, 0.2, 0.2, 4.0, 0, 0));
		const changed = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});
		assert.equal(changed.unchangedSinceLastRun, false, "a real geometry change must not read as unchanged");
		assert.notEqual(changed.stateDigest, repeat.stateDigest);

		// A module's digest must not move because a SIBLING's geometry did, or
		// "unchanged" would report a false all-clear for every module in a
		// parallel build.
		writeScript(ws.workspacePath, "other", box("Other", 1.0, 1.0, 1.0, 20, 0, 0));
		await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "other",
			render: false,
			timeoutSeconds: 300,
		});
		const afterSibling = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});
		assert.equal(
			afterSibling.unchangedSinceLastRun,
			true,
			"another module's geometry must not change this module's digest",
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a run that changed nothing reports changed:false, even after framing", { skip }, async () => {
	// applyObjects carries the camera and its target that framing adds, so
	// "did anything get applied" is always true for a framing run. changed has
	// to answer "did the SCRIPT change content", which is the question the
	// unchangedSinceLastRun flag and the critic budget depend on.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "arm", replaceBox("Arm", 2.0, 0.2, 0.2, 0, 0, 0));
		const first = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});
		assert.equal(first.changed, true, "the first build changes content");
		assert.equal(first.cameras?.[0]?.cameraName, "armCam", "framing still happens and is reported");

		const repeat = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});
		assert.equal(repeat.changed, false, "re-running the same script changes no content");
		assert.equal(repeat.unchangedSinceLastRun, true, "and the digest must agree");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a material-only edit reports changed:true", { skip }, async () => {
	// A paint module moves no object, so an object-movement definition of
	// "changed" reports a real edit as nothing happened. It is the same content
	// fingerprint the live bridge reports; materials are in it.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "base", `
import bpy
bpy.ops.mesh.primitive_cube_add()
bpy.context.object.name = "Mug"
material = bpy.data.materials.new("Glaze")
material.use_nodes = True
# A zero-user material is dropped by the save, so the branch would not contain it.
bpy.context.object.data.materials.append(material)
`);
		await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "base",
			render: false,
			timeoutSeconds: 300,
		});

		writeScript(ws.workspacePath, "glaze", `
import bpy
material = bpy.data.materials["Glaze"]
bsdf = material.node_tree.nodes["Principled BSDF"]
bsdf.inputs["Base Color"].default_value = (0.1, 0.4, 0.8, 1.0)
`);
		const painted = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "glaze",
			render: false,
			timeoutSeconds: 300,
		});
		// Re-run the paint module untouched: its geometry set is empty, so the
		// digest can only survive if material ownership was carried forward.
		const repainted = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "glaze",
			render: false,
			timeoutSeconds: 300,
		});
		assert.ok(painted.stateDigest, "a material-only edit still has a subject");
		assert.equal(repainted.stateDigest, painted.stateDigest, "the carried material keeps the digest");
		assert.equal(repainted.unchangedSinceLastRun, true, "and the rebuild is recognised as unchanged");
		const manifest = await workspace.loadWorkspaceManifest(ws.root, ws.workspacePath);
		const record = (manifest.branchRuns ?? []).find((run) => run.module === "glaze");
		assert.deepEqual(record?.touchedObjects, [], "nothing in the scene graph moved");
		assert.deepEqual(record?.touchedMaterials, ["Glaze"], "the only change is the material's content");
		assert.equal(painted.changed, true, "a material-only edit is still a change");
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

test("a comparison renders the previous generation beside the current one, labelled", { skip }, async () => {
	// The failure this exists to catch is silent: render.png is overwritten every
	// run, so an iteration that breaks a part and one that fixes it produce the
	// same evidence. Only the baseline's panels are checked for content here --
	// what the sheet proves is that both generations were rendered from the same
	// camera, and that is a framing question answered by the reported placements.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "arm", replaceBox("Arm", 2.0, 0.2, 0.2, 0, 0, 0));
		await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});

		// The second run's checkpoint is the state the second run rendered, so
		// comparing against it is comparing iteration 1 against iteration 2.
		writeScript(ws.workspacePath, "arm", replaceBox("Arm", 9.0, 0.2, 0.2, 4.0, 0, 0));
		const second = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});

		const sheet = await compare.blenderCompare({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			views: ["front", "three-quarter"],
			panelResolution: { x: 320, y: 240 },
			timeoutMs: 600_000,
		});

		assert.ok(existsSync(sheet.montagePath), "the sheet is written");
		assert.equal(sheet.views.length, 2, "one panel per generation per view");
		assert.equal(sheet.panelPaths.length, 4, "two generations times two views");
		for (const path of sheet.panelPaths) {
			assert.ok(existsSync(path), `panel is written: ${path}`);
		}
		assert.ok(
			sheet.baseline.blendPath.includes("pre-"),
			`the baseline is a checkpoint, not the live blend: ${sheet.baseline.blendPath}`,
		);

		// The whole sheet rests on one camera. Both generations framed on their
		// own extent would make a part that grew read as a camera change, which
		// is the confusion the sheet exists to remove -- so the two panels of one
		// view have to carry the SAME camera, not merely similar ones. One
		// placement per view is shared by both generations, so there are as many
		// entries as views, not twice that.
		const placements = sheet.framing.views;
		assert.equal(placements.length, sheet.views.length, "one camera per view, shared by both generations");
		for (const panel of placements) {
			assert.ok(panel.location.length === 3, "a camera placement is a position");
		}
		assert.deepEqual(sheet.baseline.missingSubjects, [], "the baseline holds the subject it was compared against");

		// Labels name the iteration, because a sheet is read after the next run
		// has overwritten the evidence it was made from.
		assert.match(sheet.labels.baseline, /ITERATION \d+/, "the baseline is labelled with its iteration");
		assert.match(sheet.labels.current, /ITERATION \d+/, "the current generation is labelled with its iteration");
		assert.ok(
			sheet.labels.baseline !== sheet.labels.current,
			"the two generations must be distinguishable by label",
		);

		// The workspace blend is restored, so a comparison never replaces what
		// the artist is looking at.
		const stillOpen = await objectNames(ws.root, ws.blendPath);
		assert.ok(stillOpen.includes("Arm"), "model.blend still holds the current geometry after the comparison");
		assert.equal(second.iteration > 0, true);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a comparison refuses a baseline that predates the subject", { skip }, async () => {
	// A checkpoint from before a part existed renders an empty frame where the
	// part should be. Reporting that as missingSubjects is the difference between
	// a readable comparison and a bug report.
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "arm", replaceBox("Arm", 2.0, 0.2, 0.2, 0, 0, 0));
		const first = await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});

		// The checkpoint is the blend from BEFORE the run, so naming the subject
		// explicitly is what makes the baseline genuinely hold nothing: left to
		// the default it would frame every visible mesh in it, and the studio
		// rig's floor would answer the question instead of the part.
		const sheet = await compare.blenderCompare({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			baselineBlendPath: first.checkpointPath,
			subject: ["Arm"],
			views: ["front"],
			panelResolution: { x: 320, y: 240 },
			timeoutMs: 600_000,
		});
		assert.deepEqual(
			sheet.baseline.missingSubjects,
			["Arm"],
			"a subject the baseline does not hold is reported, not rendered as an absence",
		);
		assert.match(sheet.note, /missing/i, "the note says so in words too");
		assert.match(sheet.labels.baseline, /BEFORE/, "an explicitly named baseline has no honest iteration to print");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a comparison with only one run is refused rather than self-compared", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		writeScript(ws.workspacePath, "arm", replaceBox("Arm", 2.0, 0.2, 0.2, 0, 0, 0));
		await module.blenderModuleRun({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "arm",
			render: false,
			timeoutSeconds: 300,
		});

		await assert.rejects(
			() =>
				compare.blenderCompare({
					cwd: ws.root,
					workspace: ws.workspacePath,
					moduleName: "arm",
					views: ["front"],
				}),
			/no previous generation to compare against/i,
			"one run has nothing to regress from, and a self-comparison would read as proof of stability",
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("an unchanged rebuild reuses the picture instead of rendering it", { skip }, async () => {
	const ws = await makeWorkspace();
	writeScript(ws.workspacePath, "static", replaceBox("StaticPart", 2, 2, 2));
	const first = await module.blenderModuleRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "static", timeoutSeconds: 300 });
	assert.equal(first.changed, true);
	assert.equal(first.reused, false);
	const before = readFileSync(first.renderOutputPath);
	const second = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "static", timeoutSeconds: 300 });
	assert.equal(second.changed, false);
	assert.equal(second.reused, true);
	assert.equal(second.renderOutputPath, first.renderOutputPath);
	assert.deepEqual(readFileSync(second.renderOutputPath), before);
});

test("a modifier setting is content, not a type name", { skip }, async () => {
	const ws = await makeWorkspace();
	const source = (width) => `
import bpy
obj = bpy.data.objects.get("BevelPart")
if obj is None:
    bpy.ops.mesh.primitive_cube_add(size=2.0)
    obj = bpy.context.object
    obj.name = "BevelPart"
modifier = obj.modifiers.get("Bevel") or obj.modifiers.new("Bevel", "BEVEL")
modifier.width = ${width}
`;
	writeScript(ws.workspacePath, "bevel", source("0.1"));
	const first = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "bevel", timeoutSeconds: 300 });
	assert.equal(first.changed, true);
	await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["bevel"], timeoutSeconds: 300 });
	writeScript(ws.workspacePath, "bevel", source("0.1"));
	const repeat = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "bevel", timeoutSeconds: 300 });
	assert.equal(repeat.changed, false);
	writeScript(ws.workspacePath, "bevel", source("0.3"));
	const resized = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "bevel", timeoutSeconds: 300 });
	assert.equal(resized.changed, true);
});

test("a changed picture option forces a render even when the content did not change", { skip }, async () => {
	const ws = await makeWorkspace();
	writeScript(ws.workspacePath, "static", replaceBox("StaticPart", 2, 2, 2));
	const first = await module.blenderModuleRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "static", timeoutSeconds: 300 });
	const before = readFileSync(first.renderOutputPath);
	const second = await branch.blenderBranchRun({
		cwd: ws.root, workspace: ws.workspacePath, moduleName: "static",
		resolution: { x: 320, y: 240 }, timeoutSeconds: 300,
	});
	assert.equal(second.changed, false);
	assert.equal(second.reused, false);
	assert.notDeepEqual(readFileSync(second.renderOutputPath), before);
});

test("an unchanged branch is reported and not applied", { skip }, async () => {
	const ws = await makeWorkspace();
	writeScript(ws.workspacePath, "base", replaceBox("BasePart", 1, 1, 1));
	writeScript(ws.workspacePath, "extra", replaceBox("ExtraPart", 1, 1, 1, 3, 0, 0));
	await module.blenderModuleRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "base", timeoutSeconds: 300 });
	const extra = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "extra", timeoutSeconds: 300 });
	assert.equal(extra.changed, true);
	const again = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "base", timeoutSeconds: 300 });
	assert.equal(again.changed, false);
	const applied = await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["base", "extra"], timeoutSeconds: 300 });
	assert.deepEqual(applied.applied.map((entry) => entry.module), ["extra"]);
	assert.ok(applied.skipped.some((entry) => entry.module === "base" && entry.reason === "unchanged"));
	const manifest = JSON.parse(readFileSync(join(ws.workspacePath, "blender-workspace.json"), "utf8"));
	assert.equal(manifest.branchRuns.find((run) => run.module === "base" && run.sequence === again.sequence).status, "unchanged");
});

test("a painted image on an existing material reaches model.blend", { skip }, async () => {
	const ws = await makeWorkspace();
	const setup = (green) => `
import bpy
obj = bpy.data.objects.get("PaintBox")
if obj is None:
    bpy.ops.mesh.primitive_cube_add(size=1.0)
    obj = bpy.context.object
    obj.name = "PaintBox"
material = bpy.data.materials.get("ImgMat") or bpy.data.materials.new("ImgMat")
material.use_nodes = True
if not any(slot.material == material for slot in obj.material_slots):
    obj.data.materials.append(material)
image = bpy.data.images.get("PaintTex")
if image is None:
    image = bpy.data.images.new("PaintTex", width=4, height=4)
image.pixels[:] = [0.0, 1.0 if ${green ? "True" : "False"} else 0.0, 0.0, 1.0] * 16
image.pack()
tree = material.node_tree
node = tree.nodes.get("Tex")
if node is None:
    node = tree.nodes.new("ShaderNodeTexImage")
    node.name = "Tex"
node.image = image
bsdf = tree.nodes.get("Principled BSDF")
tree.links.new(node.outputs["Color"], bsdf.inputs["Base Color"])
`;
	writeScript(ws.workspacePath, "paint", setup(false));
	const first = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "paint", timeoutSeconds: 300 });
	assert.equal(first.changed, true);
	await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["paint"], timeoutSeconds: 300 });
	writeScript(ws.workspacePath, "paint", setup(true));
	const painted = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "paint", timeoutSeconds: 300 });
	assert.equal(painted.changed, true);
	await branch.blenderBranchApply({ cwd: ws.root, workspace: ws.workspacePath, modules: ["paint"], timeoutSeconds: 300 });
	writeScript(ws.workspacePath, "check", `
import bpy
image = bpy.data.images["PaintTex"]
green = image.pixels[1]
if green < 0.5:
    raise RuntimeError(f"model.blend kept the old pixels: green={green}")
`);
	const check = await branch.blenderBranchRun({ cwd: ws.root, workspace: ws.workspacePath, moduleName: "check", timeoutSeconds: 300 });
	assert.equal(check.changed, false);
});
