/**
 * Scene health: missing files, linked-library tree, and headless fallback.
 *
 * Verifies that blender_scene_info detects broken external references (per kind)
 * and direct/indirect linked-library hierarchies headlessly without an active UI window.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

// Set PI_MANAGER_CORE_DIR if not already configured and present in standard sibling path
if (!process.env.PI_MANAGER_CORE_DIR) {
	const candidates = [
		"/home/lux/Projects/pi-manager-core",
		join(homedir(), "Projects", "pi-manager-core"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			process.env.PI_MANAGER_CORE_DIR = candidate;
			break;
		}
	}
}

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const launch = await load("launch.ts");
const workspace = await load("blender/workspace.ts");
const sceneInfo = await load("blender/scene-info.ts");
const utils = await load("blender/utils.ts");

// Ensure no-window bridge dir so tests run against the headless fallback
const BRIDGE_DIR = join(homedir(), ".cache", "pi-blender-health-test-");
mkdirSync(BRIDGE_DIR, { recursive: true });
process.env.PI_BLENDER_BRIDGE_DIR = mkdtempSync(BRIDGE_DIR);

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
	return mkdtempSync(join(base, "health-"));
}

test("blender_scene_info schema documents content vs file-health split", () => {
	const toolsSource = readFileSync(join(REPO, "core/tools.ts"), "utf8");
	const start = toolsSource.indexOf('name: "blender_scene_info"');
	assert.notEqual(start, -1, "blender_scene_info is registered in index.ts");
	const block = toolsSource.slice(start, toolsSource.indexOf("pi.registerTool", start + 1));

	// Split between content and file-health stated in description
	assert.match(
		block,
		/scene content.*or file health|file-health/i,
		"description must document the split between scene content and file-health categories",
	);

	// Both missingFiles and linkedLibraries are declared in category union
	assert.match(block, /Type\.Literal\("missingFiles"\)/, "categories must include missingFiles");
	assert.match(block, /Type\.Literal\("linkedLibraries"\)/, "categories must include linkedLibraries");
});

describe("scene health inspections against headless Blender", { skip: hasBlender ? false : "no Blender available" }, () => {
	test("clean workspace reports zero missing files and empty linked libraries", async () => {
		const root = scratchRoot();
		const ws = await workspace.blenderWorkspaceInit({ cwd: root, template: "blank" });

		const result = await sceneInfo.blenderSceneInfo({
			cwd: root,
			workspace: ws.workspacePath,
			categories: ["missingFiles", "linkedLibraries"],
		});

		assert.ok(result.missingFiles, "missingFiles section must be present");
		assert.equal(result.missingFiles.totalCount, 0, "clean workspace should have 0 missing files");
		assert.deepEqual(result.missingFiles.images, []);
		assert.deepEqual(result.missingFiles.libraries, []);
		assert.deepEqual(result.missingFiles.fonts, []);
		assert.deepEqual(result.missingFiles.sounds, []);
		assert.deepEqual(result.missingFiles.movieClips, []);
		assert.deepEqual(result.missingFiles.caches, []);
		assert.deepEqual(result.missingFiles.sequences, []);

		assert.ok(result.linkedLibraries, "linkedLibraries section must be present");
		assert.equal(result.linkedLibraries.totalCount, 0);
		assert.deepEqual(result.linkedLibraries.tree, []);
		assert.deepEqual(result.linkedLibraries.list, []);
		assert.equal(result.linkedLibraries.hasIndirect, false);
	});

	test("missing external references reported per kind with offending paths", async () => {
		const root = scratchRoot();
		const ws = await workspace.blenderWorkspaceInit({ cwd: root, template: "blank" });

		const libPath = join(root, "temp_ext_dep.blend");

		// Step 1: Create the external library blend to link from
		await utils.runBlenderJson({
			cwd: root,
			scriptSource: `
import bpy, json
bpy.ops.wm.read_factory_settings(use_empty=True)
m = bpy.data.meshes.new("TempMesh")
m.use_fake_user = True
bpy.ops.wm.save_as_mainfile(filepath="${libPath}")
print("__PI_BLENDER_JSON_START__" + json.dumps({"ok": True}) + "__PI_BLENDER_JSON_END__")
`,
			payload: {},
			timeoutMs: 60_000,
		});

		// Step 2: Add all 7 kinds of missing external references to the workspace blend
		await utils.runBlenderJson({
			cwd: root,
			blendPath: ws.blendPath,
			scriptSource: `
import bpy, os, json

# 1. Image
img = bpy.data.images.new("broken_texture", 32, 32)
img.source = "FILE"
img.filepath = "//textures/missing_diffuse.png"
img.use_fake_user = True

# 2. External library
with bpy.data.libraries.load("${libPath}", link=True) as (df, dt):
    dt.meshes = ["TempMesh"]
mesh_ref = bpy.data.meshes.get("TempMesh")
if mesh_ref:
    obj = bpy.data.objects.new("BrokenRefObj", mesh_ref)
    bpy.context.collection.objects.link(obj)

# 3. Font (reassign path to nonexistent font)
try:
    font = bpy.data.fonts.load("/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf")
    font.name = "broken_font"
    font.filepath = "//fonts/missing_font.ttf"
    font.use_fake_user = True
except Exception:
    pass

# 4. Sound
snd = bpy.data.sounds.load("/tmp/missing_voiceover.wav", check_existing=False)
snd.use_fake_user = True

# 5. Movie clip (load temp file then delete to leave broken clip)
tmp_clip = os.path.join(os.path.dirname(bpy.data.filepath), "temp_clip.mp4")
with open(tmp_clip, "wb") as f:
    f.write(b"0000")
mc = bpy.data.movieclips.load(tmp_clip)
mc.name = "broken_movie_clip"
mc.use_fake_user = True
os.remove(tmp_clip)

# 6. Cache file
bpy.ops.cachefile.open(filepath="/tmp/missing_sim.abc")
if bpy.data.cache_files:
    bpy.data.cache_files[0].use_fake_user = True

# 7. Sequence strip
bpy.context.scene.sequence_editor_create()
se = bpy.context.scene.sequence_editor
se.strips.new_sound("broken_audio_strip", "//sequences/missing_soundtrack.wav", 1, 1)

bpy.ops.wm.save_mainfile()

print("__PI_BLENDER_JSON_START__" + json.dumps({"ready": True}) + "__PI_BLENDER_JSON_END__")
`,
			payload: {},
			timeoutMs: 120_000,
		});

		// Delete the external library so it is missing from disk
		if (existsSync(libPath)) {
			rmSync(libPath);
		}

		// Call blenderSceneInfo headlessly
		const result = await sceneInfo.blenderSceneInfo({
			cwd: root,
			workspace: ws.workspacePath,
			categories: ["missingFiles"],
		});

		assert.ok(result.missingFiles, "missingFiles must be returned");
		const mf = result.missingFiles;

		// 1. Images
		assert.ok(mf.images.length >= 1, "must report missing image");
		const imgEntry = mf.images.find((i) => i.name === "broken_texture" || i.filepath.includes("missing_diffuse.png"));
		assert.ok(imgEntry, "broken_texture must be listed in missing images");
		assert.match(imgEntry.filepath, /missing_diffuse\.png/);
		assert.ok(imgEntry.resolvedPath.endsWith("missing_diffuse.png"));
		assert.equal(imgEntry.path, imgEntry.resolvedPath);

		// 2. Libraries
		assert.ok(mf.libraries.length >= 1, "must report missing library");
		const libEntry = mf.libraries.find((l) => l.filepath.includes("temp_ext_dep.blend"));
		assert.ok(libEntry, "missing temp_ext_dep.blend library must be listed");
		assert.ok(libEntry.resolvedPath.endsWith("temp_ext_dep.blend"));

		// 3. Fonts
		assert.ok(mf.fonts.length >= 1, "must report missing font");
		const fontEntry = mf.fonts.find((f) => f.filepath.includes("missing_font.ttf"));
		assert.ok(fontEntry, "missing font must be listed");
		assert.ok(fontEntry.resolvedPath.endsWith("missing_font.ttf"));

		// 4. Sounds
		assert.ok(mf.sounds.length >= 1, "must report missing sound");
		const soundEntry = mf.sounds.find((s) => s.filepath.includes("missing_voiceover.wav"));
		assert.ok(soundEntry, "missing sound must be listed");
		assert.ok(soundEntry.resolvedPath.endsWith("missing_voiceover.wav"));

		// 5. Movie clips
		assert.ok(mf.movieClips.length >= 1, "must report missing movie clip");
		const clipEntry = mf.movieClips.find((c) => c.filepath.includes("temp_clip.mp4"));
		assert.ok(clipEntry, "missing clip must be listed");

		// 6. Caches
		assert.ok(mf.caches.length >= 1, "must report missing cache");
		const cacheEntry = mf.caches.find((c) => c.filepath.includes("missing_sim.abc"));
		assert.ok(cacheEntry, "missing cache must be listed");

		// 7. Sequences
		assert.ok(mf.sequences.length >= 1, "must report missing sequence strip");
		const seqEntry = mf.sequences.find((s) => s.filepath.includes("missing_soundtrack.wav"));
		assert.ok(seqEntry, "missing sequence strip must be listed");

		// Total count matches sum of kinds
		assert.ok(mf.totalCount >= 7, `totalCount should be at least 7, got ${mf.totalCount}`);
	});

	test("linked-library tree reports indirect links, not just direct", async () => {
		const root = scratchRoot();
		const ws = await workspace.blenderWorkspaceInit({ cwd: root, template: "blank" });

		const grandchildPath = join(root, "lib_grandchild.blend");
		const childPath = join(root, "lib_child.blend");

		// Build hierarchy: grandchild -> child -> main
		await utils.runBlenderJson({
			cwd: root,
			blendPath: ws.blendPath,
			scriptSource: `
import bpy, json

# Grandchild library: defines MeshGrandchild
bpy.ops.wm.read_factory_settings(use_empty=True)
mesh_gc = bpy.data.meshes.new("MeshGrandchild")
mesh_gc.use_fake_user = True
bpy.ops.wm.save_as_mainfile(filepath="${grandchildPath}")

# Child library: links MeshGrandchild and defines ObjectChild using it
bpy.ops.wm.read_factory_settings(use_empty=True)
with bpy.data.libraries.load("${grandchildPath}", link=True) as (df, dt):
    dt.meshes = ["MeshGrandchild"]
obj_child = bpy.data.objects.new("ObjectChild", bpy.data.meshes["MeshGrandchild"])
bpy.context.collection.objects.link(obj_child)
bpy.ops.wm.save_as_mainfile(filepath="${childPath}")

# Main workspace: links ObjectChild from child library
bpy.ops.wm.open_mainfile(filepath="${ws.blendPath}")
with bpy.data.libraries.load("${childPath}", link=True) as (df, dt):
    dt.objects = ["ObjectChild"]
bpy.context.collection.objects.link(bpy.data.objects["ObjectChild"])
bpy.ops.wm.save_mainfile()

print("__PI_BLENDER_JSON_START__" + json.dumps({"setup": True}) + "__PI_BLENDER_JSON_END__")
`,
			payload: {},
			timeoutMs: 120_000,
		});

		// Inspect linkedLibraries
		const result = await sceneInfo.blenderSceneInfo({
			cwd: root,
			workspace: ws.workspacePath,
			categories: ["linkedLibraries"],
		});

		assert.ok(result.linkedLibraries, "linkedLibraries must be returned");
		const libs = result.linkedLibraries;

		assert.equal(libs.hasIndirect, true, "hasIndirect must be true when indirect links exist");
		assert.equal(libs.totalCount, 2, "must find exactly 2 linked libraries (1 direct, 1 indirect)");

		// Check flat list
		assert.equal(libs.list.length, 2);
		const directInList = libs.list.find((l) => !l.isIndirect);
		const indirectInList = libs.list.find((l) => l.isIndirect);
		assert.ok(directInList, "flat list must contain direct library");
		assert.ok(indirectInList, "flat list must contain indirect library");
		assert.equal(indirectInList.parentName, directInList.name);

		// Check tree hierarchy
		assert.equal(libs.tree.length, 1, "tree root should only contain direct library");
		const rootNode = libs.tree[0];
		assert.equal(rootNode.isIndirect, false);
		assert.equal(rootNode.name, directInList.name);
		assert.equal(rootNode.children.length, 1, "direct library must have the indirect library as a child node");

		const childNode = rootNode.children[0];
		assert.equal(childNode.isIndirect, true, "child in tree must be indirect");
		assert.equal(childNode.name, indirectInList.name);
		assert.equal(childNode.parentName, rootNode.name);
	});
});
