/**
 * Lightweight Model Context Protocol (MCP) stdio façade for Blender tools.
 *
 * The exposed surface is resolved from capability bundles, not from a list
 * held here: the read and review bundles are the default, and the mutating
 * bundles are reachable only when a caller names them. An external client is
 * not a subagent and cannot be handed a narrower `tools:` line, so the bundle
 * table is the one place that decides what "read-only by default" means.
 *
 * Implements standard MCP 2024-11-05 protocol:
 * - initialize
 * - notifications/initialized
 * - ping
 * - tools/list
 * - tools/call
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import * as readline from "node:readline";
import { CAPABILITY_BUNDLES, CAPABILITY_BUNDLE_NAMES, type CapabilityBundleName } from "../blender/agent-policy.js";
import { OUTPUT_SCHEMAS } from "./output-schemas.js";
import { getTool } from "./tools.js";
import type { CoreToolDefinition } from "./types.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "pi-blender";
export const MCP_SERVER_VERSION = "0.1.5";

/** Read and review only: an MCP client may inspect a workspace by default. */
export const DEFAULT_MCP_BUNDLES: readonly CapabilityBundleName[] = ["blender.read", "blender.review"];

/** Opt-in for a mutating surface, comma-separated, e.g. "blender.read,blender.author". */
export const MCP_BUNDLES_ENV = "PI_BLENDER_MCP_BUNDLES";

/**
 * Largest PNG sent as an MCP image block.
 *
 * Base64 inflates a payload by a third, so a 4 MiB render becomes ~5.5 MiB of
 * JSON in one response, which clients truncate or reject. Above this the path
 * in `structuredContent` is the better handle, and the caller can open the file
 * itself.
 */
export const MAX_IMAGE_CONTENT_BYTES = 4 * 1024 * 1024;

/** Tools whose job is to hand back a picture, and the field that holds it. */
const IMAGE_DELIVERY_FIELD: Record<string, string> = {
	blender_render: "outputPath",
	blender_montage: "montagePath",
	blender_compare: "montagePath",
};

const STABLE_PATH_FIELD: Record<string, string> = {
	blender_scene_info: "blendPath",
	blender_branch_run: "branchPath",
	blender_branch_apply: "blendPath",
	blender_export_asset: "exportPath",
};

export type McpErrorCode = "EXECUTION_ERROR" | "VALIDATION_ERROR" | "LOCK_CONFLICT";

/**
 * Which bundle names an MCP server serves.
 *
 * The environment variable exists so a user can opt in without editing a
 * config file the extension owns; an explicit option wins over it, because a
 * programmatic caller states its intent more precisely than the shell it runs in.
 */
