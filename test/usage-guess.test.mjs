import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

if (!process.env.PI_MANAGER_CORE_DIR && existsSync("/home/lux/Projects/pi-manager-core")) {
	process.env.PI_MANAGER_CORE_DIR = "/home/lux/Projects/pi-manager-core";
}

const BRIDGE_DIR = join(homedir(), ".cache", "pi-blender-nowindow-");
mkdirSync(BRIDGE_DIR, { recursive: true });
process.env.PI_BLENDER_BRIDGE_DIR = mkdtempSync(BRIDGE_DIR);

const launch = await load("launch.ts");
const workspace = await load("blender/workspace.ts");
const utils = await load("blender/utils.ts");
const usageGuessModule = await load("blender/usage-guess.ts");
const sceneInfoModule = await load("blender/scene-info.ts");

async function blenderAvailable() {
	try {
		const { command, args } = await launch.resolveBlenderArgv();
		execFileSync(command, [...args, "--version"], {
			encoding: "utf8",
			timeout: 60_000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return true;
	} catch {
		return false;
	}
}

const hasBlender = await blenderAvailable();

function scratchRoot() {
	const base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-blender", "test-scratch");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "usage-guess-"));
}

test("sourceBlend is documented with its rig/lighting consequences stated explicitly in index.ts", () => {
	const toolsSource = readFileSync(join(REPO, "core/tools.ts"), "utf-8");

	// blender_workspace_init tool description must mention discarding default studio template rig / lighting
	assert.match(
		toolsSource,
		/discards the default studio/i,
		"blender_workspace_init tool description must explicitly warn that adopting sourceBlend discards default studio rig",
	);

	// sourceBlend parameter description must explicitly state lighting / camera consequences
	assert.match(
		toolsSource,
		/StudioKey|StudioFill|StudioRim|studio lighting rig/i,
		"sourceBlend parameter description must state the rig/lighting consequences explicitly",
	);
});

test("empty signal set returns zeroed scores and empty signals rather than a default guess", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const blendPath = join(root, "blank.blend");

	// Create a truly blank blend with no objects, actions, or materials
	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json, sys
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
for col in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights, bpy.data.materials):
    for b in list(col):
        if b.users == 0:
            col.remove(b)
bpy.ops.wm.save_as_mainfile(filepath="${blendPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	const result = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		blendPath,
	});

	assert.equal(result.blendPath, blendPath);
	assert.equal(result.primaryGuess, null, "empty blend must have primaryGuess null");
	assert.deepEqual(result.allSignals, [], "empty blend must have no signals");

	for (const catName of ["animation", "rendering", "shading", "procedural", "modeling"]) {
		const cat = result.categories[catName];
		assert.ok(cat, `missing category ${catName}`);
		assert.equal(cat.score, 0, `empty blend category ${catName} must have score 0`);
		assert.equal(cat.certainty, 0, `empty blend category ${catName} must have certainty 0`);
		assert.deepEqual(cat.signals, [], `empty blend category ${catName} must have empty signals`);
	}
});

test("default cube check avoids false-positive modeling guess on untouched startup file", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const blendPath = join(root, "startup.blend");

	// Save factory startup file without edits
	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json
bpy.ops.wm.save_as_mainfile(filepath="${blendPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	const result = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		blendPath,
	});

	assert.equal(result.primaryGuess, null, "unmodified startup file should not produce a confident guess");
	assert.equal(result.categories.modeling.score, 0, "default cube alone must not yield positive modeling score");
	assert.equal(result.categories.modeling.certainty, 0, "default cube alone must yield certainty 0");
	assert.deepEqual(result.categories.modeling.signals, [], "default cube alone must have empty modeling signals");
});

