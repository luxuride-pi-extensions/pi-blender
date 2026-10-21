import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const objectDetail = await load("blender/object-detail.ts");
const sceneInfo = await load("blender/scene-info.ts");
const workspace = await load("blender/workspace.ts");
const utils = await load("blender/utils.ts");
const launch = await load("launch.ts");

const indexSource = readFileSync(join(REPO, "index.ts"), "utf8");

test("blender_object_detail description states it reads the saved blend", () => {
	const toolStart = indexSource.indexOf('name: "blender_object_detail"');
	assert.notEqual(toolStart, -1, "blender_object_detail is not registered in index.ts");

	const descStart = indexSource.indexOf("description:", toolStart);
	const descEnd = indexSource.indexOf('",', descStart);
	const description = indexSource.slice(descStart, descEnd);

	assert.match(
		description,
		/saved\s+blend/i,
		"blender_object_detail description must state that it reads the saved blend",
	);
	assert.match(
		description,
		/headlessly/i,
		"blender_object_detail description must state that it reads headlessly",
	);
	assert.match(
		description,
		/matching\s+blender_scene_info/i,
		"blender_object_detail description must state it matches blender_scene_info",
	);
});

test("blender_scene_info declares object_detail category and targetObject parameter", () => {
	const toolStart = indexSource.indexOf('name: "blender_scene_info"');
	assert.notEqual(toolStart, -1, "blender_scene_info is not registered in index.ts");

	const categoriesStart = indexSource.indexOf('Type.Literal("object_detail")', toolStart);
	assert.notEqual(
		categoriesStart,
		-1,
		"blender_scene_info must include object_detail in its categories schema",
	);

	const targetObjStart = indexSource.indexOf("targetObject: Type.Optional(", toolStart);
	assert.notEqual(
		targetObjStart,
		-1,
		"blender_scene_info must include targetObject parameter",
	);
});

