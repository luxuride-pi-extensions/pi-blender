/**
 * The reclaim's ATOMICITY, which lock-liveness.test.mjs does not cover.
 *
 * That file pins the POLICY -- when a lock may be taken away from its holder.
 * This one pins what happens in the gap between that decision and the unlink
 * that acts on it, which is a different property and was, until the reclaim
 * became conditional, a live bug on all three disk locks:
 *
 *   T1 (waiter)   open(lock, "wx") -> EEXIST, reads holder pid 999999, dead
 *   T2 (holder)   release() -> unlink
 *   T3 (waiter)   open(lock, "wx") -> success, writes ITS OWN live lock
 *   T1            rm(lock, force) -> deletes T3's lock
 *
 * T1 then loops, creates a lock of its own, and returns "acquired" while T3
 * also holds it. On the bridge lock that is two concurrent requests against
 * the one live Blender UI, which is the exact overlap the lock exists to
 * prevent; on the manifest lock it is two read-modify-write passes over one
 * file; on the apply lock it is two applies against one model.blend.
 *
 * The window is a few microseconds wide, so the race is INJECTED rather than
 * hoped for: setBeforeReclaimHookForTests() stands T2 and T3 up at the one
 * instant a test can reach deterministically -- after the judgement, before the
 * quarantine rename. Without the conditional reclaim the assertions below fail
 * (T1 wins the lock and T3's lock is gone); with it, T1 backs off and leaves
 * T3's lock in place.
 *
 * Both modules are loaded through ONE jiti instance on purpose: the hook is
 * module state in lock-reclaim.ts, and utils.ts reaches it through its own
 * import. Two separate loadTs() calls would be two isolated module graphs and
 * the hook would never fire -- a green test that proved nothing.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JITI } from "./paths.mjs";

const { createJiti } = await import(JITI);

/** A fresh bridge dir and a jiti graph whose modules share one lock-reclaim. */
async function harness(name) {
	const root = mkdtempSync(join(tmpdir(), `pi-blender-${name}-`));
	process.env.PI_BLENDER_BRIDGE_DIR = root;
	const jiti = createJiti(import.meta.url, { isolated: true, interopDefault: true });
	const utils = await jiti.import("../blender/utils.ts");
	const reclaim = await jiti.import("../blender/lock-reclaim.ts");
	return {
		root,
		lockPath: join(root, "bridge.lock"),
		acquireBridgeLock: utils.acquireBridgeLock,
		reclaimLockIfUnchanged: reclaim.reclaimLockIfUnchanged,
		setHook: reclaim.setBeforeReclaimHookForTests,
		quarantines: () => readdirSync(root).filter((name) => name.includes(".reclaim-")),
	};
}

/** A pid the kernel has already stopped vouching for. */
async function deadPid() {
	const child = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	await new Promise((done) => child.once("spawn", done));
	child.kill("SIGKILL");
	await new Promise((done) => child.once("exit", done));
	return child.pid;
}

test.afterEach(() => {
	rmSync(process.env.PI_BLENDER_BRIDGE_DIR, { recursive: true, force: true });
	delete process.env.PI_BLENDER_BRIDGE_DIR;
});

test("a lock that was already replaced is restored, not deleted", async () => {
	const { lockPath, reclaimLockIfUnchanged, quarantines } = await harness("reclaim-mismatch");
	const judged = JSON.stringify({ pid: await deadPid(), label: "crashed" });
	const live = JSON.stringify({ pid: process.pid, label: "third waiter" });
	writeFileSync(lockPath, live);

	assert.equal(await reclaimLockIfUnchanged(lockPath, judged), false, "a lock this process never judged was removed");
	assert.equal(readFileSync(lockPath, "utf-8"), live, "the third waiter's lock was not put back");
	assert.deepEqual(quarantines(), [], "a quarantine file was left behind after the restore");
});

test("the lock this process judged is removed", async () => {
	const { lockPath, reclaimLockIfUnchanged, quarantines } = await harness("reclaim-match");
	const judged = JSON.stringify({ pid: await deadPid(), label: "crashed" });
	writeFileSync(lockPath, judged);

	assert.equal(await reclaimLockIfUnchanged(lockPath, judged), true);
	assert.equal(existsAfter(lockPath), false, "the judged lock survived its reclaim");
	assert.deepEqual(quarantines(), [], "a quarantine file was left behind after a successful reclaim");
});

test("a lock that is already gone is not an error", async () => {
	const { lockPath, reclaimLockIfUnchanged } = await harness("reclaim-missing");
	assert.equal(await reclaimLockIfUnchanged(lockPath, JSON.stringify({ pid: await deadPid() })), false);
	assert.equal(existsAfter(lockPath), false);
});

test("a waiter cannot take a lock created by a third party after it judged the holder dead", async () => {
	// The interleaving from this file's header, injected at the reachable instant.
	const { lockPath, acquireBridgeLock, setHook, quarantines } = await harness("reclaim-race");
	const dead = await deadPid();
	const judged = JSON.stringify({ pid: dead, label: "crashed" });
	const thirdParty = JSON.stringify({ pid: process.pid, label: "third waiter" });
	writeFileSync(lockPath, judged);

	let injected = false;
	setHook(async () => {
		// T2 releases, then T3 creates. T1 has already read `judged` and is about
		// to unlink; it must not touch what is there now.
		rmSync(lockPath, { force: true });
		writeFileSync(lockPath, thirdParty);
		injected = true;
	});

	try {
		await assert.rejects(
			() => acquireBridgeLock({ timeoutMs: 300 }),
			/Timed out after .* waiting for the live Blender bridge lock/,
			"the waiter took a lock it had judged reclaimable, which is the race this test exists for",
		);
	} finally {
		setHook();
	}

	assert.equal(injected, true, "the race was never injected, so nothing was proven");
	// The third waiter's lock survived, byte for byte.
	assert.equal(readFileSync(lockPath, "utf-8"), thirdParty, "the third waiter's lock was deleted by a reclaim that judged a different lock");
	assert.deepEqual(quarantines(), [], "a quarantine file was left behind");
});

test("a holder that releases on its own is not treated as a reclaim target", async () => {
	// The benign version of the same interleaving: no third party appears, the
	// judged file simply disappears, and the waiter takes the lock normally
	// rather than waiting out its deadline.
	const { lockPath, acquireBridgeLock, setHook } = await harness("reclaim-vanished");
	writeFileSync(lockPath, JSON.stringify({ pid: await deadPid(), label: "crashed" }));

	setHook(() => {
		rmSync(lockPath, { force: true });
	});

	try {
		const lock = await acquireBridgeLock({ timeoutMs: 2_000 });
		assert.equal(JSON.parse(readFileSync(lockPath, "utf-8")).pid, process.pid);
		await lock.release();
	} finally {
		setHook();
	}
});

function existsAfter(path) {
	try {
		readFileSync(path);
		return true;
	} catch {
		return false;
	}
}