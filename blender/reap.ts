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
	getBlankBlendDir,
	hasBlankBlendPathOverride,
	hasBridgeDirOverride,
} from "../config.js";
import { isHeartbeatFresh, isHeartbeatPidAlive, LIVE_BRIDGE_LAUNCH_WATCHDOG_MS } from "./liveness.js";

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
 *
 * Rule 3 is about ANY owner, not the single one `instance.json` records. A dir
 * is shared by every process in one pi session's delegation tree (see
 * config.ts), and a subagent that has finished and exited is the common case,
 * not the exceptional one. Reading only the last-written record would classify
 * a dir whose surviving owner is very much alive as an orphan the moment that
 * one worker exited, and the sweep would delete the requests directory out from
 * under the session's live Blender.
 *
 * Rule 4 is the one that needed adding, and its absence was a leak rather than
 * a safety problem. A dir can exist with NO owner record at all: a process
 * killed between creating it and publishing the record, or one from before
 * per-process records existed. Every such dir read as unclassifiable and was
 * therefore never removed, so the instance root grew a permanent entry per
 * incident. A live user met exactly that — a dir whose heartbeat was eleven
 * hours stale and whose launch claim named a pid long gone, still there, still
 * looking like a second Blender to anyone who listed the root.
 *
 * The removal condition is therefore positive evidence in all three parts: a
 * heartbeat file (so the dir is a bridge dir and not something a person made),
 * that heartbeat stale past UNOWNED_DIR_STALE_MS rather than merely past
 * HEARTBEAT_STALE_MS, and no live launch claim. A claim that cannot be read
 * counts as LIVE, because a claim is created and written in two steps and the
 * half-written state is a peer that is launching right now. The long window is
 * the same budget a launch is owed, and for the same reason: no launch path
 * takes longer than that to publish an owner record, so a dir this old with no
 * record has not been published and never will be.
 *
 * Exported for the tests, which must reach the decision without a sweep: the
 * sweep resolves the instance root from the environment at import time and
 * refuses to run at all under PI_BLENDER_BRIDGE_DIR, so a test that wanted the
 * verdict through reapOrphanedBridgeDirs() would be testing the override guard
 * instead of this function.
 */
export async function classifyBridgeDir(dir: string): Promise<"adopt" | "remove" | string> {
	if (isHeartbeatFresh(dir)) {
		return isHeartbeatPidAlive(dir) ? "adopt" : "remove";
	}

	const owners = await readOwnerRecords(dir);
	if (owners === null) {
		// No owner record. Only a dir carrying a bridge heartbeat can be one of
		// ours, and only an old one with no live claim is certainly abandoned —
		// see rule 4 in the file header.
		if (!(await looksLikeAbandonedBridgeDir(dir))) {
			return "no instance file and no heartbeat; left alone";
		}
		return "remove";
	}

	// Any live owner keeps the dir. An owner that is starting, or that is simply
	// running without having launched a UI, is still going to want this dir.
	for (const ownerPid of owners) {
		if (pidIsRunning(ownerPid)) {
			return "owner pi still running, bridge not started yet";
		}
	}
	return "remove";
}

/**
 * Every pid recorded as an owner of this dir, or null when the dir carries no
 * ownership record at all.
 *
 * Reads the per-process records in `instances/` first and falls back to the
 * single `instance.json`, which is what a dir written by a pi running the
 * previous version (or by a sweep in a concurrently-upgraded session) has.
 *
 * "No usable pid anywhere" and "no record at all" deliberately return the same
 * thing — null, meaning unclassifiable. A dir full of records that will not
 * parse is exactly as undecidable as a dir with none, and this is the branch
 * that ends in `rm -rf`: an empty-but-present record set must never be the one
 * input that deletes, because the unparseable-by-accident case is far likelier
 * than the genuinely-dead-owners case it would be mistaken for.
 */
