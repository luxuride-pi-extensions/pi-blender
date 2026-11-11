import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manager = readFileSync(new URL("../blender/agents/blender-manager.md", import.meta.url), "utf8");

test("the manager is told to route a blocking preflight to the worker", () => {
	assert.match(manager, /If `preflight\.blocking` is true, do not spawn\s+one/);
	assert.match(manager, /send the `blockers` and their measured values back to the worker/);
});

test("the render is kept so the worker can see what is wrong", () => {
	assert.match(manager, /The render still exists/);
});
