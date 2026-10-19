#!/usr/bin/env node
/**
 * Standalone stdio MCP server for pi-blender.
 *
 * Exposes read-only Blender capabilities to any third-party Model Context Protocol client:
 * - blender_session_context
 * - blender_scene_info
 * - blender_geometry_probe
 * - blender_image_probe
 *
 * Runs over standard input and standard output using newline-delimited JSON-RPC 2.0.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

async function loadMcpServer() {
	try {
		return await import("../core/mcp-server.ts");
	} catch (nativeErr) {
		try {
			const jitiPath = resolveJiti();
			if (jitiPath) {
				const { createJiti } = await import(jitiPath);
				const jiti = createJiti(import.meta.url, { interopDefault: true });
				return await jiti.import("../core/mcp-server.ts");
			}
		} catch {
			// fall through
		}
		throw nativeErr;
	}
}

function resolveJiti() {
	if (process.env.PI_JITI_PATH && existsSync(process.env.PI_JITI_PATH)) {
		return process.env.PI_JITI_PATH;
	}
	const piInstallDir = process.env.PI_INSTALL_DIR ?? join(process.env.PI_HOME ?? join(homedir(), ".pi"), "agent", "install");
	const releases = join(piInstallDir, "releases");
	if (existsSync(releases)) {
		const names = readdirSync(releases).filter((name) => existsSync(join(releases, name, "node_modules")));
		if (names.length > 0) {
			names.sort();
			const newest = names[names.length - 1];
			const cand = join(releases, newest, "node_modules", "jiti", "lib", "jiti.mjs");
			if (existsSync(cand)) return cand;
		}
	}
	return undefined;
}

const { runMcpServer } = await loadMcpServer();
await runMcpServer();
