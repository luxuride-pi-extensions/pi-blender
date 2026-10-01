// A tool parameter that the schema declares but the execute handler never reads
// is a parameter that does not exist. blender_geometry_probe shipped that way for
// a while: `specifications` was in the schema, documented in the tool description,
// and the whole scale contract it drives was unreachable from the tool. Nothing
// fails — the tool validates the argument, drops it, and returns a plausible
// result, which is the worst shape a bug can have.
//
// This reads index.ts as text rather than importing the extension, because the
// defect is a mismatch BETWEEN two parts of one file and there is nothing to call:
// no call can express "this key was dropped on the way down".

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const lines = readFileSync(new URL("../index.ts", import.meta.url), "utf8").split("\n");

/** Each pi.registerTool({ ... }) block, split out by brace depth. */
function toolBlocks() {
	const blocks = [];
	let cur = null;
	let depth = 0;
	for (let i = 0; i < lines.length; i++) {
		if (!cur && /name: "(blender[a-z_]*)"/.test(lines[i])) {
			cur = { name: RegExp.$1, lines: [] };
			depth = 0;
		}
		if (!cur) continue;
		cur.lines.push(lines[i]);
		depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
		if (depth <= 0 && /^\t\t\}\);/.test(lines[i])) {
			blocks.push(cur);
			cur = null;
		}
	}
	return blocks;
}

/**
 * Top-level keys of a tool's parameters schema. The one-tab offset from
 * `parameters:` is the schema body; anything deeper is a nested object's own
 * field, which is not a parameter of this tool.
 */
function schemaKeys(block) {
	const start = block.lines.findIndex((l) => /parameters: Type\.Object\(\{/.test(l));
	if (start < 0) return null;
	const keys = [];
	let depth = 1; // the `Type.Object({` we just matched
	for (let i = start + 1; i < block.lines.length; i++) {
		const line = block.lines[i];
		if (!line.trim()) continue;
		const key = line.match(/^\t{4}([a-zA-Z_][a-zA-Z0-9_.]*): Type\./);
		if (key) keys.push(key[1]);
		depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
		if (depth === 0) break;
	}
	return keys;
}

function executeBody(block) {
	const start = block.lines.findIndex((l) => /execute: async/.test(l));
	return start < 0 ? "" : block.lines.slice(start).join("\n");
}

test("every schema key reaches its execute handler", () => {
	const blocks = toolBlocks().filter((b) => schemaKeys(b) !== null);
	assert.ok(blocks.length >= 20, `expected the tool roster, found ${blocks.length} blocks`);

	for (const block of blocks) {
		const body = executeBody(block);
		const missing = schemaKeys(block).filter(
			(key) =>
				!new RegExp(`params\\.${key.replace(/\./g, "\\.")}\\b`).test(body) &&
				!new RegExp(`\\n\\t+${key},`).test(body),
		);
		assert.deepEqual(missing, [], `${block.name} never reads: ${missing.join(", ")}`);
	}
});

test("no schema declares the same key twice", () => {
	for (const block of toolBlocks()) {
		const keys = schemaKeys(block);
		if (keys === null) continue;
		const dupes = [...new Set(keys.filter((key, i) => keys.indexOf(key) !== i))];
		assert.deepEqual(dupes, [], `${block.name} declares twice: ${dupes.join(", ")}`);
	}
});

test("the schema parser is not vacuous", () => {
	// A regex that stops at the wrong depth silently reports zero keys, and a
	// checker that checks nothing always passes. Pin a known key of a known tool.
	const render = toolBlocks().find((b) => b.name === "blender_render");
	assert.deepEqual(schemaKeys(render), [
		"workspace",
		"view",
		"resolution",
		"samples",
		"outputName",
		"renderMethod",
		"viewSource",
		"viewportShading",
		"renderEngine",
	]);
});
