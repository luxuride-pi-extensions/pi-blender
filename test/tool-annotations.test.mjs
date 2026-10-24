// MCP tool annotations test (Issue #12)
//
// Verifies that all registered blender_* tools declare MCP-style annotations:
// { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }
//
// This reads index.ts as text rather than importing the extension, because
// index.ts cannot be imported without the manager-core extension, which is not
// installed in a bare checkout (matching tool-params.test.mjs and tool-schema-shape.test.mjs).

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
		if (!cur && lines[i].includes("pi.registerTool({")) {
			cur = { lines: [lines[i]] };
			depth = 1;
			continue;
		}
		if (!cur) continue;
		cur.lines.push(lines[i]);
		depth += (lines[i].match(/\{/g) || []).length - (lines[i].match(/\}/g) || []).length;
		if (depth <= 0 && /^\t\t\}\);/.test(lines[i])) {
			const text = cur.lines.join("\n");
			const nameMatch = text.match(/name:\s*"(blender_[a-z0-9_]+)"/);
			if (nameMatch) {
				blocks.push({ name: nameMatch[1], lines: cur.lines });
			}
			cur = null;
		}
	}
	return blocks;
}

/** Parse annotations object from tool block lines. */
function parseAnnotations(block) {
	const text = block.lines.join("\n");
	const match = text.match(/annotations:\s*\{([^}]+)\}/s);
	if (!match) return null;
	const body = match[1];
	const parseBool = (prop) => {
		const m = body.match(new RegExp(`\\b${prop}:\\s*(true|false)\\b`));
		return m ? m[1] === "true" : undefined;
	};
	return {
		readOnlyHint: parseBool("readOnlyHint"),
		destructiveHint: parseBool("destructiveHint"),
		idempotentHint: parseBool("idempotentHint"),
		openWorldHint: parseBool("openWorldHint"),
	};
}

const EXPECTED_ANNOTATIONS = {
	blender_workspace_init: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_execute_python: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_session_context: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_scene_info: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_save_view: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_render: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_module_run: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_branch_run: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	blender_branch_apply: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_module_revert: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_set_mode: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_log_critique: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	blender_rank_assets: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_iteration_state: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_record_iteration_fact: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_export_asset: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	blender_add_reference: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	blender_bridge_status: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_geometry_probe: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_image_probe: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_read_only_python: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_montage: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_compare: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_switch_workspace: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_focus_view: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	blender_usage_guess: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_job_status: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_window_layout: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	blender_object_detail: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_import_asset: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	blender_get_python_api_docs: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_search_api_docs: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	blender_search_manual_docs: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
};

test("all registered blender tools are enumerated", () => {
	const blocks = toolBlocks();
	assert.equal(blocks.length, 33, `expected 33 registered tools, found ${blocks.length}`);
	const foundNames = blocks.map((b) => b.name).sort();
	const expectedNames = Object.keys(EXPECTED_ANNOTATIONS).sort();
	assert.deepEqual(foundNames, expectedNames);
});

test("every registered blender tool declares a complete annotations block", () => {
	const blocks = toolBlocks();
	const missingOrIncomplete = [];

	for (const block of blocks) {
		const annotations = parseAnnotations(block);
		if (!annotations) {
			missingOrIncomplete.push(`${block.name}: missing annotations block entirely`);
			continue;
		}

		for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
			if (typeof annotations[key] !== "boolean") {
				missingOrIncomplete.push(`${block.name}: missing or non-boolean ${key} (got ${annotations[key]})`);
			}
		}
	}

	assert.deepEqual(
		missingOrIncomplete,
		[],
		`The following tools lack complete annotations:\n${missingOrIncomplete.join("\n")}`,
	);
});

test("annotations match the issue #12 specifications and local contracts", () => {
	const blocks = toolBlocks();
	for (const block of blocks) {
		const annotations = parseAnnotations(block);
		assert.ok(annotations, `${block.name} lacks annotations`);
		const expected = EXPECTED_ANNOTATIONS[block.name];
		assert.ok(expected, `Unexpected tool: ${block.name}`);
		assert.deepEqual(
			annotations,
			expected,
			`${block.name} annotations mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(annotations)}`,
		);
	}
});

test("blender_read_only_python disposition is honest (readOnlyHint: false, destructiveHint: false)", () => {
	const blocks = toolBlocks();
	const roTool = blocks.find((b) => b.name === "blender_read_only_python");
	assert.ok(roTool, "blender_read_only_python block not found");
	const annotations = parseAnnotations(roTool);
	assert.ok(annotations);
	assert.equal(
		annotations.readOnlyHint,
		false,
		"blender_read_only_python must have readOnlyHint: false because python scripts can touch the filesystem",
	);
	assert.equal(
		annotations.destructiveHint,
		false,
		"blender_read_only_python must have destructiveHint: false because mutating bpy operations are refused",
	);
});

test("openWorldHint accurately distinguishes live Blender/external tools from workspace-file-only operations", () => {
	const blocks = toolBlocks();
	const liveTools = [
		"blender_workspace_init",
		"blender_execute_python",
		"blender_session_context",
		"blender_save_view",
		"blender_render",
		"blender_module_run",
		"blender_branch_apply",
		"blender_module_revert",
		"blender_set_mode",
		"blender_bridge_status",
		"blender_geometry_probe",
		"blender_read_only_python",
		"blender_montage",
		"blender_compare",
	];
	const workspaceFileOnlyTools = [
		"blender_scene_info",
		"blender_branch_run",
		"blender_log_critique",
		"blender_rank_assets",
		"blender_iteration_state",
		"blender_record_iteration_fact",
		"blender_export_asset",
		"blender_add_reference",
		"blender_image_probe",
	];

	for (const name of liveTools) {
		const block = blocks.find((b) => b.name === name);
		assert.ok(block, `missing ${name}`);
		const annotations = parseAnnotations(block);
		assert.equal(annotations.openWorldHint, true, `${name} interacts with live Blender / external process and must declare openWorldHint: true`);
	}

	for (const name of workspaceFileOnlyTools) {
		const block = blocks.find((b) => b.name === name);
		assert.ok(block, `missing ${name}`);
		const annotations = parseAnnotations(block);
		assert.equal(annotations.openWorldHint, false, `${name} is workspace-file-only and must declare openWorldHint: false`);
	}
});
