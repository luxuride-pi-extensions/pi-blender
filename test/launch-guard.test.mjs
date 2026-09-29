/**
 * The launch guard: a session that cannot start its bridge must say so once,
 * not reopen a window every fifteen seconds.
 *
 * The bug this exists for was live, not hypothetical. A pi session started at
 * 10:52 loaded this extension from a checkout that was renamed underneath it
 * three minutes later, so its `config.ts` still resolved
 * `/Projects/pi-vibe-blender/blender/blank-bootstrap.py`. That file no longer
 * exists. Blender was given `--python <missing>`, exited during boot without
 * writing a heartbeat, and every layer above read that as a dead bridge: the
 * watchdog released the claim and the 15 s supervisor reset and relaunched. The
 * user got a window every fifteen seconds for the rest of the session, with no
 * message naming a cause.
 *
 * How it is tested, and why it is shaped the way it is, is launch-harness.mjs's
 * job: a COPY of the launcher's import graph, driven in a CHILD process, with
 * BLENDER_PATH pointed at a shell script. Nothing here starts a real Blender.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	cleanupSandboxes,
	countLaunches,
	readDriverJson,
	runDriver,
	stageBridgeDir,
	stageExtension,
	stageFakeBlender,
} from "./launch-harness.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(REPO, "test", "launch-guard-driver.mjs");

const sandboxes = [];
after(() => {
	for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
	cleanupSandboxes();
});

/**
 * A peer's claim in the few microseconds between its create and its write.
 *
 * Mirrors what is on disk inside tryClaimLaunch between openSync(path, "wx")
 * and writeFileSync: a claim this process does not own, that is a zero-byte
 * file. This is exactly what a release from another process used to see, and
 * reading it as "unparseable, therefore mine" deleted a live peer's claim.
 */
const PEER_HALF_WRITTEN_CLAIM = "";

/** Drive the staged launcher once, in a child process. */
function launchOnce({ withScripts, subagentChild = false, seedClaim = null, seedHeartbeat = false, launched = true }) {
	const staged = stageExtension({ withScripts });
	const { path: blender, record } = stageFakeBlender();
	const bridge = stageBridgeDir();
	if (seedClaim !== null) writeFileSync(join(bridge, "launch.claim"), seedClaim);
	// A live UI in this dir, so the driver takes the ALIVE path: isLiveBridgeAlive()
	// fires the onFresh hook, which is where the launch claim is released. The
	// dead path returns before any release happens, and would pass whatever
	// releaseLaunchClaim did.
	//
	// The pid is this test process, which is trivially alive, and the mtime is
	// the write that just happened -- both signals isBridgeAlive requires.
	if (seedHeartbeat) {
		writeFileSync(join(bridge, "heartbeat"), JSON.stringify({ pid: process.pid, at: Date.now() }));
	}

	const result = runDriver(DRIVER, staged, [], { bridge, blender, subagentChild, launched });
	return { result, record, bridge, supervision: readDriverJson(result) };
}

