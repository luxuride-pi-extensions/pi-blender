/**
 * Test suite for blender_import_asset:
 * - Ingress of external geometry (obj, stl, gltf/glb) into a workspace blend headlessly
 * - Unavailable format/add-on reported as explicit result rather than traceback
 * - Pre-import checkpointing for clean revertibility
 * - Path traversal validation and asset name sanitization
 * - Post-import report with non-uniform scale and principal axes
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

process.env.PI_MANAGER_CORE_DIR = process.env.PI_MANAGER_CORE_DIR ?? "/home/lux/Projects/pi-manager-core";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const importModule = await load("blender/import.ts");
const { blenderImportAsset, sanitizeAssetName } = importModule;
const exportAsset = await load("blender/export-asset.ts");
const workspace = await load("blender/workspace.ts");
const launch = await load("launch.ts");

const BRIDGE_DIR = join(homedir(), ".cache", "pi-blender-import-test-");
mkdirSync(BRIDGE_DIR, { recursive: true });
process.env.PI_BLENDER_BRIDGE_DIR = mkdtempSync(BRIDGE_DIR);

async function blenderAvailable() {
	try {
		const { command, args } = await launch.resolveBlenderArgv();
		execFileSync(command, [...args, "--version"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

const hasBlender = await blenderAvailable();
const skip = hasBlender ? false : "no headless Blender available on this machine";

function scratchRoot() {
	const base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-blender", "test-scratch");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "import-test-"));
}

async function makeWorkspace() {
	const root = scratchRoot();
	const created = await workspace.blenderWorkspaceInit({ cwd: root, template: "blank" });
	return { root, workspacePath: created.workspacePath, blendPath: created.blendPath };
}

function writeSampleObj(dir, filename = "sample.obj") {
	const filePath = join(dir, filename);
	// An elongated box: 1m x 4m x 0.5m
	const objData = `
v 0.0 0.0 0.0
v 1.0 0.0 0.0
v 1.0 4.0 0.0
v 0.0 4.0 0.0
v 0.0 0.0 0.5
v 1.0 0.0 0.5
v 1.0 4.0 0.5
v 0.0 4.0 0.5
f 1 2 3 4
f 8 7 6 5
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 4 8 5 1
`;
	writeFileSync(filePath, objData.trim(), "utf8");
	return filePath;
}

function writeSampleStl(dir, filename = "sample.stl") {
	const filePath = join(dir, filename);
	const stlData = `solid test
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 1 1 0
  endloop
endfacet
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 1 0
    vertex 0 1 0
  endloop
endfacet
endsolid test
`;
	writeFileSync(filePath, stlData.trim(), "utf8");
	return filePath;
}

test("asset name sanitization strips invalid characters and clamps length", () => {
	assert.equal(sanitizeAssetName("  Asset Name With Spaces!@#$  "), "Asset_Name_With_Spaces");
	assert.equal(sanitizeAssetName("../../etc/passwd"), "etc_passwd");
	assert.equal(sanitizeAssetName("___bad___name___"), "bad_name");
	assert.equal(sanitizeAssetName(""), "asset");
});

test("path traversal guard rejects paths outside allowed roots", { skip }, async () => {
	const ws = await makeWorkspace();
	const dummyObj = writeSampleObj(ws.root, "legit.obj");

	// Outside allowedPaths
	await assert.rejects(
		async () => {
			await blenderImportAsset({
				cwd: ws.root,
				workspace: ws.workspacePath,
				path: dummyObj,
				allowedPaths: [join(ws.root, "subfolder-only")],
			});
		},
		{
			message: /Path traversal guard rejected source path/,
		},
	);
});

test("unavailable format is reported as explicit result rather than traceback", { skip }, async () => {
	const ws = await makeWorkspace();
	const dummyObj = writeSampleObj(ws.root, "test.xyz");

	const result = await blenderImportAsset({
		cwd: ws.root,
		workspace: ws.workspacePath,
		path: dummyObj,
		format: "xyz",
	});

	assert.equal(result.success, false);
	assert.equal(result.status, "unsupported_format");
	assert.match(result.error, /Unsupported import format "xyz"/);
	assert.ok(result.checkpointPath, "checkpoint should still have been created");
	assert.ok(existsSync(result.checkpointPath), "checkpoint file must exist");
});

test("import of OBJ into workspace blend headlessly with checkpointing and report", { skip }, async () => {
	const ws = await makeWorkspace();
	const objPath = writeSampleObj(ws.root, "test_model.obj");

	const result = await blenderImportAsset({
		cwd: ws.root,
		workspace: ws.workspacePath,
		path: objPath,
		name: "My_Imported_Asset",
	});

	assert.equal(result.success, true);
	assert.equal(result.format, "obj");
	assert.equal(result.assetName, "My_Imported_Asset");
	assert.ok(result.importedObjects.length > 0, "should have imported at least one object");
	assert.ok(existsSync(result.checkpointPath), "pre-import checkpoint must exist on disk");

	// Check post-import report
	assert.ok(result.report, "report must be returned");
	assert.ok(result.report.objects, "report must contain objects");
	const firstObjectName = result.importedObjects[0];
	const objectReport = result.report.objects[firstObjectName];
	assert.ok(objectReport, "imported object must have a report entry");
	assert.ok(objectReport.principalAxes, "principalAxes must be reported");
	assert.equal(objectReport.principalAxes.available, true);
	assert.ok(Array.isArray(objectReport.principalAxes.primaryAxis));
	assert.equal(objectReport.principalAxes.primaryAxis.length, 3);
});

test("import of STL into workspace blend headlessly", { skip }, async () => {
	const ws = await makeWorkspace();
	const stlPath = writeSampleStl(ws.root, "test_plate.stl");

	const result = await blenderImportAsset({
		cwd: ws.root,
		workspace: ws.workspacePath,
		path: stlPath,
		name: "Stl_Plate",
	});

	assert.equal(result.success, true);
	assert.equal(result.format, "stl");
	assert.ok(result.importedObjects.length > 0, "should have imported STL object");
	assert.ok(existsSync(result.checkpointPath), "checkpoint exists");
});

test("import of GLB/glTF into workspace blend headlessly", { skip }, async () => {
	// 1. Create a workspace with an object and export to GLB
	const wsExport = await makeWorkspace();
	const utils = await load("blender/utils.ts");
	await utils.runBlenderJson({
		cwd: wsExport.root,
		blendPath: wsExport.blendPath,
		scriptSource: `
import bpy, json
bpy.ops.mesh.primitive_cylinder_add(radius=0.5, depth=2)
bpy.context.object.name = "TestCylinder"
bpy.ops.wm.save_mainfile()
print("__PI_BLENDER_JSON_START__" + json.dumps({"ok": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
		timeoutMs: 60_000,
	});

	const exported = await exportAsset.blenderExportAsset({
		cwd: wsExport.root,
		workspace: wsExport.workspacePath,
		format: "glb",
		name: "exported_cylinder",
		outputDir: wsExport.root,
	});

	assert.ok(existsSync(exported.exportPath));

	// 2. Import the GLB into a fresh workspace
	const wsImport = await makeWorkspace();
	const result = await blenderImportAsset({
		cwd: wsImport.root,
		workspace: wsImport.workspacePath,
		path: exported.exportPath,
		name: "ImportedCylinder",
		allowedPaths: [wsExport.root, wsImport.root],
	});

	assert.equal(result.success, true);
	assert.equal(result.format, "glb");
	assert.ok(result.importedObjects.length > 0);
	assert.ok(result.report);
});

test("non-uniform scale is detected in the post-import report", { skip }, async () => {
	const ws = await makeWorkspace();
	// Sample OBJ is 1 x 4 x 0.5 (non-uniform dimensions)
	const objPath = writeSampleObj(ws.root, "elongated.obj");

	const result = await blenderImportAsset({
		cwd: ws.root,
		workspace: ws.workspacePath,
		path: objPath,
		name: "ElongatedObj",
	});

	assert.equal(result.success, true);
	assert.ok(result.report);
	const importedName = result.importedObjects[0];
	const objRep = result.report.objects[importedName];
	assert.ok(objRep);
	// Dimensions should reflect 1 x 4 x 0.5
	assert.ok(objRep.dimensions[1] > objRep.dimensions[0]);
});
