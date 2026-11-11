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

import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/** Directory holding one file per admitted run slot, shared by every pi process. */
const SLOTS_DIR_NAME = "headless-slots";
/** Short-lived mutex making "count the slots, take a free one" one action. */
const ADMISSION_LOCK_NAME = "admission.lock";
/** An unparseable slot is reclaimed past this age, matching the admission lock. */
const SLOT_STALE_MS = 10_000;
/** A wait longer than this is a broken workspace, not a busy one. */
const SLOT_WAIT_DEADLINE_MS = 120_000;

export interface HeadlessSlot {
	/** Slot index, or -1 for the no-op slot used when the bridge dir is unusable. */
	index: number;
	path: string;
	/** The limit this slot was admitted under; peers respect the smallest one. */
	limit: number;
}

interface SlotRecord {
	owner: number;
	blenderPid?: number;
	limit: number;
	at: string;
}

function slotsDir(): string {
	return join(getBlenderBridgeDir(), SLOTS_DIR_NAME);
}

function slotPath(index: number): string {
	return join(slotsDir(), `slot-${index}.json`);
}

function readSlot(path: string): SlotRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SlotRecord>;
		if (typeof parsed.owner !== "number" || typeof parsed.limit !== "number") return null;
		return {
			owner: parsed.owner,
			blenderPid: typeof parsed.blenderPid === "number" ? parsed.blenderPid : undefined,
			limit: parsed.limit,
			at: typeof parsed.at === "string" ? parsed.at : "",
		};
	} catch {
		return null;
	}
}

