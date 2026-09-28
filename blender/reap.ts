/**
 * Reap bridge dirs left behind by pi processes that are gone.
 *
 * Each pi process owns a private bridge dir and, through it, a private Blender
 * UI. That is what makes concurrent instances safe, but it means a UI can
 * outlive the pi that launched it: pi is killed with SIGKILL, the terminal is
 * closed, the machine reboots mid-session. Nothing in the process can clean up
 * after it, and the heartbeat check cannot help either, because a Blender left
 * running keeps beating.
 *
 * So every new pi process sweeps the instance root on startup and, for each dir
 * that is not its own, asks two separate questions:
 *
 *   - is the owning pi process still running?  If not, the dir is an orphan.
 *   - is the Blender in it still running?      If yes, ADOPT the dir and keep
 *     beating with it; if no, the dir is dead weight and gets removed.
 *
 * Adopting rather than killing is deliberate. A user who closed one pi window
 * and opened another, or who reattaches to a session, would otherwise find
 * their Blender silently gone and their unsaved live-session work with it.
 *
 * Nothing here is load-bearing for correctness of a single instance: the worst
 * a wrong answer does is leave a stale dir around or adopt a dead one, and the
 * heartbeat check corrects a dead one within 10s. It is housekeeping, so it is
 * deliberately forgiving — every failure is swallowed and the sweep continues.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	getBlenderBridgeDir,
	getBlenderBridgeRootDir,
	getBlenderInstanceId,
	hasBridgeDirOverride,
} from "../config.js";
import { isHeartbeatFresh, isHeartbeatPidAlive } from "./liveness.js";

interface InstanceFile {
	pid?: unknown;
	instanceId?: unknown;
	startedAt?: unknown;
}

/** Whether a pid names a live process. Same one-way logic as the liveness check. */
function pidIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists, it is just not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function toPid(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export interface ReapResult {
	/** Dirs removed because nothing was running in them. */
	removed: string[];
	/** Dirs kept because a live Blender was still beating in them. */
	adopted: string[];
	/** Dirs skipped, and why — one line each, safe to log. */
	skipped: Array<{ dir: string; reason: string }>;
}

/**
 * Sweep the instance root. Safe to call more than once and never throws.
 */
export async function reapOrphanedBridgeDirs(): Promise<ReapResult> {
	const result: ReapResult = { removed: [], adopted: [], skipped: [] };

	// An explicit PI_BLENDER_BRIDGE_DIR is not part of the per-instance scheme.
	// In that mode the bridge dir IS the directory the user named, so its
	// subdirectories are their data, not orphaned instances -- and sweeping
	// them would delete whatever they happen to keep there. This is the one
	// branch where getting it wrong destroys user files rather than cache, so
	// it returns without touching the filesystem at all.
	if (hasBridgeDirOverride()) {
		result.skipped.push({ dir: getBlenderBridgeDir(), reason: "PI_BLENDER_BRIDGE_DIR is set; its contents are user-owned, not instances" });
		return result;
	}

	const root = getBlenderBridgeRootDir();
	const ownDir = getBlenderBridgeDir();

	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		// No root yet means no instance has ever run. Nothing to sweep.
		return result;
	}

	for (const entry of entries) {
		const dir = join(root, entry);
		// The dir this process is using must never be a candidate, however
		// abandoned it looks: it is the one UI this session is driving.
		if (dir === ownDir) continue;

		// Ignore files: some editors or a crash may leave stray entries, and
		// `rm -rf` on a file we do not understand is not a safe default.
		const info = await stat(dir).catch(() => null);
		if (!info?.isDirectory()) continue;

		const verdict = await classifyBridgeDir(dir);
		if (verdict === "adopt") {
			result.adopted.push(dir);
		} else if (verdict === "remove") {
			await rm(dir, { recursive: true, force: true }).catch(() => undefined);
			result.removed.push(dir);
		} else {
			result.skipped.push({ dir, reason: verdict });
		}
	}
	return result;
}

/**
 * Decide what to do with one instance dir.
 *
 * The ordering matters and is the whole design:
 *
 *  1. A heartbeat with a CONFIRMED DEAD pid is removed, whatever else is
 *     present. A Blender that is provably gone leaves only stale files, and
 *     keeping them means the next pi adopts a dir whose UI cannot answer.
 *  2. A live heartbeat is adopted, whatever the owner says. The owner pid is
 *     the weaker signal: it can be wrong in both directions (a reused pid, or
 *     a pi process that exited cleanly and left its Blender running on
 *     purpose), whereas a beating heartbeat means a real UI answering in that
 *     exact dir.
 *  3. Only when nothing is beating does the owner pid decide. No heartbeat plus
 *     a live owner is a pi process that is starting its Blender right now.
 *  4. A dir with no instance file and no heartbeat cannot be classified, so it
 *     is left alone rather than guessed at.
 */
async function classifyBridgeDir(dir: string): Promise<"adopt" | "remove" | string> {
	if (isHeartbeatFresh(dir)) {
		return isHeartbeatPidAlive(dir) ? "adopt" : "remove";
	}

	let parsed: InstanceFile | null = null;
	try {
		parsed = JSON.parse(await readFile(join(dir, "instance.json"), "utf-8")) as InstanceFile;
	} catch {
		parsed = null;
	}
	if (!parsed) {
		// No instance file and no heartbeat: could be a hand-made bridge dir,
		// or a shared dir someone pointed PI_BLENDER_BRIDGE_DIR at. Not ours to
		// delete on a guess.
		return "no instance file and no heartbeat; left alone";
	}

	const ownerPid = toPid(parsed.pid);
	if (ownerPid === null) {
		return "instance file has no usable pid; left alone";
	}
	// pidIsRunning is only reached when the heartbeat is absent or stale, so
	// this is the "pi is up but has not started its UI yet" case.
	return pidIsRunning(ownerPid) ? "owner pi still running, bridge not started yet" : "remove";
}

/**
 * A one-line summary for a startup log, or undefined when there was nothing
 * worth reporting (the overwhelmingly common case).
 */
export function formatReapResult(result: ReapResult): string | undefined {
	const parts: string[] = [];
	if (result.adopted.length > 0) {
		parts.push(`reattached to ${result.adopted.length} running Blender instance(s)`);
	}
	if (result.removed.length > 0) {
		parts.push(`removed ${result.removed.length} stale instance dir(s) with no live Blender`);
	}
	if (result.skipped.length > 0) {
		parts.push(`left ${result.skipped.length} dir(s) alone: ${result.skipped[0]?.reason ?? "unclassified"}`);
	}
	return parts.length > 0 ? `[pi-vibe-blender] ${parts.join("; ")} (this instance: ${getBlenderInstanceId()}).` : undefined;
}
