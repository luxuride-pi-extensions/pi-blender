// The wiring that gives a live run an ownership subject, and writes it back.
//
// A real live session needs Blender with the pi-blender add-on connected, so
// the accounting itself is tested in module-state.test.mjs and the persistence
// in module-manifest.test.mjs. What cannot be exercised here is the join
// between them: a live run that reads ownership from the manifest, sends it to
// the bridge, and stores what the bridge says it owns. Deleting any of those
// three steps would leave every other test green, so it is pinned directly.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const moduleSource = readFileSync(new URL("../blender/module.ts", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../blender/live-bridge.py", import.meta.url), "utf8");

test("a live run reads ownership from the manifest and sends both halves", () => {
	assert.match(moduleSource, /const ownership = collectModuleOwnership\(manifest, moduleName\)/);
	assert.match(moduleSource, /ownedObjects: ownership\.objects/);
	assert.match(moduleSource, /ownedMaterials: ownership\.materials/);
});

test("a live run persists the ownership and digest the bridge reported", () => {
	assert.match(
		moduleSource,
		/ownedObjects: result\.ownedObjects, ownedMaterials: result\.ownedMaterials, stateDigest/,
	);
	assert.match(bridgeSource, /owned_materials = owned_materials_after\(/);
	assert.match(bridgeSource, /"ownedMaterials": owned_materials/);
	assert.match(bridgeSource, /"stateDigest": compute_state_digest\(after, owned_objects, owned_materials\)/);
});

test("the bridge reports prior ownership alongside the changes it observed", () => {
	assert.match(bridgeSource, /request\.get\("ownedMaterials"\)/);
	assert.match(bridgeSource, /"ownedObjects": owned_objects/);
	assert.match(bridgeSource, /"touchedMaterials": delta\["touchedMaterials"\]/);
});