describe("launch guard", () => {
	it("refuses to launch when a bundled script is missing, and names the path", () => {
		const { result, record } = launchOnce({ withScripts: false });

		assert.equal(existsSync(record), false, "no Blender may be started when the scripts are missing");
		assert.match(result.stderr, /not launching Blender/, "the failure must be reported, not silent");
		assert.match(result.stderr, /blank-bootstrap\.py/, "the message must name the missing file");
		assert.match(result.stderr, /Restart the pi session/, "the message must say what actually fixes it");
	});

	it("still launches, with both scripts, when the checkout is complete", () => {
		const { result, record } = launchOnce({ withScripts: true });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(record), true, "a complete checkout must still launch Blender");
		const argv = readFileSync(record, "utf-8");
		assert.match(argv, /--python \S*blank-bootstrap\.py/);
		assert.match(argv, /--python \S*live-bridge\.py/);
		assert.doesNotMatch(result.stderr, /not launching Blender/);
	});

	it("arms supervision once from a root session_start, however many times it fires", () => {
		// /reload re-fires session_start on the same session, so "arms once" is
		// the whole assertion: a second interval would relaunch in parallel with
		// the first, which is the multi-window report this supervisor exists to
		// prevent. The accessor is what makes it observable at all.
		const { supervision } = launchOnce({ withScripts: true });

		assert.deepEqual(supervision, { armedAfterFirst: true, armedAfterSecond: true });
	});

	it("a subagent child never arms supervision", () => {
		const { supervision, record } = launchOnce({ withScripts: true, subagentChild: true });

		assert.deepEqual(
			supervision,
			{ armedAfterFirst: false, armedAfterSecond: false },
			"a child has no UI lifetime to protect, so it must not watch for a dead bridge",
		);
		assert.equal(
			existsSync(record),
			false,
			"and it must not launch either, since the driver's child path skips the launch",
		);
	});

	it("leaves a peer's claim alone, including one it cannot parse", () => {
		// The claim is the only thing stopping two processes in one session
		// from each deciding nobody is launching a Blender. A release that
		// removed a claim it did not own removed the only protection the peer
		// had, and the user got a second window -- caused by the mechanism meant
		// to prevent exactly that.
		//
		// Both seeds are unreadable as JSON, which is the state the old catch
		// treated as "so it must be mine": a peer that created the file and has
		// not written to it yet, and a file truncated by a full disk. Neither is
		// evidence of ownership, so neither may be deleted on sight.
		for (const [what, seed] of [
			["a peer that has not written its claim yet", PEER_HALF_WRITTEN_CLAIM],
			["a claim truncated by a full disk", '{"pid":123, "inst'],
		]) {
			const { result, bridge } = launchOnce({
				withScripts: true,
				seedClaim: seed,
				seedHeartbeat: true,
			});

			assert.equal(result.status, 0, result.stderr);
			assert.equal(
				existsSync(join(bridge, "launch.claim")),
				true,
				`the claim must survive a release triggered by ${what}`,
			);
		}
	});
});

/**
 * The supervisor's two numeric policies — the cold-start budget and the retry
 * ceiling — are the two constants in this file nobody could assert before, and
 * both are reachable only through timers measured in minutes. The driver calls
 * the tick and the expiry directly, so what is under test is the real policy
 * and not a copy of it.
 */
