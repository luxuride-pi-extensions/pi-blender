/**
 * Unit tests for the transport-agnostic Blender capability core and MCP façade.
 *
 * Verifies:
 * - Core imports NO pi symbol and is unit-testable in a bare Node process.
 * - All tool definitions, schemas, and return shapes are intact.
 * - Read-only subset (blender_session_context, blender_scene_info, blender_geometry_probe, blender_image_probe)
 *   is exposed via the Model Context Protocol stdio façade.
 * - MCP server implements initialize, ping, tools/list, and tools/call.
 * - Stdio stream communication over newline-delimited JSON-RPC works as expected.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const {
	BLENDER_TOOLS,
	BLENDER_TOOL_NAMES,
	READ_ONLY_TOOLS,
	READ_ONLY_TOOL_NAMES,
	getTool,
} = await loadTs("../core/tools.ts");

const {
	createMcpServer,
	MCP_PROTOCOL_VERSION,
	MCP_SERVER_NAME,
	MCP_SERVER_VERSION,
} = await loadTs("../core/mcp-server.ts");

const EXPECTED_TOOL_NAMES = [
	"blender_workspace_init",
	"blender_workspace_prune",
	"blender_execute_python",
	"blender_session_context",
	"blender_scene_info",
	"blender_save_view",
	"blender_render",
	"blender_module_run",
	"blender_branch_run",
	"blender_branch_apply",
	"blender_module_revert",
	"blender_set_mode",
	"blender_log_critique",
	"blender_rank_assets",
	"blender_iteration_state",
	"blender_record_iteration_fact",
	"blender_export_asset",
	"blender_add_reference",
	"blender_reference_search",
	"blender_bridge_status",
	"blender_geometry_probe",
	"blender_image_probe",
	"blender_read_only_python",
	"blender_montage",
	"blender_compare",
	"blender_object_detail",
	"blender_import_asset",
	"blender_get_python_api_docs",
	"blender_search_api_docs",
	"blender_search_manual_docs",
	"blender_window_layout",
	"blender_switch_workspace",
	"blender_focus_view",
	"blender_job_status",
	"blender_job_cancel",
	"blender_usage_guess",
	"blender_build_status",
	"blender_build_advance",
];

const EXPECTED_READ_ONLY_NAMES = [
	"blender_session_context",
	"blender_scene_info",
	"blender_geometry_probe",
	"blender_image_probe",
];

test("core files import NO pi symbols or pi-manager-core", () => {
	const coreDir = new URL("../core/", import.meta.url);
	const files = readdirSync(coreDir).filter((file) => file.endsWith(".ts"));
	assert.ok(files.length >= 3, `Expected at least 3 .ts files in core/, found: ${files.join(", ")}`);

	const bannedPatterns = [
		/@earendil-works/,
		/@luxuride-pi\/manager-core/,
		/ExtensionAPI/,
		/loadManagerCore/,
	];

	for (const file of files) {
		const source = readFileSync(new URL(file, coreDir), "utf8");
		for (const pattern of bannedPatterns) {
			assert.doesNotMatch(
				source,
				pattern,
				`core/${file} contains banned pi symbol matching ${pattern}`,
			);
		}
	}
});

// The count is asserted, not derived: the core layer must expose every tool the
// pi extension registers, and a silent drop here would make a tool vanish from
// the MCP façade while still working in pi.
test("core capability layer exports every Blender tool with valid shapes", () => {
	assert.equal(BLENDER_TOOLS.length, 38);
	assert.deepEqual(BLENDER_TOOL_NAMES, EXPECTED_TOOL_NAMES);

	for (const tool of BLENDER_TOOLS) {
		assert.ok(tool.name, "tool must have a name");
		assert.ok(tool.label, `${tool.name} must have a label`);
		assert.ok(tool.description, `${tool.name} must have a description`);
		assert.ok(tool.parameters, `${tool.name} must have a parameters schema`);
		assert.equal(typeof tool.execute, "function", `${tool.name} must have an execute function`);

		const lookedUp = getTool(tool.name);
		assert.equal(lookedUp?.name, tool.name);
	}
});

test("read-only tool subset contains exactly the four designated inspection/probe tools", () => {
	assert.deepEqual([...READ_ONLY_TOOL_NAMES], EXPECTED_READ_ONLY_NAMES);
	assert.equal(READ_ONLY_TOOLS.length, 4);

	const names = READ_ONLY_TOOLS.map((t) => t.name);
	assert.deepEqual(names, EXPECTED_READ_ONLY_NAMES);

	for (const tool of READ_ONLY_TOOLS) {
		assert.equal(tool.readOnly, true, `${tool.name} should be marked readOnly`);
	}
});

test("MCP server initialize response complies with MCP specification", async () => {
	const server = createMcpServer();
	const response = await server.handleMessage({
		jsonrpc: "2.0",
		id: "req-init-1",
		method: "initialize",
		params: {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "test-client", version: "1.0.0" },
		},
	});

	assert.ok(response);
	assert.equal(response.jsonrpc, "2.0");
	assert.equal(response.id, "req-init-1");
	assert.equal(response.result?.protocolVersion, MCP_PROTOCOL_VERSION);
	assert.deepEqual(response.result?.capabilities, { tools: {} });
	assert.deepEqual(response.result?.serverInfo, {
		name: MCP_SERVER_NAME,
		version: MCP_SERVER_VERSION,
	});
});

test("MCP server handles ping and notifications", async () => {
	const server = createMcpServer();

	const pingResp = await server.handleMessage({
		jsonrpc: "2.0",
		id: 2,
		method: "ping",
	});
	assert.ok(pingResp);
	assert.equal(pingResp.id, 2);
	assert.deepEqual(pingResp.result, {});

	// Notifications should not yield a response
	const notifyResp = await server.handleMessage({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	});
	assert.equal(notifyResp, null);
});

const { CAPABILITY_BUNDLES } = await loadTs("../blender/agent-policy.ts");

// Read plus review, in bundle order with duplicates removed: the default
// surface is derived, never listed by hand.
const EXPECTED_DEFAULT_NAMES = [
	...new Set([...CAPABILITY_BUNDLES["blender.read"], ...CAPABILITY_BUNDLES["blender.review"]]),
];
const MUTATING_BUNDLES = ["blender.author", "blender.assemble", "blender.manage"];

test("MCP server tools/list returns the read and review bundles by default", async () => {
	const server = createMcpServer({ env: {} });
	const response = await server.handleMessage({
		jsonrpc: "2.0",
		id: "list-1",
		method: "tools/list",
	});

	assert.ok(response);
	assert.equal(response.id, "list-1");
	const toolList = response.result?.tools;
	assert.ok(Array.isArray(toolList));
	assert.equal(toolList.length, EXPECTED_DEFAULT_NAMES.length);
	assert.deepEqual(
		toolList.map((tool) => tool.name),
		EXPECTED_DEFAULT_NAMES,
	);

	for (const tool of toolList) {
		assert.ok(tool.description);
		assert.equal(tool.inputSchema.type, "object");
		assert.ok(tool.inputSchema.properties);
	}

	// A mutating-only tool on the default surface would be a remote code
	// execution path a client never asked for. Tools shared with read/review
	// (render, save_view) are legitimately reachable through review.
	const exposed = new Set(toolList.map((tool) => tool.name));
	const reviewable = new Set([...CAPABILITY_BUNDLES["blender.read"], ...CAPABILITY_BUNDLES["blender.review"]]);
	for (const bundle of MUTATING_BUNDLES) {
		for (const name of CAPABILITY_BUNDLES[bundle]) {
			if (reviewable.has(name)) continue;
			assert.ok(!exposed.has(name), `${name} must not be on the default MCP surface`);
		}
	}
});

test("MCP server publishes outputSchema for the documented stable results", async () => {
	const server = createMcpServer({ bundles: [...Object.keys(CAPABILITY_BUNDLES)], env: {} });
	const response = await server.handleMessage({ jsonrpc: "2.0", id: "list-schema", method: "tools/list" });
	const byName = new Map(response.result.tools.map((tool) => [tool.name, tool]));

	for (const name of ["blender_scene_info", "blender_branch_run", "blender_branch_apply", "blender_export_asset"]) {
		const tool = byName.get(name);
		assert.ok(tool, `${name} must be exposed by default`);
		assert.ok(tool.outputSchema, `${name} must publish an outputSchema`);
		assert.equal(tool.outputSchema.type, "object");
		assert.equal(tool.outputSchema.additionalProperties, true);
	}
	assert.equal(byName.get("blender_session_context")?.outputSchema, undefined);
});

test("mutating bundles are reachable only by opt-in", async () => {
	const explicit = createMcpServer({ bundles: ["blender.assemble"], env: {} });
	assert.deepEqual(explicit.bundles, ["blender.assemble"]);
	assert.deepEqual(
		explicit.tools.map((tool) => tool.name),
		[...CAPABILITY_BUNDLES["blender.assemble"]],
	);

	const fromEnv = createMcpServer({ env: { PI_BLENDER_MCP_BUNDLES: "blender.read, blender.author" } });
	assert.deepEqual(fromEnv.bundles, ["blender.read", "blender.author"]);
	assert.ok(fromEnv.tools.some((tool) => tool.name === "blender_branch_run"));

	// An explicit option beats the environment: a programmatic caller states its
	// intent more precisely than the shell it happens to run in.
	const both = createMcpServer({ bundles: ["blender.read"], env: { PI_BLENDER_MCP_BUNDLES: "blender.manage" } });
	assert.deepEqual(both.tools.map((tool) => tool.name), [...CAPABILITY_BUNDLES["blender.read"]]);
});

test("an unknown bundle name is a startup error naming the valid ones", () => {
	assert.throws(
		() => createMcpServer({ bundles: ["blender.everything"], env: {} }),
		(error) => {
			assert.match(error.message, /Unknown MCP capability bundle "blender\.everything"/);
			for (const name of Object.keys(CAPABILITY_BUNDLES)) {
				assert.match(error.message, new RegExp(name.replace(".", "\\.")));
			}
			return true;
		},
	);
});

test("MCP server maps details to structuredContent and images to image blocks", async () => {
	const pngPath = new URL("./fixtures/mcp-tiny.png", import.meta.url);
	const stub = (name, details) => ({
		name,
		label: name,
		description: "stub",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details }),
	});
	const server = createMcpServer({
		env: {},
		tools: [
			stub("blender_render", { outputPath: pngPath.pathname, changed: true }),
			stub("blender_branch_apply", {
				blendPath: "/w/model.blend",
				applied: [{ module: "a" }],
				skipped: [],
				missing: [],
			}),
		],
	});

	const rendered = await server.handleMessage({
		jsonrpc: "2.0",
		id: 201,
		method: "tools/call",
		params: { name: "blender_render", arguments: {} },
	});
	assert.equal(rendered.result.isError, false);
	assert.equal(rendered.result.content[0].type, "text");
	const image = rendered.result.content[1];
	assert.equal(image.type, "image");
	assert.equal(image.mimeType, "image/png");
	assert.ok(image.data.length > 0);
	assert.equal(rendered.result.structuredContent.outputPath, pngPath.pathname);

	const applied = await server.handleMessage({
		jsonrpc: "2.0",
		id: 202,
		method: "tools/call",
		params: { name: "blender_branch_apply", arguments: {} },
	});
	// A contested apply is a completed run: no error code, the payload explains it.
	assert.equal(applied.result.isError, false);
	assert.equal(applied.result.structuredContent.path, "/w/model.blend");
	assert.deepEqual(applied.result.structuredContent.counts, { applied: 1, skipped: 0, missing: 0 });
});

test("MCP server derives the error code from the failure", async () => {
	const stub = (name, execute) => ({
		name,
		label: name,
		description: "stub",
		parameters: { type: "object", properties: {} },
		execute,
	});
	const server = createMcpServer({
		env: {},
		tools: [
			stub("blender_branch_run", async () => {
				throw new Error("Module alpha is locked by another run (lease held).");
			}),
			stub("blender_scene_info", async () => {
				throw new Error("workspace must be an absolute path");
			}),
			stub("blender_render", async () => {
				throw new Error("Blender exited with code 1");
			}),
			stub("blender_export_asset", async () => {
				throw new Error("name must not contain a path separator");
			}),
		],
	});

	const codeFor = async (name) => {
		const response = await server.handleMessage({
			jsonrpc: "2.0",
			id: 300,
			method: "tools/call",
			params: { name, arguments: {} },
		});
		assert.equal(response.result.isError, true);
		return response.result.structuredContent.code;
	};

	assert.equal(await codeFor("blender_branch_run"), "LOCK_CONFLICT");
	assert.equal(await codeFor("blender_scene_info"), "VALIDATION_ERROR");
	assert.equal(await codeFor("blender_render"), "EXECUTION_ERROR");
	assert.equal(await codeFor("blender_export_asset"), "VALIDATION_ERROR");
});

test("MCP server tools/call handles unknown tool cleanly", async () => {
	const server = createMcpServer();
	const response = await server.handleMessage({
		jsonrpc: "2.0",
		id: 99,
		method: "tools/call",
		params: {
			name: "non_existent_tool",
			arguments: {},
		},
	});

	assert.ok(response);
	assert.equal(response.id, 99);
	assert.equal(response.result?.isError, true);
	assert.match(response.result?.content?.[0]?.text, /not found/i);
});

test("MCP server tools/call executes tool and returns standard result shape", async () => {
	const server = createMcpServer({ cwd: "/tmp" });
	// Calling blender_image_probe with nonexistent file returns structured failure/probe result without crashing
	const response = await server.handleMessage({
		jsonrpc: "2.0",
		id: 101,
		method: "tools/call",
		params: {
			name: "blender_image_probe",
			arguments: {
				workspace: "/tmp/non-existent-workspace",
				path: "non-existent.png",
			},
		},
	});

	assert.ok(response);
	assert.equal(response.id, 101);
	// Result should contain content array of text items
	assert.ok(Array.isArray(response.result?.content));
	assert.ok(response.result?.content.length > 0);
	assert.equal(response.result?.content[0]?.type, "text");
});

test("MCP server stdio transport reads and writes newline-delimited JSON-RPC", async () => {
	const input = new PassThrough();
	const output = new PassThrough();

	const server = createMcpServer({ input, output });
	server.start();

	const receivedLines = [];
	output.on("data", (chunk) => {
		const str = chunk.toString();
		for (const line of str.split("\n")) {
			if (line.trim()) receivedLines.push(JSON.parse(line));
		}
	});

	// Send initialize
	input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
	// Send ping
	input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) + "\n");
	// Send malformed JSON line
	input.write("{ malformed json\n");

	await new Promise((resolve) => setTimeout(resolve, 50));
	server.close();

	assert.equal(receivedLines.length, 3);
	assert.equal(receivedLines[0].id, 1);
	assert.equal(receivedLines[0].result.serverInfo.name, MCP_SERVER_NAME);
	assert.equal(receivedLines[1].id, 2);
	assert.deepEqual(receivedLines[1].result, {});
	assert.equal(receivedLines[2].id, null);
	assert.equal(receivedLines[2].error.code, -32700);
});
