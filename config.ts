/**
 * Minimal stand-in for the vibe-blender fork's `../config.js` so the extracted
 * blender module can run unmodified under the stock pi extension loader.
 *
 * Paths:
 *  - assets dir: this extension's `blender/` directory (scripts + skills)
 *  - bridge dir: $PI_BLENDER_BRIDGE_DIR (supports `~/`, used EXACTLY as given)
 *    or $XDG_CACHE_HOME/vibe-blender/bridge/<instance-id>
 *  - temp dir:   $XDG_CACHE_HOME/vibe-blender/tmp  (flatpak-visible)
 *
 * Every pi PROCESS gets its own bridge dir and therefore its own private
 * Blender UI. The alternative — one shared dir — makes every request from every
 * instance contend for a single lock and a single mutable scene, so a second
 * window costs minutes of queueing and can interleave mutations with the first.
 * The cost of isolation is memory and one more Blender window to keep straight,
 * which is the trade the user chose.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

export const APP_NAME = "vibe-blender";

/**
 * Stable id for this pi process's private bridge, generated once and never
 * changed for the process lifetime.
 *
 * A pid alone is not an identity: the OS reuses pids, so a stale directory left
 * by a killed pi process could collide with a new one and inherit a heartbeat
 * written by a Blender this process did not start. A random id makes that
 * collision-free, and the pid is recorded separately (see writeInstanceFile) for
 * reaping, where "is the owner still running" is the actual question.
 */
let cachedInstanceId: string | undefined;

export function getBlenderInstanceId(): string {
	// Dashes stripped so the id is clean hex in a path and in the
	// instance.json it is written to. Cosmetic, but the id is what a user sees
	// when hunting through the bridge root, and "bridge/a1b2c3d4e5f6" is easier
	// to eyeball than one with a stray separator in the middle.
	cachedInstanceId ??= randomUUID().replace(/-/g, "").slice(0, 12);
	return cachedInstanceId;
}

/** Directory holding every instance's bridge dir. */
export function getBlenderBridgeRootDir(): string {
	const envDir = process.env[ENV_BLENDER_BRIDGE_DIR]?.trim();
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir);
	}
	// Under the XDG cache home, not /tmp: the flatpak Blender sandbox cannot
	// see /tmp, and this dir has to be visible to the process we spawn.
	return join(xdgCacheHome(), "vibe-blender", "bridge");
}

export function getBlenderAssetsDir(): string {
	return join(EXTENSION_DIR, "blender");
}

export function getBundledBlenderBridgePath(): string {
	return resolve(join(getBlenderAssetsDir(), "live-bridge.py"));
}

export function getBundledBlankBootstrapPath(): string {
	return resolve(join(getBlenderAssetsDir(), "blank-bootstrap.py"));
}

/**
 * Path the launch bootstrap saves a clean, empty blend to (flatpak-visible).
 *
 * Per-instance for the same reason the bridge dir is: this file is written by
 * the Blender we spawn, and two instances sharing one path would have two
 * Blenders overwriting each other's bootstrap blend — the exact silent-clobber
 * class the request-claim in live-bridge.py exists to prevent.
 */
export function getBlankBlendPath(): string {
	const envPath = process.env.PI_BLENDER_BLANK_BLEND_PATH?.trim();
	if (envPath) {
		if (envPath === "~") return homedir();
		if (envPath.startsWith("~/")) return homedir() + envPath.slice(1);
		return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
	}
	return join(xdgCacheHome(), "vibe-blender", "blank", `${getBlenderInstanceId()}.blend`);
}

export const ENV_BLENDER_BRIDGE_DIR = "PI_BLENDER_BRIDGE_DIR";

/**
 * Whether the user pinned one specific bridge dir by hand.
 *
 * This switches OFF the per-instance scheme entirely: there is no instance
 * subdirectory, so there are no sibling instance dirs, and anything that
 * sweeps for them (the reaper) must not run. Someone who sets this is naming
 * one bridge deliberately, and their directory's contents are theirs.
 */
export function hasBridgeDirOverride(): boolean {
	return Boolean(process.env[ENV_BLENDER_BRIDGE_DIR]?.trim());
}

function xdgCacheHome(): string {
	return process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
}

/**
 * This pi instance's private bridge dir.
 *
 * $PI_BLENDER_BRIDGE_DIR is honoured EXACTLY as given, with no instance
 * subdirectory appended. Someone who sets it is naming one specific bridge on
 * purpose — to share a UI with another process, or to point at a dir a running
 * Blender already polls — and silently nesting a subdir under it would give a
 * Blender that can never see the requests.
 */
export function getBlenderBridgeDir(): string {
	if (process.env[ENV_BLENDER_BRIDGE_DIR]?.trim()) {
		return getBlenderBridgeRootDir();
	}
	return join(getBlenderBridgeRootDir(), getBlenderInstanceId());
}

/**
 * Record which pi process owns this bridge dir, so a later process can tell an
 * orphan (owner dead) from a live instance (owner alive) and reap accordingly.
 *
 * Written rather than derived because the pid alone is not enough: a reaped pid
 * is indistinguishable from a crashed one, and treating a crashed instance as
 * live is what leaves Blenders accumulating on the user's desktop.
 */
export function writeInstanceFile(): void {
	const dir = getBlenderBridgeDir();
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "instance.json"),
		JSON.stringify({ pid: process.pid, instanceId: getBlenderInstanceId(), startedAt: new Date().toISOString() }),
		"utf-8",
	);
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