async function isBlenderAvailable() {
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

const hasBlender = await isBlenderAvailable();

describe("object detail inspection against real headless Blender", { skip: hasBlender ? false : "no Blender available" }, () => {
	function scratchRoot() {
		const base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-blender", "test-scratch");
		mkdirSync(base, { recursive: true });
		return mkdtempSync(join(base, "object-detail-"));
	}

	test("returns transform, non-uniform scale, modifiers, material slots, mesh counts, parenting, and orphan status", async () => {
		const root = scratchRoot();
		try {
			const ws = await workspace.blenderWorkspaceInit({ cwd: root, template: "studio" });

			// Populate a rich test scene in model.blend
			await utils.runBlenderJson({
				cwd: root,
				blendPath: ws.blendPath,
				scriptSource: `
import bpy, json

# Configure MainSubject cube
cube = bpy.data.objects.get("Cube")
if not cube:
    cube = bpy.data.objects.new("Cube", bpy.data.meshes.new("CubeMesh"))
    bpy.context.scene.collection.objects.link(cube)

cube.name = "MainSubject"
cube.location = (1.5, -2.0, 3.25)
cube.rotation_euler = (0.1, 0.2, 0.3)
cube.scale = (1.0, 2.5, 1.0) # Non-uniform scale

# Material slots
mat1 = bpy.data.materials.new("MatRed")
mat2 = bpy.data.materials.new("MatBlue")
cube.data.materials.append(mat1)
cube.data.materials.append(mat2)

# Modifiers
subsurf = cube.modifiers.new("SubsurfMod", "SUBSURF")
subsurf.levels = 2
subsurf.render_levels = 3
subsurf.show_viewport = False
subsurf.show_render = True

mirror = cube.modifiers.new("MirrorMod", "MIRROR")
mirror.show_viewport = True
mirror.show_render = True

# Child object
child = bpy.data.objects.new("ChildPart", bpy.data.meshes.new("ChildMesh"))
bpy.context.scene.collection.objects.link(child)
child.parent = cube

# An orphan object (exists in bpy.data.objects, not linked to scene collection)
orphan_mesh = bpy.data.meshes.new("OrphanMesh")
orphan_obj = bpy.data.objects.new("OrphanPart", orphan_mesh)
orphan_obj.use_fake_user = True

# Extra background objects to verify payload boundedness
for i in range(10):
    extra = bpy.data.objects.new(f"ExtraObj_{i}", bpy.data.meshes.new(f"ExtraMesh_{i}"))
    bpy.context.scene.collection.objects.link(extra)

bpy.ops.wm.save_mainfile()
print("__PI_BLENDER_JSON_START__" + json.dumps({"ok": True}) + "__PI_BLENDER_JSON_END__")
`,
				payload: {},
				timeoutMs: 60_000,
			});

			// 1. Inspect MainSubject
			const detail = await objectDetail.blenderObjectDetail({
				cwd: root,
				workspace: ws.workspacePath,
				objectName: "MainSubject",
			});

			assert.equal(detail.name, "MainSubject");
			assert.equal(detail.type, "MESH");
			assert.equal(detail.is_linked_to_scene, true);
			assert.equal(detail.is_orphan, false);

			// Transform & non-uniform scale
			assert.ok(detail.transform);
			assert.equal(detail.transform.is_non_uniform_scale, true);
			assert.equal(detail.is_non_uniform_scale, true);
			assert.ok(Math.abs(detail.transform.location[0] - 1.5) < 1e-4);
			assert.ok(Math.abs(detail.transform.location[1] - (-2.0)) < 1e-4);
			assert.ok(Math.abs(detail.transform.location[2] - 3.25) < 1e-4);
			assert.ok(Math.abs(detail.transform.scale[1] - 2.5) < 1e-4);

			// Modifiers
			assert.equal(detail.modifiers.length, 2);
			const sub = detail.modifiers.find((m) => m.name === "SubsurfMod");
			assert.ok(sub);
			assert.equal(sub.type, "SUBSURF");
			assert.equal(sub.show_viewport, false);
			assert.equal(sub.show_render, true);
			assert.equal(sub.is_viewport_disabled, true);
			assert.equal(sub.viewport_disabled, true);
			assert.equal(sub.settings.levels, 2);
			assert.equal(sub.settings.render_levels, 3);

			const mir = detail.modifiers.find((m) => m.name === "MirrorMod");
			assert.ok(mir);
			assert.equal(mir.type, "MIRROR");
			assert.equal(mir.show_viewport, true);
			assert.equal(mir.is_viewport_disabled, false);

			// Material slots
			assert.equal(detail.material_slots.length, 2);
			assert.equal(detail.material_slots[0].slot_index, 0);
			assert.equal(detail.material_slots[0].material_name, "MatRed");
			assert.equal(detail.material_slots[1].slot_index, 1);
			assert.equal(detail.material_slots[1].material_name, "MatBlue");
			assert.deepEqual(detail.materials, ["MatRed", "MatBlue"]);

			// Mesh counts
			assert.ok(detail.mesh);
			assert.equal(typeof detail.mesh.vertices, "number");
			assert.equal(typeof detail.mesh.edges, "number");
			assert.equal(typeof detail.mesh.polygons, "number");
			assert.equal(typeof detail.mesh.faces, "number");

			// Parenting
			assert.equal(detail.parent, null);
			assert.ok(detail.children.includes("ChildPart"));

			// 2. Inspect ChildPart
			const childDetail = await objectDetail.blenderObjectDetail({
				cwd: root,
				workspace: ws.workspacePath,
				objectName: "ChildPart",
			});
			assert.equal(childDetail.name, "ChildPart");
			assert.equal(childDetail.parent, "MainSubject");
			assert.equal(childDetail.parent_name, "MainSubject");
			assert.deepEqual(childDetail.children, []);

			// 3. Inspect OrphanPart (unlinked from scene)
			const orphanDetail = await objectDetail.blenderObjectDetail({
				cwd: root,
				workspace: ws.workspacePath,
				objectName: "OrphanPart",
			});
			assert.equal(orphanDetail.name, "OrphanPart");
			assert.equal(orphanDetail.is_linked_to_scene, false);
			assert.equal(orphanDetail.is_orphan, true);

			// 4. Verify payload does not scale with scene size
			const rawJson = JSON.stringify(detail);
			// Even with 10 extra objects in the scene, the single object detail payload is small
			assert.ok(rawJson.length < 5000, `payload for one object should be compact, was ${rawJson.length} bytes`);
			assert.equal(rawJson.includes("ExtraObj_"), false, "detail payload must not dump extraneous scene objects");

			// 5. Test integration with blender_scene_info category object_detail
			const sceneDetail = await sceneInfo.blenderSceneInfo({
				cwd: root,
				workspace: ws.workspacePath,
				categories: ["object_detail"],
				targetObject: "MainSubject",
			});
			assert.ok(sceneDetail.objectDetail);
			assert.equal(sceneDetail.objectDetail.name, "MainSubject");
			assert.equal(sceneDetail.objectDetail.modifiers[0].is_viewport_disabled, true);

			// 6. Non-existent object error
			await assert.rejects(
				() =>
					objectDetail.blenderObjectDetail({
						cwd: root,
						workspace: ws.workspacePath,
						objectName: "DoesNotExistXYZ",
					}),
				/Object 'DoesNotExistXYZ' not found/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
