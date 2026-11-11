// The post-run accounting both execution paths share. These run the real Python
// module with fake snapshots and a fake bpy, so a divergence between what the
// branch runner and the live bridge report fails here without Blender.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const moduleDir = fileURLToPath(new URL("../blender", import.meta.url));
const python = spawnSync("python3", ["--version"], { encoding: "utf-8" });
const skip = python.error ? "python3 is required to exercise blender/module_state.py" : false;

function runPython(source) {
	const result = spawnSync("python3", ["-c", source], {
		cwd: moduleDir,
		encoding: "utf-8",
	});
	assert.equal(result.status, 0, `python exited ${result.status}: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

test("a material-only edit is a touch of that material and no object", { skip }, () => {
	const outcome = runPython(`
import json
import module_state
from fingerprint import content_changed

before = {"objects": {"Mug": "a"}, "materials": {"Glaze": "x"}}
after = {"objects": {"Mug": "a"}, "materials": {"Glaze": "y"}}
print(json.dumps({
    "delta": module_state.diff_snapshots(before, after),
    "changed": content_changed(before, after),
}))
`);

	assert.deepEqual(outcome.delta, {
		touchedObjects: [],
		touchedMaterials: ["Glaze"],
		addedObjects: [],
		removedObjects: [],
	});
	assert.equal(outcome.changed, true, "a paint module changed the file even though no object moved");
});

test("the apply set is widened to ancestors and children, and removals keep their meaning", { skip }, () => {
	const outcome = runPython(`
import json
import module_state

class Obj:
    def __init__(self, name, parent=None, children=()):
        self.name = name
        self.parent = parent
        self.children_recursive = list(children)

parent = Obj("Handle")
child = Obj("Grip", parent=parent, children=())
parent.children_recursive = [child]
other = Obj("Other")

class Objects:
    values = {"Grip": child, "Handle": parent, "Other": other}

    def get(self, name):
        return self.values.get(name)

class Data:
    objects = Objects()

class Bpy:
    data = Data()

apply_objects, removed = module_state.widen_apply_objects(
    Bpy(), ["Grip"], ["Gone"],
)
print(json.dumps({"apply": apply_objects, "removed": removed}))
`);

	assert.deepEqual(outcome.apply, ["Grip", "Handle"], "a parent travels with the part it holds");
	assert.deepEqual(outcome.removed, ["Gone"], "an unrelated deletion is still reported as a removal");
});

test("ownership carries forward so an idempotent rebuild keeps a digest subject", { skip }, () => {
	const outcome = runPython(`
import json
import module_state

print(json.dumps({
    "rebuilt": module_state.owned_after(["Mug"], [], []),
    "grown": module_state.owned_after(["Mug"], ["Arm"], []),
    "shrunk": module_state.owned_after(["Mug", "Arm"], [], ["Arm"]),
}))
`);

	assert.deepEqual(outcome.rebuilt, ["Mug"]);
	assert.deepEqual(outcome.grown, ["Arm", "Mug"]);
	assert.deepEqual(outcome.shrunk, ["Mug"]);
});

test("an empty subject has no digest instead of the digest of an empty string", { skip }, () => {
	const outcome = runPython(`
import json
import module_state

after = {"objects": {"Mug": "hash", "MugCam": "camera", "MugCamTarget": "target"}, "materials": {}}
print(json.dumps({
    "empty": module_state.state_digest(after, [], []),
    "framing_only": module_state.state_digest(after, ["MugCam", "MugCamTarget"], []),
    "with_subject": module_state.state_digest(after, ["Mug", "MugCam", "MugCamTarget"], []),
}))
`);

	assert.equal(outcome.empty, null);
	assert.equal(outcome.framing_only, null, "the framing pair is harness bookkeeping, not a digest subject");
	assert.match(outcome.with_subject, /^[0-9a-f]{64}$/);
});

test("the digest moves with content and stays put for the same content", { skip }, () => {
	const outcome = runPython(`
import json
import module_state

same = {"objects": {"Mug": "hash"}, "materials": {"Glaze": "gloss"}}
moved = {"objects": {"Mug": "other"}, "materials": {"Glaze": "gloss"}}
print(json.dumps({
    "first": module_state.state_digest(same, ["Mug"], ["Glaze"]),
    "same": module_state.state_digest(same, ["Mug"], ["Glaze"]),
    "moved": module_state.state_digest(moved, ["Mug"], ["Glaze"]),
}))
`);

	assert.equal(outcome.first, outcome.same);
	assert.notEqual(outcome.first, outcome.moved);
});
