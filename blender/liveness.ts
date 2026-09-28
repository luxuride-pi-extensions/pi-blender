/**
 * Heartbeat liveness, shared by the launch guard and the instance reaper.
 *
 * This lives apart from launch.ts because two callers need it and they need it
 * for DIFFERENT directories: the launcher asks "is the UI I am about to talk to
 * alive", and the reaper asks "is whatever is beating in someone else's bridge
 * dir alive". A version that closed over launch.ts's own bridge dir could only
 * ever answer the first question, and a reaper that accidentally checked its
 * OWN dir would delete a live neighbour.
 *
 * The heartbeat is a JSON file `{"pid": int, "at": epoch}` written by
 * live-bridge.py on every 0.5s poll. Two independent signals:
 *
 *   mtime  — proves "something touched this recently". Cheap, and the only
 *            signal available from a pre-pid bridge build.
 *   pid    — proves "and it is still running". Signal 0 checks existence and
 *            permission without delivering anything, so a live Blender is
 *            never disturbed.
 *
 * Neither alone is sufficient. mtime alone keeps reporting a UI alive for up to
 * 10s after a crash, and a file restored with its timestamps can look fresh
 * indefinitely. The pid alone cannot tell a starting Blender from a dead one,
 * because a starting Blender has not written its first heartbeat yet.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getBlenderBridgeDir } from "../config.js";

/**
 * How long a heartbeat may go unrefreshed before the UI counts as gone.
 *
 * Duplicated from launch.ts deliberately: launch.ts owns the launch timing
 * policy, this module owns the read side, and a reaper that used a different
 * staleness window than the launcher would classify the same dead dir as alive.
 */
export const HEARTBEAT_STALE_MS = 10_000;

/** Whether the heartbeat file was touched within the staleness window. */
export function isHeartbeatFresh(bridgeDir: string = getBlenderBridgeDir()): boolean {
	try {
		const mtimeMs = statSync(join(bridgeDir, "heartbeat")).mtimeMs;
		return Date.now() - mtimeMs < HEARTBEAT_STALE_MS;
	} catch {
		return false;
	}
}

/**
 * Whether the pid in the heartbeat is still a live process.
 *
 * Deliberately one-way. `true` means "do not treat this as dead": an
 * unreadable, unparseable, or pid-less heartbeat falls back to mtime alone
 * rather than declaring a possibly-running UI dead. Only a CONFIRMED dead pid
 * returns false, and it returns false even when the mtime is perfectly fresh —
 * that is the crash-just-before-expiry case mtime cannot see.
 *
 * EPERM counts as alive: the process exists, it just belongs to another user,
 * which is exactly what a Blender launched outside this session looks like.
 */
export function isHeartbeatPidAlive(bridgeDir: string = getBlenderBridgeDir()): boolean {
	let pid: number;
	try {
		const raw = readFileSync(join(bridgeDir, "heartbeat"), "utf-8");
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return true;
		const candidate = (parsed as { pid?: unknown }).pid;
		// A heartbeat with no usable pid is the pre-pid format (an older
		// live-bridge.py, or the utime fallback).
		if (typeof candidate !== "number" || !Number.isInteger(candidate) || candidate <= 0) return true;
		pid = candidate;
	} catch {
		return true;
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Full liveness answer for a bridge dir: fresh AND backed by a live pid.
 *
 * When `onFresh` is supplied it runs on the fresh-but-unconfirmed path, which
 * is the one place a caller has cleanup to do (the launcher releases its launch
 * watchdog). It is a callback rather than a return flag so the launcher's
 * side effect stays with the launcher.
 */
export function isBridgeAlive(
	bridgeDir: string = getBlenderBridgeDir(),
	onFresh?: () => void,
): boolean {
	if (!isHeartbeatFresh(bridgeDir)) return false;
	if (!isHeartbeatPidAlive(bridgeDir)) return false;
	onFresh?.();
	return true;
}
