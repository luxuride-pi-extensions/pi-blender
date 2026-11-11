import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFileSync(join(root, rel), "utf-8");

/**
 * The registry is the runtime truth; README is the entry point and DESIGN is
 * the contract. They drifted to 33 / 23 / 24 because the count was prose, so
 * this test compares the actual tool names rather than a number.
 */

const registry = [...read("core/tools.ts").matchAll(/name: "(blender_[a-z_]+)"/g)].map((m) => m[1]).sort();

test("the README table lists exactly the registered tools", () => {
	const documented = [...read("README.md").matchAll(/^\| `(blender_[a-z_]+)`/gm)].map((m) => m[1]).sort();
	assert.deepEqual(documented, registry);
});

test("the DESIGN registry paragraph lists exactly the registered tools", () => {
	const design = read("docs/DESIGN.md");
	const paragraph = design.split("\n").find((line) => line.startsWith("- registers `blender_workspace_init`"));
	assert.ok(paragraph, "the DESIGN registry paragraph is missing");
	const documented = [...paragraph.matchAll(/`(blender_[a-z_]+)`/g)].map((m) => m[1]).sort();
	assert.deepEqual(documented, registry);
});

test("the mechanical iteration loop is byte-identical in every skill that runs it", () => {
	const canonical =
		"Loop rules (shared — keep byte-identical in every skill that runs the loop): run at most five critic iterations per module; the critic calls `blender_log_critique`; stop when the critic passes or the cap is reached. Before spending another run, call `blender_iteration_state`: an exhausted budget, two identical critiques, or an unchanged digest ends the loop. Present the result when the loop ends.";
	const skills = ["create", "edit", "paint", "modules", "with-reference"];
	for (const skill of skills) {
		const text = read(`blender/skills/blender-${skill}/SKILL.md`);
		assert.equal(text.split(canonical).length - 1, 1, `${skill} must carry the canonical loop exactly once`);
	}
});
