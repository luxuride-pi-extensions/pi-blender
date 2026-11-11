/**
 * The headless `changed` flag is derived from the same content fingerprint the
 * live bridge reports, not from the apply set.
 *
 * The end-to-end proof needs a Blender (branch-e2e.test.mjs), which CI does not
 * have. This file pins the invariant that the flag depends on: the branch script
 * takes the fingerprint diff BEFORE framing adds the camera and its target, and
 * the module runner does not infer change from applyObjects.length, which
 * includes that framing pair on every successful run.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const branchSource = readFileSync(fileURLToPath(new URL("../blender/branch.ts", import.meta.url)), "utf-8");
const moduleSource = readFileSync(fileURLToPath(new URL("../blender/module.ts", import.meta.url)), "utf-8");

test("the branch run takes its content diff before framing", () => {
	const changedAt = branchSource.indexOf("changed = content_changed(before, after)");
	assert.ok(changedAt >= 0, "the branch script must use the shared content fingerprint");
	const framingAt = branchSource.indexOf("camera_framing = _frame_module_camera(");
	assert.ok(framingAt >= 0, "the branch script should still frame the module camera");
	assert.ok(
		changedAt < framingAt,
		"changed must be computed before framing, or the auto-added camera counts as content",
	);
	assert.match(branchSource, /"changed": changed,/, "the branch payload must report changed");
});

test("the headless module run reads changed from the branch result", () => {
	assert.match(moduleSource, /changed:\s*branchResult\.changed/);
	assert.doesNotMatch(
		moduleSource,
		/changed:\s*[^\n]*applyObjects/,
		"applyObjects always contains the framing pair, so its length is not a change signal",
	);
});
