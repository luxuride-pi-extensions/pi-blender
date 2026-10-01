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
		assert.ok(camera.target, "the aim is a Track To constraint on an empty, so re-framing cannot drift out of sync with the aim");
		assert.ok(
			Math.abs(camera.target[0] - framing.center[0]) < 1e-4 && Math.abs(camera.target[2] - framing.center[2]) < 1e-4,
			`the target must sit on the measured centre (target ${JSON.stringify(camera.target)} vs centre ${JSON.stringify(framing.center)})`,
		);
		assert.ok(
			Math.abs(camera.distance - framing.distance) < 1e-4,
			`the camera's distance must be the solved distance (${camera.distance} vs ${framing.distance})`,
		);
		// The eye must be OUTSIDE the part, at a distance the lens can actually
		// frame: too close and a 50mm lens is inside the geometry.
		assert.ok(camera.distance > framing.extent.reduce((a, b) => Math.hypot(a, b), 0) / 2, "the eye must be outside the part's bounding sphere");

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
