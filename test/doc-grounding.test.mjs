import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { loadTs } from "./paths.mjs";

const {
	blenderGetPythonApiDocs,
	blenderSearchApiDocs,
	blenderSearchManualDocs,
} = await loadTs("../blender/doc-grounding.ts");

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(TEST_DIR, "..");
const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const docGroundingSource = readFileSync(new URL("../blender/doc-grounding.ts", import.meta.url), "utf8");

function toolBlock(name) {
	const start = indexSource.indexOf(`name: "${name}"`);
	assert.notEqual(start, -1, `${name} is not registered in index.ts`);
	const from = indexSource.lastIndexOf("pi.registerTool({", start);
	assert.notEqual(from, -1, `${name} has no registerTool boundary`);
	const end = indexSource.indexOf("});", start);
	assert.notEqual(end, -1, `${name} registration does not close`);
	return indexSource.slice(from, end + 3);
}

function toolDescription(name) {
	const block = toolBlock(name);
	const from = block.indexOf("description:");
	assert.notEqual(from, -1, `${name} has no description`);
	const end = block.indexOf('",', from);
	assert.notEqual(end, -1, `${name}'s description never closes`);
	return block.slice(from, end);
}

// ----------------------------------------------------------------------------
// Tool Registration Invariants
// ----------------------------------------------------------------------------

test("all three doc-grounding tools are registered in index.ts and added to LAZY_BLENDER_TOOL_NAMES", () => {
	const tools = [
		"blender_get_python_api_docs",
		"blender_search_api_docs",
		"blender_search_manual_docs",
	];

	for (const tool of tools) {
		const block = toolBlock(tool);
		assert.match(
			block,
			/defaultActive:\s*false/,
			`${tool} must be registered inert (defaultActive: false)`,
		);

		// Assert tool is in LAZY_BLENDER_TOOL_NAMES array in index.ts
		const lazyArrayMatch = indexSource.match(/const LAZY_BLENDER_TOOL_NAMES = \[([\s\S]*?)\];/);
		assert.ok(lazyArrayMatch, "LAZY_BLENDER_TOOL_NAMES array must exist in index.ts");
		assert.match(
			lazyArrayMatch[1],
			new RegExp(`"${tool}"`),
			`${tool} must be present in LAZY_BLENDER_TOOL_NAMES`,
		);
	}
});

test("all three doc-grounding tool descriptions state Blender 4.2 LTS", () => {
	const tools = [
		"blender_get_python_api_docs",
		"blender_search_api_docs",
		"blender_search_manual_docs",
	];

	for (const tool of tools) {
		const desc = toolDescription(tool);
		assert.match(
			desc,
			/Blender 4\.2 LTS/,
			`${tool}'s description must state the Blender version the corpus was generated from (Blender 4.2 LTS)`,
		);
	}
});

// ----------------------------------------------------------------------------
// blender_get_python_api_docs
// ----------------------------------------------------------------------------

test("blender_get_python_api_docs returns real operator signature and parameter documentation", async () => {
	const result = await blenderGetPythonApiDocs({
		identifier: "bpy.ops.mesh.primitive_uv_sphere_add",
	});

	assert.equal(result.found, true);
	assert.equal(result.identifier, "bpy.ops.mesh.primitive_uv_sphere_add");
	assert.equal(result.kind, "operator");
	assert.ok(result.signature, "signature must be non-empty");
	assert.match(result.signature, /primitive_uv_sphere_add/);
	assert.match(result.signature, /segments=32/);
	assert.match(result.signature, /ring_count=16/);
	assert.match(result.signature, /radius=1\.0/);

	// Parameter list parsed
	assert.ok(Array.isArray(result.parameters), "parameters must be an array");
	assert.ok(result.parameters.length > 0, "parameters must not be empty");
	const segmentsParam = result.parameters.find((p) => p.name === "segments");
	assert.ok(segmentsParam, "segments parameter should be documented");
	assert.equal(segmentsParam.default, "32");
});

test("blender_get_python_api_docs returns type documentation for bpy.types", async () => {
	const modResult = await blenderGetPythonApiDocs({
		identifier: "bpy.types.Modifier",
	});
	assert.equal(modResult.found, true);
	assert.equal(modResult.kind, "type");
	assert.match(modResult.doc, /Base class for all modifier operations/);
	assert.match(modResult.doc, /show_viewport/);

	const subsurfResult = await blenderGetPythonApiDocs({
		identifier: "bpy.types.SubsurfModifier",
	});
	assert.equal(subsurfResult.found, true);
	assert.equal(subsurfResult.kind, "type");
	assert.match(subsurfResult.doc, /levels/);
	assert.match(subsurfResult.doc, /render_levels/);
});

test("blender_get_python_api_docs supports wildcard lookup", async () => {
	const result = await blenderGetPythonApiDocs({
		identifier: "bpy.ops.mesh.*",
	});

	assert.equal(result.found, true);
	assert.equal(result.kind, "wildcard");
	assert.ok(result.count > 5, "should return multiple mesh operators");
	assert.ok(Array.isArray(result.matches), "matches must be an array");

	const identifiers = result.matches.map((m) => m.identifier);
	assert.ok(identifiers.includes("bpy.ops.mesh.primitive_cube_add"));
	assert.ok(identifiers.includes("bpy.ops.mesh.primitive_uv_sphere_add"));
	assert.ok(identifiers.includes("bpy.ops.mesh.subdivide"));
});

test("blender_get_python_api_docs handles unknown identifier cleanly without throwing", async () => {
	const result = await blenderGetPythonApiDocs({
		identifier: "bpy.ops.nonexistent_bogus_operator_12345",
	});

	assert.equal(result.found, false);
	assert.equal(result.signature, null);
	assert.equal(result.doc, null);
	assert.ok(result.message, "should return informative message");
	assert.match(result.message, /No API documentation found/);
});

