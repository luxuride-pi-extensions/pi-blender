import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manager = readFileSync(new URL("../blender/agents/blender-manager.md", import.meta.url), "utf8");

test("the manager is told a blocking preflight stops the run", () => {
	assert.match(manager, /If `preflight\.blocking` is true, the harness\s+marks the run `blocked`, skips the render and refuses to apply/);
	assert.match(manager, /send\s+the `blockers` and their measured values back to the worker/i);
});

test("the override is described and recorded", () => {
	assert.match(manager, /`forcePreflight: true` on the run and on `blender_branch_apply`/);
	assert.match(manager, /records the override in the manifest/);
});
