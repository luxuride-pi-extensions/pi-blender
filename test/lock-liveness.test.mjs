/**
 * Reclaiming a lock whose holder is still running.
 *
 * All three disk locks -- the manifest lock, the bridge lock and the branch
 * apply lock -- write their holder's pid and then ignore it, deciding every
 * reclaim from mtime alone. That is wrong in a way no test could see while the
 * works were short: the bridge lock is documented to be held for minutes (a
 * render alone allows 360s) and the apply lock is held deliberately ACROSS a
 * headless Blender merge, so a reclaim by age hands a second writer the lock
 * while the first still owns the file it exists to protect.
 *
 * The rule is one-way, matching the heartbeat's: only a CONFIRMED dead pid
 * frees a lock early. A file that cannot be read, or that predates the pid
 * field, is never reclaimed on liveness grounds -- it waits out the age
 * window, because a parser that did not understand the file has no standing to
 * conclude the holder is gone.
 *
 * These tests spawn real short-lived processes for their pids. A faked pid
 * would be a pid the kernel never vouched for, and the whole question here is
 * what the kernel says.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-blender-locks-"));
const bridge = join(root, "bridge");
mkdirSync(bridge, { recursive: true });

const { lockHolderIsDead, pidIsRunning, readLockHolderPid } = await loadTs("../blender/liveness.ts", {
	PI_BLENDER_BRIDGE_DIR: bridge,
});
const { acquireBridgeLock } = await loadTs("../blender/utils.ts", {
	PI_BLENDER_BRIDGE_DIR: bridge,
});

const LOCK_FILE = join(bridge, "bridge.lock");

/** A pid that was alive a moment ago and is guaranteed not to be now. */
async function deadPid() {
	// A child that exits on its own could in principle have its pid recycled
	// before the probe runs, which would make the test pass for the wrong
	// reason. SIGKILLing a child we are still holding is the one death that is
	// both immediate and ours, and `kill -0` answers about it immediately after.
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	await new Promise((done) => child.once("spawn", done));
	child.kill("SIGKILL");
	await new Promise((done) => child.once("exit", done));
	return child.pid;
}

function writeLock(body, { ageMs = 0 } = {}) {
	writeFileSync(LOCK_FILE, body, "utf-8");
	if (ageMs > 0) {
		const when = new Date(Date.now() - ageMs);
		utimesSync(LOCK_FILE, when, when);
	}
}

function clearLock() {
	rmSync(LOCK_FILE, { force: true });
}

test.after(() => rmSync(root, { recursive: true, force: true }));

test("a pid-less lock is not the same answer as a dead one", () => {
	// The distinction the three reclaim sites are built on. "No pid to ask" and
	// "the pid is gone" lead to opposite rules, so collapsing them either steals
	// live locks or wedges every workspace written by a pre-pid build.
	for (const body of ["", "not json at all", "[]", JSON.stringify({}), JSON.stringify({ pid: 0 })]) {
		writeLock(body);
		assert.equal(readLockHolderPid(LOCK_FILE), null, `wrongly read a pid from ${JSON.stringify(body)}`);
		assert.equal(lockHolderIsDead(LOCK_FILE), false, `wrongly read ${JSON.stringify(body)} as dead`);
	}
	clearLock();
	assert.equal(lockHolderIsDead(LOCK_FILE), false, "a missing lock file is not evidence of a dead holder");
});

test("a pid-less lock is not reclaimed while it is fresh", async () => {
	// Age is the only signal here, and it has not elapsed.
	writeLock(JSON.stringify({ acquiredAt: new Date().toISOString() }));
	await assert.rejects(
		() => acquireBridgeLock({ timeoutMs: 250 }),
		/Timed out after .* waiting for the live Blender bridge lock/,
	);
	clearLock();
});

test("a live pid is not dead", async () => {
	assert.equal(pidIsRunning(process.pid), true);
	assert.equal(pidIsRunning(await deadPid()), false);
});

test("a lock held by this process is not reclaimable", () => {
	writeLock(JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }));
	try {
		assert.equal(lockHolderIsDead(LOCK_FILE), false);
	} finally {
		clearLock();
	}
});

test("a lock whose holder is gone is reclaimable at any age", async () => {
	// Fresh mtime, because mtime is exactly what cannot see a process that
	// crashed a second after writing the lock.
	writeLock(JSON.stringify({ pid: await deadPid(), acquiredAt: new Date().toISOString() }));
	try {
		assert.equal(lockHolderIsDead(LOCK_FILE), true);
	} finally {
		clearLock();
	}
});

test("a lock this process cannot read is never assumed dead", () => {
	writeLock("not json");
	assert.equal(lockHolderIsDead(LOCK_FILE), false);
	clearLock();
});

test("an aged lock held by a live process is still not taken", async () => {
	// Older than any of the three stale windows, so the age rule alone would
	// reclaim it. The short timeout makes "waited and then gave up" observable
	// without a 30s test.
	writeLock(JSON.stringify({ pid: process.pid, label: "held" }), { ageMs: 60 * 60_000 });
	try {
		await assert.rejects(
			() => acquireBridgeLock({ timeoutMs: 250 }),
			// The timeout names the holder, which is the only thing that tells an
			// operator whether to wait or go looking for the process.
			(pid) => /Timed out after .* waiting for the live Blender bridge lock/.test(pid.message) && new RegExp(`pid ${process.pid}\\b`).test(pid.message),
		);
	} finally {
		clearLock();
	}
});

test("a lock whose holder is gone is taken immediately, age aside", async () => {
	writeLock(JSON.stringify({ pid: await deadPid(), label: "crashed" }));
	const lock = await acquireBridgeLock({ timeoutMs: 5_000 });
	await lock.release();
});

test("a pid-less lock still falls back to the age window", async () => {
	// The pre-pid format. There is nothing to probe, so age remains the only
	// signal -- and the reclaim still has to work, or upgrading strands workspaces.
	writeLock(JSON.stringify({ acquiredAt: new Date().toISOString() }), { ageMs: 60 * 60_000 });
	const lock = await acquireBridgeLock({ timeoutMs: 5_000 });
	await lock.release();
});
