/**
 * Counting open headless Blenders across a session tree.
 *
 * The gate is per-process on purpose, so "how many Blenders does this session
 * have open" has no answer anywhere in it: a manager that spawned four workers
 * runs none itself and would answer zero while four processes saturate the box.
 * The leases are that answer, and they have to be right under the two failures
 * a shared counter cannot survive — two processes claiming a slot at the same
 * instant, and a process killed while its Blender is running.
 *
 * Pids are the mechanism rather than a heartbeat, so these tests spawn real
 * short-lived processes instead of faking liveness. A real process is the only
 * way to be sure the count does not depend on the assumption that made it work
 * in the author's head.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-blender-leases-"));
const bridge = join(root, "bridge");
mkdirSync(bridge, { recursive: true });

const leases = await loadTs("../blender/run-leases.ts", {
	PI_BLENDER_BRIDGE_DIR: bridge,
});

/** A child that is alive and will exit when told to. */
function spawnIdle() {
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	return child;
}

function exited(child) {
	return new Promise((done) => child.once("exit", () => done()));
}

function leaseFiles() {
	try {
		return readdirSync(join(bridge, "headless-runs")).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

test("no leases means no open Blenders, and asking does not create any", () => {
	const open = leases.countOpenHeadlessRuns();
	assert.equal(open.running, 0);
	assert.deepEqual(open.pids, []);
	assert.equal(open.staleSwept, 0, "an absent lease dir is not a stale lease. Reporting it as one would make a clean session look like it had crashed work in it.");
	assert.equal(leaseFiles().length, 0, "counting must be read-only on a machine with nothing running");
});

test("a live process is counted, and its pid is named", async () => {
	const child = spawnIdle();
	try {
		leases.acquireRunLease(child.pid, "branch run body");
		const open = leases.countOpenHeadlessRuns();
		assert.equal(open.running, 1);
		assert.deepEqual(open.pids, [child.pid], "the count is more useful with the pid attached: a caller can say WHICH run, not only how many.");
		assert.deepEqual(leases.readRunLease(child.pid), {
			pid: child.pid,
			ownerPid: process.pid,
			label: "branch run body",
			startedAt: leases.readRunLease(child.pid).startedAt,
		});
	} finally {
		child.kill("SIGKILL");
		await exited(child);
		leases.releaseRunLease(child.pid);
	}
});

test("releasing removes the lease even after the process is already gone", async () => {
	const child = spawnIdle();
	leases.acquireRunLease(child.pid, "branch apply body");
	child.kill("SIGKILL");
	await exited(child);
	// The release runs after the exit, which is the normal order: a run that
	// ends cleanly releases in a finally. The file must not survive it.
	leases.releaseRunLease(child.pid);
	assert.equal(leaseFiles().length, 0, "a lease outliving its run is exactly the leak this design exists to prevent");
});

test("releasing a pid that was never leased is safe", () => {
	// A caller unwinding through a finally after a failed spawn has no lease to
	// remove, so the shutdown path runs this unconditionally.
	leases.releaseRunLease(999_999);
	assert.equal(leaseFiles().length, 0);
});

test("a lease whose process died is swept rather than counted forever", async () => {
	const child = spawnIdle();
	leases.acquireRunLease(child.pid, "branch run rig");
	child.kill("SIGKILL");
	await exited(child);
	// No release: this is the parent being SIGKILLed, which leaves the lease
	// behind with nothing to clean it up.
	const open = leases.countOpenHeadlessRuns();
	assert.equal(open.running, 0, "a dead Blender reported as open is a machine that looks loaded with work that finished an hour ago");
	assert.equal(open.staleSwept, 1);
	assert.equal(leaseFiles().length, 0, "the sweep is what keeps the count honest; a second count must not re-report it");
});

test("two live Blenders are two, which a shared counter could not report under a race", async () => {
	const a = spawnIdle();
	const b = spawnIdle();
	try {
		// Written back to back on purpose: the interleaving that loses an update
		// in a read-modify-written counter happens between two processes, and
		// two sequential leases here is the same shape at the file level.
		leases.acquireRunLease(a.pid, "branch run body");
		leases.acquireRunLease(b.pid, "branch run rig");
		const open = leases.countOpenHeadlessRuns();
		assert.equal(open.running, 2);
		assert.deepEqual([...open.pids].sort((x, y) => x - y), [a.pid, b.pid].sort((x, y) => x - y));
		assert.equal(open.staleSwept, 0);
	} finally {
		for (const child of [a, b]) {
			child.kill("SIGKILL");
			await exited(child);
			leases.releaseRunLease(child.pid);
		}
	}
});

test("a lease file that is not a pid is ignored, not counted", () => {
	// A file someone else dropped in the dir, or a partially written one: a
	// Number() that came back NaN must not become a count.
	mkdirSync(join(bridge, "headless-runs"), { recursive: true });
	writeFileSync(join(bridge, "headless-runs", "not-a-pid.json"), "{", "utf-8");
	writeFileSync(join(bridge, "headless-runs", "README.txt"), "ignore me", "utf-8");
	const open = leases.countOpenHeadlessRuns();
	assert.equal(open.running, 0);
	assert.equal(open.pids.length, 0);
});

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});