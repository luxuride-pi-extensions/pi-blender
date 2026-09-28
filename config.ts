/**
 * Minimal stand-in for the vibe-blender fork's `../config.js` so the extracted
 * blender module can run unmodified under the stock pi extension loader.
 *
 * Paths:
 *  - assets dir: this extension's `blender/` directory (scripts + skills)
 *  - bridge dir: $PI_BLENDER_BRIDGE_DIR (supports `~/`) or
 *    $XDG_CACHE_HOME/vibe-blender/bridge (default ~/.cache/vibe-blender/bridge)
 *  - temp dir:   $XDG_CACHE_HOME/vibe-blender/tmp  (flatpak-visible)
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

export const APP_NAME = "vibe-blender";

export function getBlenderAssetsDir(): string {
	return join(EXTENSION_DIR, "blender");
}

export function getBundledBlenderBridgePath(): string {
	return resolve(join(getBlenderAssetsDir(), "live-bridge.py"));
}

export function getBundledBlankBootstrapPath(): string {
	return resolve(join(getBlenderAssetsDir(), "blank-bootstrap.py"));
}

/** Path the launch bootstrap saves a clean, empty blend to (flatpak-visible). */
export function getBlankBlendPath(): string {
	const envPath = process.env.PI_BLENDER_BLANK_BLEND_PATH?.trim();
	if (envPath) {
		if (envPath === "~") return homedir();
		if (envPath.startsWith("~/")) return homedir() + envPath.slice(1);
		return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
	}
	return join(xdgCacheHome(), "vibe-blender", "blank.blend");
}

export const ENV_BLENDER_BRIDGE_DIR = "PI_BLENDER_BRIDGE_DIR";

function xdgCacheHome(): string {
	return process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
}

export function getBlenderBridgeDir(): string {
	const envDir = process.env[ENV_BLENDER_BRIDGE_DIR]?.trim();
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir);
	}
	return join(xdgCacheHome(), "vibe-blender", "bridge");
}

/**
 * Directory safe for flatpak-launched Blender to read and write temp scripts.
 * /tmp and $XDG_RUNTIME_DIR are NOT visible inside the org.blender.Blender
 * sandbox; the XDG cache home is bind-mounted.
 */
const ensuredTempDirs = new Set<string>();

export function getBlenderTempDir(): string {
	const dir = process.env.PI_BLENDER_TMP_DIR?.trim()
		? process.env.PI_BLENDER_TMP_DIR
		: join(xdgCacheHome(), "vibe-blender", "tmp");
	// mkdirSync is a blocking syscall on a path reached from async tool code,
	// on every temp script. The directory only needs creating once per process;
	// if something removes it later, the next write surfaces the error rather
	// than silently racing a half-created dir.
	if (!ensuredTempDirs.has(dir)) {
		mkdirSync(dir, { recursive: true });
		ensuredTempDirs.add(dir);
	}
	return dir;
}