export function resolveMcpBundles(options?: McpServerOptions, env: NodeJS.ProcessEnv = process.env): readonly string[] {
	if (options?.bundles) return options.bundles;
	const fromEnv = (env[MCP_BUNDLES_ENV] ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	return fromEnv.length > 0 ? fromEnv : DEFAULT_MCP_BUNDLES;
}

/** Resolves bundle names to registry tools; an unknown name is a startup error. */
export function toolsForBundles(bundleNames: readonly string[]): CoreToolDefinition[] {
	const tools: CoreToolDefinition[] = [];
	for (const name of bundleNames) {
		const bundle = CAPABILITY_BUNDLES[name as CapabilityBundleName];
		if (!bundle) {
			throw new Error(
				`Unknown MCP capability bundle "${name}". Valid bundles: ${CAPABILITY_BUNDLE_NAMES.join(", ")}.`,
			);
		}
		for (const toolName of bundle) {
			const tool = getTool(toolName);
			if (tool && !tools.some((existing) => existing.name === tool.name)) tools.push(tool);
		}
	}
	return tools;
}

function countsFor(toolName: string, details: Record<string, unknown>): Record<string, number> | null {
	const length = (value: unknown) => (Array.isArray(value) ? value.length : undefined);
	if (toolName === "blender_scene_info") {
		return {
			objects: length(details.objects) ?? 0,
			materials: length(details.materials) ?? 0,
			collections: length(details.collections) ?? 0,
		};
	}
	if (toolName === "blender_branch_apply") {
		return {
			applied: length(details.applied) ?? 0,
			skipped: length(details.skipped) ?? 0,
			missing: length(details.missing) ?? 0,
		};
	}
	if (toolName === "blender_export_asset") {
		const counts: Record<string, number> = {};
		for (const key of ["bytes", "meshCount"] as const) {
			if (typeof details[key] === "number") counts[key] = details[key] as number;
		}
		for (const key of ["objects", "textures"] as const) {
			const count = length(details[key]);
			if (count !== undefined) counts[key] = count;
		}
		return Object.keys(counts).length > 0 ? counts : null;
	}
	return null;
}

/**
 * Adds the documented stable keys next to the handler's own field names.
 *
 * `path`, `digest` and `validation` are what a client branches on, but the core
 * results spell them per stage. Aliasing here keeps the core result types
 * unchanged while giving the published `outputSchema` something real to describe.
 */
function stableStructuredContent(toolName: string, details: unknown): unknown {
	if (!details || typeof details !== "object" || Array.isArray(details)) return details;
	if (!OUTPUT_SCHEMAS[toolName]) return details;
	const record = details as Record<string, unknown>;
	const enriched: Record<string, unknown> = { ...record };
	const pathField = STABLE_PATH_FIELD[toolName];
	if (enriched.path === undefined && pathField && typeof record[pathField] === "string") {
		enriched.path = record[pathField];
	}
	if (enriched.digest === undefined && typeof record.stateDigest === "string") enriched.digest = record.stateDigest;
	if (enriched.validation === undefined) {
		if (record.preflight) enriched.validation = record.preflight;
		else if (record.validation) enriched.validation = record.validation;
	}
	if (enriched.counts === undefined) {
		const counts = countsFor(toolName, record);
		if (counts) enriched.counts = counts;
	}
	return enriched;
}

function imageBlocks(toolName: string, details: unknown, cwd: string): unknown[] {
	const field = IMAGE_DELIVERY_FIELD[toolName];
	if (!field || !details || typeof details !== "object") return [];
	const value = (details as Record<string, unknown>)[field];
	if (typeof value !== "string") return [];
	const file = isAbsolute(value) ? value : resolve(cwd, value);
	try {
		const stat = statSync(file);
		if (!stat.isFile() || stat.size === 0 || stat.size > MAX_IMAGE_CONTENT_BYTES) return [];
		return [{ type: "image", data: readFileSync(file).toString("base64"), mimeType: "image/png" }];
	} catch {
		// A missing or unreadable artifact is not a tool failure: the text block
		// and the path in structuredContent already say what the caller needs.
		return [];
	}
}

/**
 * Classifies a thrown failure for the structured error code.
 *
 * Order matters: a lock message that also mentions a missing file is still a
 * lock conflict, and whether the caller should retry later or fix its arguments
 * depends on that distinction.
 */
export function errorCodeFor(message: string): McpErrorCode {
	if (/\block\b|lease|contend|conflict|already (?:running|held)|in use/i.test(message)) return "LOCK_CONFLICT";
	if (/invalid|must be|must |required|unknown |not found|no such|expected|needs /i.test(message)) {
		return "VALIDATION_ERROR";
	}
	return "EXECUTION_ERROR";
}

export interface JsonRpcRequest {
	jsonrpc?: string;
	id?: string | number | null;
	method: string;
	params?: any;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: any;
	error?: {
		code: number;
		message: string;
		data?: unknown;
	};
}

export interface McpServerOptions {
	input?: NodeJS.ReadableStream;
	output?: NodeJS.WritableStream;
	cwd?: string;
	/** Direct tool override for tests and embedders; bypasses bundle resolution. */
	tools?: CoreToolDefinition[];
	/** Capability bundles to serve; defaults to `PI_BLENDER_MCP_BUNDLES` or read+review. */
	bundles?: readonly string[];
	/** Environment to read `PI_BLENDER_MCP_BUNDLES` from; injected so tests are hermetic. */
	env?: NodeJS.ProcessEnv;
	serverName?: string;
	serverVersion?: string;
}

export interface McpServerInstance {
	tools: CoreToolDefinition[];
	bundles: readonly string[];
	handleMessage: (message: string | JsonRpcRequest) => Promise<JsonRpcResponse | null>;
	start: () => void;
	close: () => void;
}

export function createMcpServer(options?: McpServerOptions): McpServerInstance {
	const bundles = resolveMcpBundles(options, options?.env);
	const tools = options?.tools ?? toolsForBundles(bundles);
	const serverName = options?.serverName ?? MCP_SERVER_NAME;
	const serverVersion = options?.serverVersion ?? MCP_SERVER_VERSION;
	const defaultCwd = options?.cwd ?? process.cwd();

	let rl: readline.Interface | null = null;

	async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
		const id = request.id !== undefined ? request.id : null;
		const method = request.method;

		// Notifications do not receive responses
		const isNotification = request.id === undefined;

		try {
			switch (method) {
				case "initialize": {
					const clientVersion = request.params?.protocolVersion;
					const protocolVersion = typeof clientVersion === "string" ? clientVersion : MCP_PROTOCOL_VERSION;
					if (isNotification) return null;
					return {
						jsonrpc: "2.0",
						id,
						result: {
							protocolVersion,
							capabilities: {
								tools: {},
							},
							serverInfo: {
								name: serverName,
								version: serverVersion,
							},
						},
					};
				}

				case "notifications/initialized":
				case "initialized": {
					return null;
				}

				case "ping": {
					if (isNotification) return null;
					return {
						jsonrpc: "2.0",
						id,
						result: {},
					};
				}

				case "tools/list": {
					if (isNotification) return null;
					return {
						jsonrpc: "2.0",
						id,
						result: {
							tools: tools.map((tool) => ({
								name: tool.name,
								description: tool.description,
								inputSchema: tool.parameters,
								// A published output schema is a promise about the stable keys;
								// it is loose about the rest so a stage-specific addition does
								// not invalidate every client that already reads it.
								...(OUTPUT_SCHEMAS[tool.name] ? { outputSchema: OUTPUT_SCHEMAS[tool.name] } : {}),
								// MCP carries the same hints pi gates on, so a non-pi client
								// reaches the same confirmation decision instead of treating
								// every blender_* tool as destructive.
								...(tool.annotations ? { annotations: tool.annotations } : {}),
							})),
						},
					};
				}

				case "tools/call": {
					if (isNotification) return null;
					const toolName = request.params?.name;
					const toolArgs = request.params?.arguments ?? {};

					const targetTool = tools.find((t) => t.name === toolName);
					if (!targetTool) {
						return {
							jsonrpc: "2.0",
							id,
							result: {
								content: [
									{
										type: "text",
										text: `Tool "${toolName}" not found`,
									},
								],
								structuredContent: { code: "VALIDATION_ERROR", message: `Tool "${toolName}" not found` },
								isError: true,
							},
						};
					}

					try {
						const cwd = (typeof toolArgs.cwd === "string" ? toolArgs.cwd : undefined) ?? defaultCwd;
						const toolResult = await targetTool.execute(toolArgs, { cwd });
						const message = toolResult.content
							.map((block) => block.text)
							.join("\n")
							.slice(0, 2000);
						// A domain verdict (a blocked preflight, a contested apply) is a
						// completed run: it keeps its structured payload so the caller can
						// inspect what was refused, and only a real failure gets a code.
						const structuredContent = toolResult.isError
							? { code: errorCodeFor(message), message }
							: stableStructuredContent(targetTool.name, toolResult.details);
						return {
							jsonrpc: "2.0",
							id,
							result: {
								content: [
									...toolResult.content,
									...imageBlocks(targetTool.name, toolResult.details, cwd),
								],
								...(structuredContent !== undefined && typeof structuredContent === "object"
									? { structuredContent }
									: {}),
								isError: toolResult.isError ?? false,
							},
						};
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						return {
							jsonrpc: "2.0",
							id,
							result: {
								content: [
									{
										type: "text",
										text: message,
									},
								],
								structuredContent: { code: errorCodeFor(message), message },
								isError: true,
							},
						};
					}
				}

				default: {
					if (isNotification) return null;
					return {
						jsonrpc: "2.0",
						id,
						error: {
							code: -32601,
							message: `Method not found: ${method}`,
						},
					};
				}
			}
		} catch (err) {
			if (isNotification) return null;
			return {
				jsonrpc: "2.0",
				id,
				error: {
					code: -32603,
					message: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
				},
			};
		}
	}

	async function handleMessage(message: string | JsonRpcRequest): Promise<JsonRpcResponse | null> {
		let request: JsonRpcRequest;
		if (typeof message === "string") {
			const trimmed = message.trim();
			if (!trimmed) return null;
			try {
				request = JSON.parse(trimmed);
			} catch (parseError) {
				return {
					jsonrpc: "2.0",
					id: null,
					error: {
						code: -32700,
						message: `Parse error: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
					},
				};
			}
		} else {
			request = message;
		}

		if (!request || typeof request !== "object" || typeof request.method !== "string") {
			return {
				jsonrpc: "2.0",
				id: request && typeof request === "object" && request.id !== undefined ? request.id : null,
				error: {
					code: -32600,
					message: "Invalid Request",
				},
			};
		}

		return handleRequest(request);
	}

	function start() {
		const input = options?.input ?? process.stdin;
		const output = options?.output ?? process.stdout;

		rl = readline.createInterface({
			input,
			terminal: false,
		});

		let lineQueue = Promise.resolve();
		rl.on("line", (line: string) => {
			lineQueue = lineQueue.then(async () => {
				const response = await handleMessage(line);
				if (response) {
					output.write(`${JSON.stringify(response)}\n`);
				}
			}).catch((err) => {
				console.error("[pi-blender-mcp] Line processing error:", err);
			});
		});
	}

	function close() {
		if (rl) {
			rl.close();
			rl = null;
		}
	}

	return {
		tools,
		bundles,
		handleMessage,
		start,
		close,
	};
}

export async function runMcpServer(options?: McpServerOptions): Promise<void> {
	const server = createMcpServer(options);
	server.start();

	await new Promise<void>((resolve) => {
		// `input` is narrowed to a Readable: the Stream union's overloads for
		// .on() are not mutually callable, so the parameter type must be the
		// interface we actually use rather than Node's full Stream.
		const input: NodeJS.ReadableStream = options?.input ?? process.stdin;
		input.on("end", () => resolve());
		input.on("close", () => resolve());
	});
}