async function readOwnerRecords(dir: string): Promise<number[] | null> {
	const pids: number[] = [];
	const addPid = (parsed: InstanceFile | null): void => {
		const pid = toPid(parsed?.pid);
		if (pid !== null && !pids.includes(pid)) pids.push(pid);
	};
	try {
		for (const entry of await readdir(join(dir, "instances"))) {
			if (!entry.endsWith(".json")) continue;
			addPid(await readInstanceFile(join(dir, "instances", entry)));
		}
	} catch {
		// No per-process records: a dir from before they existed.
	}
	addPid(await readInstanceFile(join(dir, "instance.json")));
	return pids.length > 0 ? pids : null;
}

/**
 * How long an instance dir with no owner record must go unowned before the
 * sweep may remove it.
 *
 * Longer than HEARTBEAT_STALE_MS (10s) on purpose, and by a wide margin. Ten
 * seconds is the window a *live* UI is allowed to go without beating, so a rule
 * using it would remove a dir belonging to a process that is merely slow. The
 * same budget a launch is owed is the right comparison: a launch publishes its
 * owner record at the same time it claims the launch, and a launch that cannot
 * do that within the cold-start budget is not going to do it later.
 */
const UNOWNED_DIR_STALE_MS = LIVE_BRIDGE_LAUNCH_WATCHDOG_MS;

/**
 * Whether a dir with no owner record is certainly an abandoned bridge dir.
 *
 * Three pieces of positive evidence, all required, because the alternative is
 * `rm -rf` on a directory nobody can prove is ours:
 *
 *   1. a heartbeat file, so the dir is a bridge dir rather than a hand-made
 *      one or a scratch directory a person put there;
 *   2. a heartbeat older than UNOWNED_DIR_STALE_MS, so a starting or
 *      working UI is never a candidate;
 *   3. no live launch claim. A claim is created and written in two steps, so an
 *      unreadable one is a peer mid-launch and counts as live.
 *
 * Never throws: a failure to read is not evidence of abandonment.
 */
async function looksLikeAbandonedBridgeDir(dir: string): Promise<boolean> {
	let heartbeat: Awaited<ReturnType<typeof stat>> | null;
	try {
		heartbeat = await stat(join(dir, "heartbeat"));
	} catch {
		return false;
	}
	if (!heartbeat.isFile()) return false;
	if (Date.now() - heartbeat.mtimeMs < UNOWNED_DIR_STALE_MS) return false;

	// A claim is checked by EXISTENCE first and by pid second, because the
	// create-then-write window means a claim that exists but cannot be read is
	// a peer mid-launch. Reading first would call that an absent claim and
	// remove a dir somebody is about to publish an owner record into.
	let claim: { pid?: unknown } | null = null;
	try {
		claim = JSON.parse(await readFile(join(dir, "launch.claim"), "utf-8")) as { pid?: unknown };
	} catch {
		claim = null;
	}
	if (claim === null) {
		// Either there is no claim, or there is one this process cannot read.
		// The second is the dangerous case, so it is what decides.
		try {
			await stat(join(dir, "launch.claim"));
			return false;
		} catch {
			return true;
		}
	}
	const pid = toPid(claim.pid);
	return pid === null || !pidIsRunning(pid);
}

/** Filename stem of a bootstrap blend: the instance id that wrote it. */
const BLANK_STEM_PATTERN = /^([A-Za-z0-9._-]{1,64})\.blend1?$/;

/**
 * Whether this blank blend's owning session is provably gone.
 *
 * The file itself is disposable -- blank-bootstrap.py recreates it on every
 * launch -- so age alone would be enough to make it safe to delete. What is NOT
 * safe is deleting the one a Blender is currently sitting in: that instance's
 * UI has the path open, and a Blender that loses its file underneath itself
 * reports errors for every later save. So the owning bridge dir is what
 * decides, using the same liveness evidence the reaper already trusts.
 */