test("usage_guess returns category score, certainty, and named contributing signals for animation", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const blendPath = join(root, "anim.blend");

	// Create blend with armature and action
	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json
arm = bpy.data.armatures.new("HeroRig")
obj = bpy.data.objects.new("HeroArmature", arm)
bpy.context.scene.collection.objects.link(obj)
act = bpy.data.actions.new("WalkCycle")
act.use_fake_user = True
anim = obj.animation_data_create()
anim.action = act
bpy.ops.wm.save_as_mainfile(filepath="${blendPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	const result = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		blendPath,
	});

	assert.equal(result.primaryGuess, "animation");
	assert.ok(result.categories.animation.score >= 70, `expected high animation score, got ${result.categories.animation.score}`);
	assert.ok(result.categories.animation.certainty >= 70, `expected high animation certainty, got ${result.categories.animation.certainty}`);
	assert.ok(result.categories.animation.signals.includes("actions"), "contributing signals must name actions");
	assert.ok(result.categories.animation.signals.includes("armatures"), "contributing signals must name armatures");
});

test("usage_guess returns category score, certainty, and named contributing signals for procedural", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const blendPath = join(root, "procedural.blend");

	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json
obj = bpy.data.objects.get("Cube")
if not obj:
    bpy.ops.mesh.primitive_cube_add()
    obj = bpy.context.object
mod = obj.modifiers.new("GeoNodes", "NODES")
bpy.ops.wm.save_as_mainfile(filepath="${blendPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	const result = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		blendPath,
	});

	assert.equal(result.primaryGuess, "procedural");
	assert.ok(result.categories.procedural.score >= 80, `expected high procedural score, got ${result.categories.procedural.score}`);
	assert.ok(result.categories.procedural.certainty >= 80, `expected high procedural certainty, got ${result.categories.procedural.certainty}`);
	assert.ok(
		result.categories.procedural.signals.includes("geometry_nodes_modifier"),
		"contributing signals must name geometry_nodes_modifier",
	);
});

test("usage_guess returns category score, certainty, and named contributing signals for shading", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const blendPath = join(root, "shading.blend");

	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json
mat = bpy.data.materials.new("CustomProceduralShader")
mat.use_fake_user = True
node_tree = getattr(mat, "node_tree", None)
if node_tree:
    node_tree.nodes.new("ShaderNodeTexNoise")
obj = bpy.data.objects.get("Cube")
if obj:
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)
bpy.ops.wm.save_as_mainfile(filepath="${blendPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	const result = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		blendPath,
	});

	assert.equal(result.primaryGuess, "shading");
	assert.ok(result.categories.shading.score >= 70, `expected shading score >= 70, got ${result.categories.shading.score}`);
	assert.ok(result.categories.shading.certainty >= 70, `expected shading certainty >= 70, got ${result.categories.shading.certainty}`);
	assert.ok(
		result.categories.shading.signals.includes("texture_nodes") || result.categories.shading.signals.includes("named_materials"),
		"contributing signals must name shading features",
	);
});

test("usage_guess returns category score, certainty, and named contributing signals for rendering", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const blendPath = join(root, "render.blend");

	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.render.filepath = "//renders/production_shot_###.png"
bpy.ops.wm.save_as_mainfile(filepath="${blendPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	const result = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		blendPath,
	});

	assert.equal(result.primaryGuess, "rendering");
	assert.ok(result.categories.rendering.score >= 80, `expected rendering score >= 80, got ${result.categories.rendering.score}`);
	assert.ok(result.categories.rendering.certainty >= 80, `expected rendering certainty >= 80, got ${result.categories.rendering.certainty}`);
	assert.ok(result.categories.rendering.signals.includes("cycles_render_engine"));
	assert.ok(result.categories.rendering.signals.includes("custom_output_path"));
});