describe("bridge supervisor policy", () => {
	/** Drive the supervisor against a staged bridge dir, counting launches. */
	function tick({ times, mode = "tick", withScripts = true, launched = true }) {
		const staged = stageExtension({ withScripts });
		// recordEach, so "one launch" and "a loop of them" are different
		// numbers. An overwrite recorder cannot tell a ceiling of three from
		// three hundred, which is the whole question.
		const { path: blender, record } = stageFakeBlender({ recordEach: true });
		const bridge = stageBridgeDir();
		const result = runDriver(DRIVER, staged, [mode, String(times)], { bridge, blender, launched });
		return { result, record, launches: countLaunches(record), bridge };
	}

	it("a session that has never launched a Blender launches nothing, however long it runs", () => {
		// The regression, exactly as the user met it: a fresh pi session — no
		// blender_* call, no /blender, nothing — opened a Blender window. The
		// supervisor was armed from session_start, and its tick LAUNCHES when
		// there is no heartbeat; a session that never engaged Blender has no
		// heartbeat file at all, which is indistinguishable from a dead bridge.
		//
		// "cycle" is the harshest form of this, because it also lets the
		// cold-start budget elapse on every tick: the only thing standing
		// between this and three real windows is the arming gate, so if the
		// gate were removed this would launch three times rather than zero.
		const { result, launches } = tick({ times: 40, mode: "cycle", launched: false });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(launches, 0, "nothing asked for a Blender, so nothing may start one");
		assert.doesNotMatch(
			result.stderr,
			/produced no bridge heartbeat/,
			"a launch count of zero must mean no launch was ever attempted",
		);
	});

	it("a fresh session arms no supervisor at all", () => {
		// The same gate seen from the other end. Not "it launched and then
		// relaunched" but "it never started a clock": without this, the test
		// above could still pass in an implementation that arms a supervisor
		// which then declines to act, and that is the shape a fix takes when
		// the author has only tested the one tick that matters.
		const { supervision, record } = launchOnce({ withScripts: true, launched: false });

		assert.deepEqual(
			supervision,
			{ armedAfterFirst: false, armedAfterSecond: false },
			"a session with no Blender has no UI lifetime to protect",
		);
		assert.equal(
			existsSync(record),
			false,
			"and the launch it never asked for must not have happened either",
		);
	});

	it("arms supervision after a launch, and again after a /reload", () => {
		// The regression fix had to satisfy the opposite case too, and the naive
		// way to stop the fresh-session launch is to go back to arming only when
		// this process happens to have a supervisor — which is module state, so
		// a /reload's new instance arms nothing and a Blender closed mid-session
		// stays closed. That was the original bug. The marker is written by the
		// launch and outlives the module instance, so both halves hold.
		const { supervision } = launchOnce({ withScripts: true });

		assert.deepEqual(supervision, { armedAfterFirst: true, armedAfterSecond: true });
	});

	it("does not relaunch while a launch is still inside its cold-start budget", () => {
		// A tick finds no heartbeat, which is true for the whole of the 120s
		// budget a slow Blender needs. The tick used to relaunch anyway every
		// 15s throughout, so a machine where Blender takes 40s to boot got three
		// windows instead of one -- the relaunch-loop report, still reachable
		// through the tick after the missing-script guard closed the other route.
		const { result, launches } = tick({ times: 5 });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			launches,
			1,
			"a launch that has not yet had its budget must not be joined by another",
		);
	});

	it("stops after the retry ceiling instead of relaunching forever", () => {
		// The bug the ceiling exists for: a launch that produces no heartbeat
		// is indistinguishable from a dead bridge to the tick, so without a
		// ceiling the user gets a window every 15s for the rest of the session.
		// "cycle" mode is the only way in: each tick is followed by the cold-start
		// budget elapsing, which is the state a launch that never came up leaves
		// behind — and the state the supervisor is entitled to retry.
		const { result, launches } = tick({ times: 40, mode: "cycle" });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(
			launches,
			3,
			"the ceiling is three launches, and a fourth means the loop is back",
		);
		assert.match(
			result.stderr,
			/produced no bridge heartbeat/,
			"giving up silently would look identical to a healthy session",
		);
		assert.match(result.stderr, /3 Blender launches in a row/, "and the message must name the count");
	});

	it("counts nothing when the bundled scripts are missing", () => {
		// Ordering between two guards, not between two of them and a timer: the
		// missing-asset check runs before the ceiling, so a checkout that cannot
		// launch reports that ONCE and never reaches the retry policy at all.
		const { result, launches } = tick({ times: 10, mode: "cycle", withScripts: false });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(launches, 0);
		assert.match(result.stderr, /not launching Blender/);
		assert.doesNotMatch(
			result.stderr,
			/produced no bridge heartbeat/,
			"the ceiling's message would be a second, misleading explanation",
		);
	});

	it("a supervisor left over from a /reload stands itself down", () => {
		// pi re-imports an extension with `moduleCache: false`, so /reload
		// produces a NEW module instance: a new bridgeSupervisor variable, a new
		// interval, a new failure counter. The old interval cannot be cleared by
		// the new one — stopBridgeSupervisor() only reaches the handle its own
		// instance holds — so every reload used to leak a supervisor. Each leaked
		// one had its own budget of three launches, which is how a session that
		// was reloaded a few times opened a dozen windows where it should have
		// opened none.
		//
		// A pid cannot catch it: the leaked interval belongs to this very
		// process. Ownership is a token on disk, and the leaked interval is the
		// thing that checks it, because it is the only handle anyone still has.
		const staged = stageExtension({ withScripts: true });
		const { path: blender } = stageFakeBlender();
		const bridge = stageBridgeDir();
		const result = runDriver(DRIVER, staged, ["reload"], { bridge, blender });
		const outcome = readDriverJson(result);

		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(
			outcome,
			{ armedBefore: true, armedAfter: false },
			"the interval must notice the marker changed hands and stop, not keep relaunching",
		);
	});
});
