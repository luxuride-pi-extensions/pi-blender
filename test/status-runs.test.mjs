/**
 * The open-run count, as reported by blender_bridge_status.
 *
 * The status tool is the only surface the user asked for the count on, and it
 * is the surface most able to answer it wrongly: a `running` field that reports
 * the gate's own in-flight number would be right in exactly the case nobody
 * asks about (a single process with no fan-out) and zero in the case they do
 * (a manager asking what its four workers are doing).
 *
 * So this asserts the thing the field is FOR — a run started by another process
 * in the same session is visible here — rather than that the number is
 * incremented somewhere.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const root = mkdtempSync(join(tmpdir(), "pi-blender-status-"));

function statusEnv(extra = {}) {
	const bridge = join(root, `bridge-${Math.random().toString(36).slice(2, 10)}`);
	mkdirSync(bridge, { recursive: true });
	return { bridge, env: { PI_BLENDER_BRIDGE_DIR: bridge, ...extra } };
}

test("with nothing open, the status says zero and names no pids", async () => {
	const { env } = statusEnv();
	const { blenderBridgeStatus } = await loadTs("../blender/status.ts", env);
	const status = await blenderBridgeStatus({});
	assert.equal(status.headless.running, 0);
	assert.deepEqual(status.headless.pids, []);
	assert.equal(status.headless.staleSwept, 0);
	assert.match(status.recommendation, /0 headless Blenders open now/);
});

test("a run leased by ANOTHER process in the session is counted here", async () => {
	// This is the whole reason leases are files. A counter in process memory
	// would report zero for a manager watching its workers, which is the case
	// the count exists for.
	const { env } = statusEnv();
	const leases = await loadTs("../blender/run-leases.ts", env);
	const other = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	try {
		leases.acquireRunLease(other.pid, "branch run rig");
		const { blenderBridgeStatus } = await loadTs("../blender/status.ts", env);
		const status = await blenderBridgeStatus({});
		assert.equal(status.headless.running, 1, "another process's run must be visible to this one");
		assert.deepEqual(status.headless.pids, [other.pid]);
		assert.match(status.recommendation, /1 headless Blender open now/);
	} finally {
		other.kill("SIGKILL");
		rmSync(join(env.PI_BLENDER_BRIDGE_DIR, "headless-runs", `${other.pid}.json`), { force: true });
	}
});

test("the watch window is reported apart from the runs, never inside the count", async () => {
	const { env } = statusEnv();
	const bridge = env.PI_BLENDER_BRIDGE_DIR;
	// The window is authorized and a lease exists: exactly the state where
	// folding the two together would under-count the runs by one.
	writeFileSync(join(bridge, "watch-window.json"), `${Date.now()}\n`, "utf-8");
	const leases = await loadTs("../blender/run-leases.ts", env);
	const other = spawn(process.execPath, ["-e", "process.stdin.resume()"], { stdio: ["pipe", "ignore", "ignore"] });
	try {
		leases.acquireRunLease(other.pid, "branch run body");
		const { blenderBridgeStatus } = await loadTs("../blender/status.ts", env);
		const status = await blenderBridgeStatus({});
		assert.equal(status.headless.running, 1, "the window is not a budgeted run and must not be counted as one");
		assert.equal(status.headless.watchWindowOpen, true);
		assert.ok(status.headless.watchWindowRssBytes > 0, "a projection is reported so the claim can be weighed, even though it is not a measured figure");
		assert.match(status.recommendation, /watch window is open/);
		assert.match(status.recommendation, /counted apart from the runs/);
	} finally {
		other.kill("SIGKILL");
		rmSync(join(bridge, "headless-runs", `${other.pid}.json`), { force: true });
	}
});

test("no window marker means the status does not claim one", async () => {
	const { env } = statusEnv();
	const { blenderBridgeStatus } = await loadTs("../blender/status.ts", env);
	const status = await blenderBridgeStatus({});
	assert.equal(status.headless.watchWindowOpen, false);
	assert.doesNotMatch(status.recommendation, /watch window is open/);
});

test("the recommendation states the open count next to the ceiling", async () => {
	// The two numbers answer different questions and reading only one of them is
	// the mistake: "4 at once" says what is permitted, "1 open" says what is
	// happening. A caller who sees the budget alone cannot tell a quiet machine
	// from a saturated one.
	const { env } = statusEnv();
	const { blenderBridgeStatus } = await loadTs("../blender/status.ts", env);
	const status = await blenderBridgeStatus({});
	assert.match(status.recommendation, new RegExp(`${status.headless.effective} slots?`), "the ceiling belongs in the same sentence as the count");
	// The number after "against" is the ceiling again, and it is read back out
	// of the same status object rather than written out as a literal. A literal
	// "slots" was wrong twice over: the string is the plural of whatever the
	// ceiling resolved to, so on a machine whose ceiling clamps to 1 the code
	// says "1 slot" and a fixed plural never matches. That is the whole reason
	// this suite has to name its numbers from the status rather than type them.
	assert.match(status.recommendation, new RegExp(`0 headless Blenders open now against ${status.headless.effective} slots?`));
});

test.after(() => {
	rmSync(root, { recursive: true, force: true });
	// A lease left by a killed child would name a pid that may have been reused.
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });
});