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
	"blender_bridge_status",
	"blender_geometry_probe",
	"blender_image_probe",
	"blender_read_only_python",
	"blender_montage",
	"blender_compare",
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

test("core capability layer exports all 23 Blender tools with valid shapes", () => {
	assert.equal(BLENDER_TOOLS.length, 23);
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

test("MCP server tools/list returns read-only tools with valid inputSchemas", async () => {
	const server = createMcpServer();
	const response = await server.handleMessage({
		jsonrpc: "2.0",
		id: "list-1",
		method: "tools/list",
	});

	assert.ok(response);
	assert.equal(response.id, "list-1");
	const toolList = response.result?.tools;
	assert.ok(Array.isArray(toolList));
	assert.equal(toolList.length, 4);

	const names = toolList.map((t) => t.name);
	assert.deepEqual(names, EXPECTED_READ_ONLY_NAMES);

	for (const tool of toolList) {
		assert.ok(tool.description);
		assert.equal(tool.inputSchema.type, "object");
		assert.ok(tool.inputSchema.properties);
	}
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