async function isBlankBlendAbandoned(stem: string, ageMs: number): Promise<boolean> {
	if (ageMs < UNOWNED_DIR_STALE_MS) return false;
	if (stem === getBlenderInstanceId()) return false;
	if (hasBridgeDirOverride()) return false;
	return (await classifyBridgeDir(join(getBlenderBridgeRootDir(), stem))) === "remove";
}

/**
 * Reap bootstrap blends left behind by sessions that are gone.
 *
 * One per Blender launch, ~90KB each, and never cleaned: nothing in a dying
 * process runs, and unlike the bridge dir there is no sibling-sweep to notice.
 * A session that is still live is left strictly alone -- see
 * isBlankBlendAbandoned, which refuses on anything but positive evidence.
 */
export async function reapStaleBlankBlends(): Promise<ReapResult> {
	const result: ReapResult = { removed: [], adopted: [], skipped: [] };
	if (hasBlankBlendPathOverride()) {
		result.skipped.push({
			dir: getBlankBlendDir(),
			reason: "PI_BLENDER_BLANK_BLEND_PATH is set; its contents are user-owned, not instances",
		});
		return result;
	}
	const dir = getBlankBlendDir();
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return result;
	}
	for (const entry of entries) {
		const stem = BLANK_STEM_PATTERN.exec(entry)?.[1];
		if (stem === undefined) continue;
		const file = join(dir, entry);
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(file);
		} catch {
			continue;
		}
		if (!info.isFile()) continue;
		if (await isBlankBlendAbandoned(stem, Date.now() - info.mtimeMs)) {
			try {
				await rm(file, { force: true });
				result.removed.push(file);
				continue;
			} catch {
				// A file the sweep is sure about but cannot delete is a fault
				// worth reporting, not a survivor the user asked about.
				result.skipped.push({
					dir: file,
					reason: "an abandoned session, but the file could not be removed",
				});
				continue;
			}
		}
		result.adopted.push(file);
	}
	return result;
}

async function readInstanceFile(path: string): Promise<InstanceFile | null> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as InstanceFile;
	} catch {
		return null;
	}
}

/**
 * A one-line summary for a startup log, or undefined when there was nothing
 * worth reporting (the overwhelmingly common case).
 */
export function formatReapResult(result: ReapResult): string | undefined {
	const parts: string[] = [];
	if (result.adopted.length > 0) {
		// "Adopted" here means ONLY "declined to delete". Nothing in this
		// process ever talks to those bridges -- each instance has its own
		// bridge dir, so the sweep's whole job is to leave live neighbours
		// alone. An earlier wording said "reattached", which claimed a
		// capability that does not exist and would have been a lie in the
		// one log a user reads when a second Blender is up.
		parts.push(`left ${result.adopted.length} running Blender instance(s) alone`);
	}
	if (result.removed.length > 0) {
		parts.push(`removed ${result.removed.length} stale instance dir(s) with no live Blender`);
	}
	if (result.skipped.length > 0) {
		parts.push(`left ${result.skipped.length} dir(s) alone: ${result.skipped[0]?.reason ?? "unclassified"}`);
	}
	return parts.length > 0 ? `[pi-blender] ${parts.join("; ")} (this instance: ${getBlenderInstanceId()}).` : undefined;
}

/**
 * A one-line summary of the blank-blend sweep, or undefined when nothing was
 * removed. Kept apart from formatReapResult because the two sweeps count
 * different things -- files against directories -- and a shared line would
 * describe whichever ran first.
 */
export function formatBlankReapResult(result: ReapResult): string | undefined {
	const parts: string[] = [];
	if (result.removed.length > 0) {
		parts.push(`removed ${result.removed.length} stale bootstrap blend(s) from dead sessions`);
	}
	if (result.skipped.length > 0) {
		parts.push(`left ${result.skipped.length} bootstrap blend path(s) alone: ${result.skipped[0]?.reason ?? "unclassified"}`);
	}
	return parts.length > 0 ? `[pi-blender] ${parts.join("; ")} (this instance: ${getBlenderInstanceId()}).` : undefined;
}
