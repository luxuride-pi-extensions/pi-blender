import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { BLENDER_TOOLS } = await loadTs("../core/tools.ts");

function descriptions(value) {
	const text = JSON.stringify(value);
	return [...text.matchAll(/"description":"((?:[^"\\]|\\.)*)"/g)].map((match) =>
		JSON.parse(`"${match[1]}"`),
	);
}

function proseLength(tool) {
	return [tool.description ?? "", ...descriptions(tool.parameters)].reduce((sum, text) => sum + text.length, 0);
}

test("tool-schema prose stays inside the measured budget", () => {
	// 11,000 characters is under 4K tokens at the 3.6 chars/token estimate this
	// repository already uses. The full text lives in the skills, not here.
	const total = BLENDER_TOOLS.reduce((sum, tool) => sum + proseLength(tool), 0);
	assert.ok(
		total <= 11_000,
		`tool-schema prose is ${total} characters; the budget is 11000. Move rules into the skill instead of the schema.`,
	);
	for (const tool of BLENDER_TOOLS) {
		const length = proseLength(tool);
		assert.ok(length <= 700, `${tool.name} carries ${length} characters of schema prose; the per-tool cap is 700.`);
	}
});

test("every trimmed description points at the skill that carries its rules", async () => {
	for (const tool of BLENDER_TOOLS) {
		assert.match(tool.description ?? "", /Full rules: skill `blender-[a-z-]+`\./, tool.name);
		const skill = (tool.description ?? "").match(/skill `(blender-[a-z-]+)`/)?.[1];
		assert.ok(skill, tool.name);
		const text = await readFile(join(root, "blender/skills", skill, "SKILL.md"), "utf8");
		assert.match(text, new RegExp(`### ${tool.name}\\b`), `${tool.name} must have its rules in ${skill}`);
	}
});