// ----------------------------------------------------------------------------
// blender_search_api_docs
// ----------------------------------------------------------------------------

test("blender_search_api_docs returns matching operator signatures and snippets", async () => {
	const result = await blenderSearchApiDocs({
		query: "primitive_uv_sphere_add",
	});

	assert.ok(result.totalMatches > 0, "should find matches for primitive_uv_sphere_add");
	const top = result.matches[0];
	assert.equal(top.identifier, "bpy.ops.mesh.primitive_uv_sphere_add");
	assert.match(top.signature, /segments=32/);
	assert.ok(top.snippet && top.snippet.length > 0, "snippet should be populated");
});

test("blender_search_api_docs returns matching type results", async () => {
	const result = await blenderSearchApiDocs({
		query: "SubsurfModifier",
	});

	assert.ok(result.totalMatches > 0);
	const match = result.matches.find((m) => m.identifier === "bpy.types.SubsurfModifier");
	assert.ok(match, "should find SubsurfModifier");
});

test("blender_search_api_docs handles unknown query cleanly without throwing", async () => {
	const result = await blenderSearchApiDocs({
		query: "completely_unknown_token_xyz_987654",
	});

	assert.equal(result.totalMatches, 0);
	assert.deepEqual(result.matches, []);
});

// ----------------------------------------------------------------------------
// blender_search_manual_docs
// ----------------------------------------------------------------------------

test("blender_search_manual_docs returns matching manual excerpts and topics", async () => {
	const geomResult = await blenderSearchManualDocs({
		query: "geometry nodes",
	});

	assert.ok(geomResult.totalMatches > 0, "should find geometry nodes manual topics");
	const match = geomResult.matches.find((m) => m.topic === "geometry_nodes");
	assert.ok(match, "should find match in geometry_nodes topic");
	assert.ok(match.snippet, "snippet should be present");

	const shadingResult = await blenderSearchManualDocs({
		query: "principled bsdf",
	});
	assert.ok(shadingResult.totalMatches > 0);
	const shadingMatch = shadingResult.matches.find((m) => m.topic === "shading");
	assert.ok(shadingMatch, "should find Principled BSDF in shading manual topic");
});

test("blender_search_manual_docs handles unknown query cleanly without throwing", async () => {
	const result = await blenderSearchManualDocs({
		query: "super_obscure_nonexistent_manual_phrase_00000",
	});

	assert.equal(result.totalMatches, 0);
	assert.deepEqual(result.matches, []);
});

// ----------------------------------------------------------------------------
// Bridge-Free & Zero Lock Guarantee
// ----------------------------------------------------------------------------

test("doc-grounding tools are host-bound and never take bridge lock or require Blender", async () => {
	// 1. Static inspection: doc-grounding.ts must never import bridge or lock helpers in executable code
	const docGroundingCode = docGroundingSource
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n");

	assert.doesNotMatch(
		docGroundingCode,
		/from\s+["'].*bridge(\.js)?["']/,
		"doc-grounding.ts must never import bridge module",
	);
	assert.doesNotMatch(
		docGroundingCode,
		/\bwithBridgeLock\b/,
		"doc-grounding.ts must never call withBridgeLock",
	);
	assert.doesNotMatch(
		docGroundingCode,
		/\bbridge\.lock\b/,
		"doc-grounding.ts must never reference bridge.lock",
	);

	// 2. Dynamic execution: verify that calls resolve instantly without Blender
	const start = Date.now();
	const [apiGet, apiSearch, manualSearch] = await Promise.all([
		blenderGetPythonApiDocs({ identifier: "bpy.types.Object" }),
		blenderSearchApiDocs({ query: "BooleanModifier" }),
		blenderSearchManualDocs({ query: "modeling" }),
	]);
	const elapsed = Date.now() - start;

	assert.equal(apiGet.found, true);
	assert.ok(apiSearch.totalMatches > 0);
	assert.ok(manualSearch.totalMatches > 0);
	assert.ok(elapsed < 1000, `all three offline doc operations took ${elapsed}ms; must be sub-second`);
});

// ----------------------------------------------------------------------------
// Documentation Corpus & Licensing Invariants
// ----------------------------------------------------------------------------

test("docs/reference NOTICE and LICENSE files exist and document license disposition", () => {
	const noticePath = join(ROOT_DIR, "docs", "reference", "NOTICE");
	const licensePath = join(ROOT_DIR, "docs", "reference", "LICENSE.blender-docs");

	assert.ok(existsSync(noticePath), "docs/reference/NOTICE must exist");
	assert.ok(existsSync(licensePath), "docs/reference/LICENSE.blender-docs must exist");

	const noticeContent = readFileSync(noticePath, "utf8");
	assert.match(noticeContent, /CC BY-SA 4\.0/, "NOTICE must cite CC BY-SA 4.0 for manual");
	assert.match(noticeContent, /GPL/, "NOTICE must cite GPL for API reference");
	assert.match(noticeContent, /Blender 4\.2 LTS/, "NOTICE must cite Blender 4.2 LTS");
});

test("scripts/update-reference-docs.mjs --check runs and passes", () => {
	const scriptPath = join(ROOT_DIR, "scripts", "update-reference-docs.mjs");
	assert.ok(existsSync(scriptPath), "update-reference-docs.mjs must exist");

	const output = execFileSync(process.execPath, [scriptPath, "--check"], {
		encoding: "utf8",
	});
	assert.match(output, /All reference documents validated successfully/);
});
