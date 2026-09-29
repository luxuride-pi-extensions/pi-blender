/**
 * One launch of a staged copy of launch.ts, in a fresh process. Test-only.
 *
 *   node test/launch-guard-driver.mjs <dir containing the staged launcher>
 *
 * Prints a JSON result on stdout so the parent never has to infer anything from
 * exit codes: the guard's whole job is to NOT spawn, and "it did not spawn" is
 * not something a status code can express.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTs } from "./paths.mjs";

const staged = process.argv[2];
if (!staged) {
	console.error("usage: node test/launch-guard-driver.mjs <staged-dir>");
	process.exit(2);
}

// "tick <n>" drives the supervisor's decision directly instead of waiting for
// the interval, which exists so the gates below are testable in milliseconds
// rather than in fifteen-second steps. launch-harness.mjs documents why the
// whole thing runs in a child process.
// "reload" — arm supervision, then have someone ELSE take the marker, then
// turn the interval. The only faithful model of what `/reload` does to this
// module: pi re-imports with moduleCache:false, so the new instance arms its
// own supervisor and writes its own token, and this instance's interval keeps
// running with nothing pointing at it. In one process that is two module
// instances' worth of state, which is why jiti's per-instance cache makes an
// in-process harness useless for exactly this test.
if (process.argv[3] === "reload") {
	const launch = await loadTs(`${staged.replace(/\/$/, "")}/launch.ts`);
	launch.restartBridgeSupervisor();
	const armedBefore = launch.isBridgeSupervisorRunning();
	// A newer instance's token, written the way startBridgeSupervisor writes
	// its own: same pid (it is the same OS process), different token.
	writeFileSync(
		join(process.env.PI_BLENDER_BRIDGE_DIR, "supervisor.owner"),
		JSON.stringify({ pid: process.pid, token: "a-newer-instance", at: Date.now() }),
	);
	const launchesBefore = Number(process.argv[5] ?? 2);
	for (let i = 0; i < launchesBefore; i++) launch.onSupervisorInterval();
	process.stdout.write(
		JSON.stringify({
			armedBefore,
			// The whole point: an interval that has lost the marker must stand
			// itself down rather than keep relaunching beside the new one.
			armedAfter: launch.isBridgeSupervisorRunning(),
		}) + "\n",
	);
	process.exit(0);
}

if (process.argv[3] === "tick" || process.argv[3] === "cycle") {
	// "tick"  — supervisor decisions only, with the cold-start budget left to
	//            run out in real time. Correct for the cold-start gate, and the
	//            reason that gate is testable at all: without it a 120s budget
	//            cannot be observed inside a suite.
	// "cycle" — each tick followed by the watchdog expiring, which is what a
	//            real cold-start budget elapsing looks like. The retry ceiling is
	//            only reachable through this: with the budget genuinely pending,
	//            no number of ticks can get past the first launch, because that
	//            is precisely what the gate is for.
	//
	// Both call the real functions. The point of the split is to choose which
	// part of the clock is under the test's control, not to reimplement either.
	const mode = process.argv[3];
	const launch = await loadTs(`${staged.replace(/\/$/, "")}/launch.ts`);
	const ticks = Number(process.argv[4] ?? 1);
	// The spawn is async (argv resolution, then the detached child), so each
	// tick has to let the previous one finish or they all collapse into one
	// and the count is a lie.
	for (let i = 0; i < ticks; i++) {
		launch.runBridgeSupervisorTick();
		await new Promise((resolve) => setTimeout(resolve, 300));
		if (mode === "cycle") {
			launch.onBridgeWatchdogExpired();
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}
	process.stdout.write(JSON.stringify({ mode, ticks }) + "\n");
	process.exit(0);
}

// Long enough for a successful spawn to be observable, short enough that a test
// suite stays fast. Nothing waits for a heartbeat: the question is whether a
// process was started, not whether Blender answered.
const launch = await loadTs(`${staged.replace(/\/$/, "")}/launch.ts`);

// With PI_SUBAGENT_CHILD=1 the supervisor must NOT be armed by a session_start,
// because a child has no UI lifetime to protect. With it unset, a session_start
// MUST arm one, and calling it twice must still leave exactly one -- which is
// only observable through the accessor, since a second interval would simply
// be a second interval.
const child = process.env.PI_SUBAGENT_CHILD === "1";
if (!child) launch.restartBridgeSupervisor();
const armedAfterFirst = launch.isBridgeSupervisorRunning();
launch.restartBridgeSupervisor();
const armedAfterSecond = launch.isBridgeSupervisorRunning();

ensureLaunched();
await new Promise((resolve) => setTimeout(resolve, 1500));
process.stdout.write(
	JSON.stringify({ armedAfterFirst, armedAfterSecond }) + "\n",
);
process.exit(0);

/** The launch itself, behind the child's opt-out, mirroring the real call site. */
function ensureLaunched() {
	if (child) return;
	launch.ensureLiveBridgeLaunchedForce();
}