test("usage_guess returns category score, certainty, and named contributing signals for custom modeling", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const blendPath = join(root, "modeling.blend");

	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json
# Add Suzanne monkey mesh
bpy.ops.mesh.primitive_monkey_add(size=2)
bpy.ops.wm.save_as_mainfile(filepath="${blendPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	const result = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		blendPath,
	});

	assert.ok(result.categories.modeling.score >= 70, `expected modeling score >= 70, got ${result.categories.modeling.score}`);
	assert.ok(result.categories.modeling.certainty >= 70, `expected modeling certainty >= 70, got ${result.categories.modeling.certainty}`);
	assert.ok(result.categories.modeling.signals.includes("custom_mesh_geometry"));
});

test("blender_scene_info includes usage_guess category when requested", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const ws = await workspace.blenderWorkspaceInit({
		cwd: root,
		template: "blank",
	});

	const info = await sceneInfoModule.blenderSceneInfo({
		cwd: root,
		workspace: ws.workspacePath,
		categories: ["usage_guess"],
	});

	assert.ok(info.usageGuess, "sceneInfoResult must include usageGuess when requested");
	assert.ok(info.usageGuess.categories.animation, "usageGuess must have animation category");
	assert.ok(info.usageGuess.categories.rendering, "usageGuess must have rendering category");
	assert.ok(info.usageGuess.categories.shading, "usageGuess must have shading category");
	assert.ok(info.usageGuess.categories.procedural, "usageGuess must have procedural category");
	assert.ok(info.usageGuess.categories.modeling, "usageGuess must have modeling category");
});

test("opening a source blend works from a clone with no live UI (headless path)", { skip: !hasBlender }, async () => {
	const root = scratchRoot();
	const sourcePath = join(root, "my-source-asset.blend");

	// Create source blend with a distinct mesh object and no camera/lights
	await utils.runBlenderJson({
		cwd: root,
		scriptSource: `
import bpy, json
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.mesh.primitive_cylinder_add(radius=1.5, depth=4.0)
bpy.context.object.name = "SourceCylinderAsset"
bpy.ops.wm.save_as_mainfile(filepath="${sourcePath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"saved": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
	});

	// Initialize workspace adopting sourceBlend
	const wsDir = join(root, "cloned-workspace");
	const initResult = await workspace.blenderWorkspaceInit({
		cwd: root,
		workspace: wsDir,
		sourceBlend: sourcePath,
	});

	// Headless assertions
	assert.equal(initResult.created, true, "workspace must report created: true");
	assert.equal(initResult.openedInLiveBlender, false, "headless run without UI must report openedInLiveBlender: false");
	assert.ok(existsSync(initResult.blendPath), "cloned model.blend must exist on disk");

	// Inspect the cloned workspace headlessly via scene_info
	const info = await sceneInfoModule.blenderSceneInfo({
		cwd: root,
		workspace: initResult.workspacePath,
		categories: ["objects", "lights", "cameras"],
	});

	const objectNames = info.objects.map((o) => o.name);
	assert.ok(objectNames.includes("SourceCylinderAsset"), "cloned workspace blend must contain source asset");

	// Studio collection and studio lights should NOT exist (proves adopting source scene wholesale discards studio rig)
	assert.ok(!objectNames.includes("StudioCamera"), "studio camera must not be added when sourceBlend is given");
	assert.ok(!objectNames.includes("StudioKey"), "studio key light must not be added when sourceBlend is given");
	assert.ok(!objectNames.includes("StudioFill"), "studio fill light must not be added when sourceBlend is given");
	assert.ok(!objectNames.includes("StudioRim"), "studio rim light must not be added when sourceBlend is given");
	assert.equal(info.lights.length, 0, "source blend had no lights and none should be injected");
	assert.equal(info.cameras.length, 0, "source blend had no cameras and none should be injected");

	// Verify usage_guess on the cloned workspace works headlessly
	const guess = await usageGuessModule.blenderUsageGuess({
		cwd: root,
		workspace: initResult.workspacePath,
	});
	assert.ok(guess.categories.modeling.score >= 70, "custom cylinder must be detected as custom modeling");
	assert.ok(guess.categories.modeling.signals.includes("custom_mesh_geometry"));
});
