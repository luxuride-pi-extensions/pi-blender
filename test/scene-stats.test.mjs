import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const utils = await load("blender/utils.ts");
const workspace = await load("blender/workspace.ts");
const sceneInfo = await load("blender/scene-info.ts");

function detectBlender() {
	const candidates = [
		["flatpak", "run", "org.blender.Blender"],
		["blender"],
	];
	for (const prefix of candidates) {
		const probe = spawnSync(prefix[0], [...prefix.slice(1), "--version"], {
			encoding: "utf8",
			timeout: 60_000,
		});
		if (!probe.error && probe.status === 0) return prefix;
	}
	return null;
}

const blender = detectBlender();
const roots = [];

after(() => {
	for (const root of roots) {
		try {
			rmSync(root, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}
});

function scratchRoot() {
	const base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-blender", "test-scratch");
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "scene-stats-"));
	roots.push(root);
	return root;
}

test("index.ts declares scene_stats as a blender_scene_info category without registering a new tool", () => {
	const indexSource = readFileSync(join(REPO, "index.ts"), "utf-8");

	// Acceptance criteria: No new top-level tool registered for scene stats
	assert.equal(
		indexSource.includes('name: "blender_scene_stats"'),
		false,
		"blender_scene_stats must NOT be registered as a new top-level tool",
	);

	// Acceptance criteria: scene_stats available as a blender_scene_info category
	assert.ok(
		indexSource.includes('Type.Literal("scene_stats")'),
		"index.ts must include Type.Literal('scene_stats') in categories schema",
	);

	// Acceptance criteria: Description states whether counts are objects or unique data-blocks, and mesh evaluation
	assert.ok(
		/unique data-blocks/i.test(indexSource),
		"index.ts tool description must state whether counts are objects or unique data-blocks",
	);
	assert.ok(
		/un-evaluated.*mesh/i.test(indexSource) || /base mesh/i.test(indexSource),
		"index.ts tool description must indicate which mesh evaluation polycount reflects",
	);
	assert.ok(
		/multi-scene/i.test(indexSource) && /total/i.test(indexSource),
		"index.ts tool description must document multi-scene breakdown and total",
	);
});

