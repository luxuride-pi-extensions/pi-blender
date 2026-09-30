/**
 * Counting the headless Blenders this session has open, across processes.
 *
 * The gate in concurrency.ts is deliberately per-process (see the comment on
 * headlessGate in utils.ts), so it knows its own in-flight count and nothing
 * else. But the question a manager actually asks is about the whole session
 * tree: it spawned four workers, each running a module, and a manager that
 * reports "0 running" while four Blenders are saturating the box has answered
 * a question nobody asked.
 *
 * So each spawned headless Blender writes a LEASE — one small file named after
 * its pid, in the instance's shared bridge dir — and the count is the number of
 * leases whose pid is still alive. Leases rather than a single counter file
 * because a shared record would have to be read-modify-written by every process
 * in the tree, and two processes claiming a slot at the same instant would
 * clobber each other's update: the surviving number would be one, and the
 * operator would be told one Blender was running while two were. Separate
 * files cannot lose an update, because no process ever writes another's.
 *
 * A lease is written AFTER the spawn, because that is when the pid exists, and
 * removed when the process exits — including on a crash of the parent, since
 * the dead pid is what makes the entry stale rather than the file's absence.
 * That is the same one-way liveness logic the bridge heartbeat uses: a pid that
 * cannot be signalled because it belongs to another user still exists, and
 * EPERM means running, not dead.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBlenderBridgeDir } from "../config.js";

/** Subdirectory of the bridge dir holding one file per open headless run. */
const LEASES_DIR_NAME = "headless-runs";

function leasesDir(): string {
	return join(getBlenderBridgeDir(), LEASES_DIR_NAME);
}

export interface HeadlessRunLease {
	/** The Blender process, which is also the lease file's name. */
	pid: number;
	/** The process that spawned it, so a lease can be traced to its owner. */
	ownerPid: number;
	/** What the run was for, e.g. the module name. Diagnostics only. */
	label: string | null;
	startedAt: string;
}

/** Whether a pid names a live process. EPERM means it exists, not that it is ours. */
function pidIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Record a headless Blender as open.
 *
 * Takes the already-spawned pid rather than spawning itself, so the lease can
 * never claim a slot that no process holds: a lease written before the spawn
 * would report a run that failed to start.
 */
export function acquireRunLease(pid: number, label?: string): void {
	const lease: HeadlessRunLease = {
		pid,
		ownerPid: process.pid,
		label: label ?? null,
		startedAt: new Date().toISOString(),
	};
	try {
		mkdirSync(leasesDir(), { recursive: true });
		writeFileSync(join(leasesDir(), `${pid}.json`), JSON.stringify(lease), "utf-8");
	} catch {
		// Housekeeping. A lease that cannot be written costs the operator an
		// accurate count, not a correct run, and failing the run over it would
		// turn a bookkeeping problem into a broken module.
	}
}

/**
 * Record a headless Blender as closed.
 *
 * Safe to call for a pid that was never leased, because a caller unwinding
 * through a finally after a failed spawn has no lease to remove.
 */
export function releaseRunLease(pid: number): void {
	try {
		rmSync(join(leasesDir(), `${pid}.json`), { force: true });
	} catch {
		// Same reasoning as above: a stale lease is swept by the next count.
	}
}

export interface OpenHeadlessRuns {
	/** Headless Blenders alive right now, across every process in the session. */
	running: number;
	/** Their pids, for a caller that wants to say which ones. */
	pids: number[];
	/** Leases dropped because their process was gone. Non-zero after a crash. */
	staleSwept: number;
}

/**
 * Count the open headless Blenders, sweeping dead leases as it goes.
 *
 * Sweeping here rather than on a timer is deliberate: a lease outlives its
 * Blender exactly when the parent was killed, and a count that only ever grew
 * would report a machine loaded with Blenders that finished an hour ago. The
 * sweep is a side effect of asking, which is also the only moment anyone cares.
 *
 * Never throws. A count is a report about the machine, and a report that fails
 * is worse than one that says nothing.
 */
export function countOpenHeadlessRuns(): OpenHeadlessRuns {
	const result: OpenHeadlessRuns = { running: 0, pids: [], staleSwept: 0 };
	let names: string[];
	try {
		names = readdirSync(leasesDir());
	} catch {
		return result;
	}
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const pid = Number(name.slice(0, -".json".length));
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (pidIsRunning(pid)) {
			result.running += 1;
			result.pids.push(pid);
			continue;
		}
		result.staleSwept += 1;
		try {
			rmSync(join(leasesDir(), name), { force: true });
		} catch {
			// Left behind; the next count sweeps it again.
		}
	}
	return result;
}

/** Read one lease, or null. For diagnostics; the file is not authoritative. */
export function readRunLease(pid: number): HeadlessRunLease | null {
	try {
		return JSON.parse(readFileSync(join(leasesDir(), `${pid}.json`), "utf-8")) as HeadlessRunLease;
	} catch {
		return null;
	}
}