function writeSlot(path: string, record: SlotRecord, exclusive: boolean): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(record), { flag: "wx" });
	try {
		// A link is the exclusive, atomic publish: the slot appears complete or
		// not at all, so a concurrent reader never sees a truncated record and
		// frees an index that is already taken.
		if (exclusive) linkSync(tmp, path);
		else renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Remove slots whose run is gone and report how many slots are live.
 *
 * A pi process can die while its Blender keeps running, so the owner alone is
 * not proof the seat is free: the recorded Blender pid has to be gone too. An
 * unparseable or 0-byte slot is reclaimed by age, because otherwise one killed
 * writer wedges that index forever.
 */
function liveSlots(): { live: SlotRecord[]; free: number[] } {
	const live: SlotRecord[] = [];
	const free: number[] = [];
	const seen = new Set<number>();
	let names: string[] = [];
	try {
		names = readdirSync(slotsDir());
	} catch {
		return { live, free: [0] };
	}
	for (const name of names) {
		const match = /^slot-(\d+)\.json$/.exec(name);
		if (!match) continue;
		const index = Number(match[1]);
		seen.add(index);
		const path = slotPath(index);
		const record = readSlot(path);
		if (!record) {
			try {
				if (Date.now() - statSync(path).mtimeMs > SLOT_STALE_MS) rmSync(path, { force: true });
			} catch {
				// Vanished between read and stat; the next sweep sees the truth.
			}
			free.push(index);
			continue;
		}
		const ownerDead = !pidIsRunning(record.owner);
		const blenderGone = record.blenderPid === undefined || !pidIsRunning(record.blenderPid);
		if (ownerDead && blenderGone) {
			try {
				rmSync(path, { force: true });
			} catch {
				// A stale slot costs one wait; the next admission retries.
			}
			free.push(index);
			continue;
		}
		live.push(record);
	}
	free.sort((a, b) => a - b);
	for (let index = 0; ; index += 1) {
		if (!seen.has(index)) {
			free.push(index);
			break;
		}
	}
	return { live, free };
}

/**
 * Take the admission mutex, or report that another process holds it.
 *
 * `wx` is the atomic primitive: exactly one process can create the file. A
 * holder that died leaves the file behind, so both the pid and its age are
 * checked -- the age covers a reused pid, and a wait that outlives a whole
 * admission is not a healthy lock either.
 */
function tryLockAdmission(): boolean {
	const path = join(slotsDir(), ADMISSION_LOCK_NAME);
	try {
		writeSlot(path, { owner: process.pid, limit: 0, at: new Date().toISOString() }, true);
		return true;
	} catch {
		let pid: number | null = null;
		try {
			const parsed = JSON.parse(readFileSync(path, "utf-8")) as { pid?: unknown; owner?: unknown };
			const holder = parsed.pid ?? parsed.owner;
			pid = typeof holder === "number" ? holder : null;
		} catch {
			// A torn or vanished lock is handled by the age check below.
		}
		let stale = pid !== null && !pidIsRunning(pid);
		try {
			stale = stale || Date.now() - statSync(path).mtimeMs > SLOT_STALE_MS;
		} catch {
			// Vanished between the open and the stat: the next attempt can take it.
		}
		if (stale) {
			try {
				rmSync(path, { force: true });
			} catch {
				// Another process won the sweep; retrying is correct either way.
			}
		}
		return false;
	}
}

function unlockAdmission(): void {
	try {
		rmSync(join(slotsDir(), ADMISSION_LOCK_NAME), { force: true });
	} catch {
		// A mutex that cannot be removed blocks until its age makes it stale.
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

let warnedAboutNoop = false;

/**
 * Admit one headless run against the SESSION-WIDE budget.
 *
 * The in-process gate in utils.ts knows only its own count, so four pi workers
 * each admitting their own limit used to multiply the ceiling by the fan-out
 * width -- and the RSS clamp with it, because every worker measured the same
 * free memory at start. Slots in the shared bridge dir make the admission
 * question cross-process: a worker waits when the session tree already holds
 * its whole budget, whichever process holds the slots.
 *
 * A slot records the limit it was admitted under, and admission uses the
 * smallest limit among the live slots and the caller. A memory-clamped worker
 * therefore really holds the line instead of merely contributing its own
 * number: the session can never exceed the narrowest active budget, and the
 * hard cap of four runs means the RSS clamp is not multiplied either.
 */
export async function acquireHeadlessSlot(
	limit: number,
	options?: { signal?: AbortSignal; deadlineMs?: number },
): Promise<HeadlessSlot> {
	const noop: HeadlessSlot = { index: -1, path: "", limit: 0 };
	try {
		mkdirSync(slotsDir(), { recursive: true });
	} catch {
		// Bookkeeping must not break a run, but the fallback restores the old
		// per-process ceiling, so it is worth saying so once.
		if (!warnedAboutNoop) {
			warnedAboutNoop = true;
			console.error(`[pi-blender] headless slots unavailable under ${slotsDir()}; run budget is per-process here.`);
		}
		return noop;
	}
	const effective = Math.max(1, Math.trunc(limit));
	const deadline = Date.now() + (options?.deadlineMs ?? SLOT_WAIT_DEADLINE_MS);
	let lastLive = liveSlots().live.length;
	for (;;) {
		if (options?.signal?.aborted) throw new Error("Headless slot wait was aborted.");
		if (tryLockAdmission()) {
			try {
				const { live, free } = liveSlots();
				lastLive = live.length;
				const capacity = Math.min(effective, ...live.map((slot) => slot.limit));
				if (live.length < capacity) {
					for (const index of free) {
						try {
							writeSlot(slotPath(index), { owner: process.pid, limit: effective, at: new Date().toISOString() }, true);
							return { index, path: slotPath(index), limit: effective };
						} catch {
							// Taken between the sweep and this write; try the next index.
						}
					}
				}
			} finally {
				unlockAdmission();
			}
		}
		if (Date.now() > deadline) {
			throw new Error(
				`Timed out waiting for a headless run slot (${lastLive} of ${effective} in use). The session-wide budget is held by another pi process; check ${slotsDir()} for a stale slot.`,
			);
		}
		await sleep(100);
	}
}

/**
 * Record the Blender pid on a slot, so a slot whose owning pi process died is
 * not reclaimed while the Blender it admitted is still running.
 */
export function claimHeadlessSlot(slot: HeadlessSlot, blenderPid: number): void {
	if (slot.index < 0) return;
	try {
		writeSlot(
			slot.path,
			{ owner: process.pid, blenderPid, limit: slot.limit, at: new Date().toISOString() },
			false,
		);
	} catch {
		// The owner check still covers the common case.
	}
}

/** Release a slot taken by acquireHeadlessSlot. Safe for the no-op slot. */
export function releaseHeadlessSlot(slot: HeadlessSlot): void {
	if (slot.index < 0) return;
	try {
		rmSync(slot.path, { force: true });
	} catch {
		// A slot that outlives its run is swept when its pid dies.
	}
}