describe("blender_scene_info scene_stats against Blender", { skip: blender ? false : "no Blender found" }, () => {
	test("returns aggregate metrics without object detail for single-scene workspace", async () => {
		const root = scratchRoot();
		const created = await workspace.blenderWorkspaceInit({ cwd: root, template: "studio" });

		const result = await sceneInfo.blenderSceneInfo({
			cwd: root,
			workspace: created.workspacePath,
			categories: ["scene_stats"],
		});

		// Object-level detail is excluded when only scene_stats is requested
		assert.deepEqual(result.objects, []);
		assert.deepEqual(result.materials, []);
		assert.deepEqual(result.collections, []);
		assert.deepEqual(result.cameras, []);
		assert.deepEqual(result.lights, []);

		// scene_stats is populated
		const stats = result.scene_stats;
		assert.ok(stats, "scene_stats must be present in result");
		assert.equal(stats.meshEvaluation, "unevaluated");
		assert.ok(stats.description, "stats description must be present");
		assert.ok(stats.description.counts.includes("uniqueDataBlockCount"));
		assert.ok(stats.description.meshEvaluation.includes("un-evaluated"));

		// Per-scene stats
		assert.ok(Array.isArray(stats.scenes), "stats.scenes must be an array");
		assert.equal(stats.scenes.length, 1);
		const sc = stats.scenes[0];
		assert.ok(sc.name, "scene must have a name");
		assert.ok(typeof sc.objectCount === "number" && sc.objectCount > 0, "must report objectCount");
		assert.ok(typeof sc.instanceCount === "number", "must report instanceCount");
		assert.ok(typeof sc.uniqueDataBlockCount === "number", "must report uniqueDataBlockCount");
		assert.ok(typeof sc.polycount === "number", "must report polycount");
		assert.ok(typeof sc.vertices === "number", "must report vertices");
		assert.ok(sc.byType && typeof sc.byType === "object", "must report per-type breakdown");
		assert.equal(sc.meshEvaluation, "unevaluated");
		assert.ok(sc.renderSettings, "must report renderSettings per scene");
		assert.ok(sc.renderSettings.engine, "renderSettings must include engine");
		assert.ok(sc.renderSettings.resolutionX > 0, "renderSettings must include resolutionX");

		// Total stats labelled as a total
		const total = stats.total;
		assert.ok(total, "total must be present");
		assert.equal(total.isTotal, true, "total must be labelled as total with isTotal: true");
		assert.equal(total.name, "total", "total must have name 'total'");
		assert.equal(total.label, "total", "total must have label 'total'");
		assert.equal(total.objectCount, sc.objectCount);
		assert.equal(total.polycount, sc.polycount);
		assert.equal(total.vertices, sc.vertices);
	});

	test("multi-scene file reports per-scene breakdown, instance counts, and total labelled as total", async () => {
		const root = scratchRoot();
		const created = await workspace.blenderWorkspaceInit({ cwd: root, template: "blank" });

		// Configure blend with 2 scenes, linked duplicates, and differing render settings
		await utils.runBlenderJson({
			cwd: root,
			blendPath: created.blendPath,
			scriptSource: `
import bpy, json

# Scene 1: create a mesh cube and a camera
s1 = bpy.context.scene
s1.name = "SceneMain"
s1.render.resolution_x = 1920
s1.render.resolution_y = 1080

for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 0))
cube = bpy.context.object
cube.name = "MainCube"

# Create Scene 2
s2 = bpy.data.scenes.new("SceneSecondary")
s2.render.resolution_x = 1280
s2.render.resolution_y = 720

# Link a duplicate of cube to Scene 2 sharing the same mesh data (linked instance)
cube_dup = bpy.data.objects.new("LinkedCube", cube.data)
s2.collection.objects.link(cube_dup)

bpy.ops.wm.save_mainfile()
print("__PI_BLENDER_JSON_START__" + json.dumps({"ok": True}) + "__PI_BLENDER_JSON_END__")
`,
			payload: {},
			timeoutMs: 60_000,
		});

		const result = await sceneInfo.blenderSceneInfo({
			cwd: root,
			workspace: created.workspacePath,
			categories: ["scene_stats"],
		});

		const stats = result.scene_stats;
		assert.ok(stats, "scene_stats must be present");

		// Multi-scene breakdown
		assert.equal(stats.scenes.length, 2, "must report both scenes");
		const s1Stats = stats.scenes.find((s) => s.name === "SceneMain");
		const s2Stats = stats.scenes.find((s) => s.name === "SceneSecondary");
		assert.ok(s1Stats, "SceneMain must be present");
		assert.ok(s2Stats, "SceneSecondary must be present");

		// Verify per-scene metrics
		assert.equal(s1Stats.objectCount, 1);
		assert.equal(s1Stats.instanceCount, 0);
		assert.equal(s1Stats.uniqueDataBlockCount, 1);
		assert.equal(s1Stats.byType.MESH, 1);
		assert.equal(s1Stats.polycount, 6);
		assert.equal(s1Stats.vertices, 8);
		assert.equal(s1Stats.renderSettings.resolutionX, 1920);
		assert.equal(s1Stats.renderSettings.resolutionY, 1080);

		// Scene 2 has 1 object which shares cube.data (1 linked duplicate)
		assert.equal(s2Stats.objectCount, 1);
		assert.equal(s2Stats.byType.MESH, 1);
		assert.equal(s2Stats.polycount, 6);
		assert.equal(s2Stats.vertices, 8);
		assert.equal(s2Stats.renderSettings.resolutionX, 1280);
		assert.equal(s2Stats.renderSettings.resolutionY, 720);

		// Total verification
		const total = stats.total;
		assert.equal(total.isTotal, true, "total must have isTotal: true");
		assert.equal(total.name, "total", "total name must be 'total'");
		assert.equal(total.label, "total", "total label must be 'total'");
		assert.equal(total.sceneCount, 2, "total must reflect 2 scenes");
		assert.equal(total.objectCount, 2, "total object count across file must be 2");
		assert.equal(total.uniqueDataBlockCount, 1, "only 1 unique mesh data-block in the file");
		assert.equal(total.instanceCount, 1, "1 linked duplicate instance across the file");
		assert.equal(total.uniqueFaces, 6, "6 unique base mesh faces");
		assert.equal(total.uniqueVertices, 8, "8 unique base mesh vertices");
		assert.equal(total.polycount, 12, "12 total mesh faces across object instances");
		assert.equal(total.vertices, 16, "16 total mesh vertices across object instances");
	});
});
