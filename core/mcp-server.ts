/**
 * Lightweight Model Context Protocol (MCP) stdio façade for Blender tools.
 *
 * Exposes read-only tools (blender_session_context, blender_scene_info,
 * blender_geometry_probe, blender_image_probe) via JSON-RPC 2.0 stdio transport.
 *
 * Implements standard MCP 2024-11-05 protocol:
 * - initialize
 * - notifications/initialized
 * - ping
 * - tools/list
 * - tools/call
 */

import * as readline from "node:readline";
import { READ_ONLY_TOOLS } from "./tools.js";
import type { CoreToolDefinition } from "./types.js";

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const MCP_SERVER_NAME = "pi-blender";
export const MCP_SERVER_VERSION = "0.1.5";

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
	tools?: CoreToolDefinition[];
	serverName?: string;
	serverVersion?: string;
}

export interface McpServerInstance {
	tools: CoreToolDefinition[];
	handleMessage: (message: string | JsonRpcRequest) => Promise<JsonRpcResponse | null>;
	start: () => void;
	close: () => void;
}

export function createMcpServer(options?: McpServerOptions): McpServerInstance {
	const tools = options?.tools ?? READ_ONLY_TOOLS;
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
								isError: true,
							},
						};
					}

					try {
						const cwd = (typeof toolArgs.cwd === "string" ? toolArgs.cwd : undefined) ?? defaultCwd;
						const toolResult = await targetTool.execute(toolArgs, { cwd });
						return {
							jsonrpc: "2.0",
							id,
							result: {
								content: toolResult.content,
								isError: toolResult.isError ?? false,
							},
						};
					} catch (err) {
						return {
							jsonrpc: "2.0",
							id,
							result: {
								content: [
									{
										type: "text",
										text: err instanceof Error ? err.message : String(err),
									},
								],
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
