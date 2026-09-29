/**
 * One launch of a staged copy of launch.ts, in a fresh process. Test-only.
 *
 *   node test/launch-guard-driver.mjs <dir containing the staged launcher>
 *
 * Prints a JSON result on stdout so the parent never has to infer anything from
 * exit codes: the guard's whole job is to NOT spawn, and "it did not spawn" is
 * not something a status code can express.
 */

import { mkdirSync, writeFileSync } from "node:fs";
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
	markLaunched();
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
	// Both modes go through the REAL entry points — restartBridgeSupervisor
	// to arm, then onSupervisorInterval to tick — rather than calling
	// runBridgeSupervisorTick directly. That indirection is the whole subject
	// of the gate: the tick is only ever reached from an interval, and an
	// interval only exists once restartBridgeSupervisor has decided this
	// session wants one. Driving the tick directly tests a state no session can
	// be in, and it passes or fails for reasons that have nothing to do with
	// what a user experiences.
	if (process.env.LAUNCH !== "0") markLaunched();
	launch.restartBridgeSupervisor();
	const armed = launch.isBridgeSupervisorRunning();
	for (let i = 0; i < ticks; i++) {
		launch.onSupervisorInterval();
		// Wait on the spawn itself, not on a guess about how long it takes. A
		// sleep here is the reason this mode used to take forty seconds: 300ms
		// per tick to let an argv resolution finish, fifty more for the
		// watchdog. whenLaunchSettled is a couple of file writes.
		await launch.whenLaunchSettled();
		if (mode === "cycle") launch.onBridgeWatchdogExpired();
	}
	process.stdout.write(JSON.stringify({ mode, ticks, armed }) + "\n");
	process.exit(0);
}

// Long enough for a successful spawn to be observable, short enough that a test
// suite stays fast. Nothing waits for a heartbeat: the question is whether a
// process was started, not whether Blender answered.
const launch = await loadTs(`${staged.replace(/\/$/, "")}/launch.ts`);

// With PI_SUBAGENT_CHILD=1 the supervisor must NOT be armed by a session_start,
// because a child has no UI lifetime to protect. With it unset, a session that
// has LAUNCHED a Blender must arm exactly one — and calling it twice must still
// leave exactly one, which is only observable through the accessor, since a
// second interval would simply be a second interval.
//
// Whether a Blender was launched first is a fact about the session, and the
// harness passes it in rather than inferring it, so the two cases cannot be
// conflated: LAUNCH=0 models the fresh session that must not arm at all, which
// is the regression this gate exists for.
const child = process.env.PI_SUBAGENT_CHILD === "1";
if (process.env.LAUNCH !== "0") markLaunched();
if (!child) launch.restartBridgeSupervisor();
const armedAfterFirst = launch.isBridgeSupervisorRunning();
launch.restartBridgeSupervisor();
const armedAfterSecond = launch.isBridgeSupervisorRunning();

ensureLaunched();
// Same rule as the tick loop: wait on the launch, not on a duration. The
// former 1500ms wait existed only because there was no way to know when the
// spawn had been written, and it was paid by every single-arming test.
await launch.whenLaunchSettled();
process.stdout.write(
	JSON.stringify({ armedAfterFirst, armedAfterSecond }) + "\n",
);
process.exit(0);

/**
 * Record that this session's bridge dir belongs to a launch that produced a
 * Blender. This is what launchBridge() does after a successful spawn, written
 * the same way, because asking the real spawn to do it here would mean waiting
 * on a real Blender.
 */
function markLaunched() {
	const dir = process.env.PI_BLENDER_BRIDGE_DIR;
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "supervise.want"), JSON.stringify({ pid: process.pid, at: Date.now() }), "utf-8");
}

/** The launch itself, behind the child's opt-out, mirroring the real call site. */
function ensureLaunched() {
	if (child) return;
	// LAUNCH=0 models a session that has never called a blender_* tool, so
	// there is no launch to perform. Calling ensureLiveBridgeLaunchedForce()
	// here would be the driver inventing a request the user never made, and the
	// spawn it causes would then be read as the extension misbehaving.
	if (process.env.LAUNCH === "0") return;
	launch.ensureLiveBridgeLaunchedForce();
}
