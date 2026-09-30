/**
 * One launch of a staged copy of launch.ts, in a fresh process. Test-only.
 *
 *   node test/launch-guard-driver.mjs <dir containing the staged launcher>
 *
 * Prints a JSON result on stdout so the parent never has to infer anything from
 * exit codes: the guard's whole job is to NOT spawn, and "it did not spawn" is
 * not something a status code can express.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// "watch" — the /blender-watch authorization gate, at both entry points a
// tool or the supervisor can reach.
//
// The assertion that matters is not "a window appeared" but the COUNT: the
// user's rule is at most one windowed Blender, so a test that can only see
// "something launched" cannot tell a correct single launch from the relaunch
// loop this gate exists to stop. stageFakeBlender({recordEach:true}) is what
// makes the count observable.
if (process.argv[3] === "watch") {
	const launch = await loadTs(`${staged.replace(/\/$/, "")}/launch.ts`);
	const result = { unauthorizedLaunches: 0, authorizedLaunches: 0, supervisorUnauthorized: 0 };

	// 1. A session that has never run /blender-watch: the ordinary
	//    ensureLiveBridgeLaunched that every tool path goes through. markLaunched
	//    first, because otherwise there is no supervisor to arm and the test
	//    would pass for the wrong reason.
	markLaunched();
	launch.restartBridgeSupervisor();
	launch.ensureLiveBridgeLaunched();
	result.unauthorizedLaunches = await settle();

	// 2. The supervisor's relaunch path with still no authorization. A gate on
	//    only the non-force entry point would leave this one open, and a
	//    supervisor that outlasts the user closing the window is exactly the
	//    "window every fifteen seconds" bug the guard suite already covers.
	launch.onSupervisorInterval();
	await launch.whenLaunchSettled();
	result.supervisorUnauthorized = await settle();

	// 3. /blender-watch asks. requestWatchWindowLaunch is the one authorized
	//    path, and it must be the ONLY thing that turns a window on.
	await launch.requestWatchWindowLaunch();
	result.authorizedLaunches = await settle();

	// 4. A second /blender-watch must not add a second window. The window is
	//    still coming up (the fake blender writes no heartbeat), so the second
	//    call races the first; either the alive check or the authorization
	//    being idempotent is enough to hold the count, and both are needed for
	//    the count to hold once the window IS up.
	await launch.requestWatchWindowLaunch();
	result.afterSecondWatch = await settle();

	process.stdout.write(JSON.stringify(result) + "\n");
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

/** How many fake Blenders the sandbox's recorder has seen, read fresh each call. */
function launches() {
	const record = join(dirname(process.env.BLENDER_PATH), "argv.txt");
	if (!existsSync(record)) return 0;
	return readFileSync(record, "utf-8").split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * The launch count once the spawn has actually landed.
 *
 * whenLaunchSettled() waits for the launcher to finish SPAWNING, and the spawn
 * is detached — the fake Blender is a separate process that appends to its
 * record file on its own schedule. So the count read immediately after settling
 * can miss a launch that has already been started, which makes a passing test
 * a coin flip and a failing one a lie.
 *
 * Polls for STABILITY rather than for a specific number: this driver does not
 * know the answer, it reports it. A run of launches would keep moving the
 * count, so a stable reading is the only one that means "nothing more is
 * coming", and the floor duration keeps a single early read from passing as
 * stable before the first spawn has had any chance to run.
 */
async function settle({ timeoutMs = 5000, stableReads = 5, intervalMs = 40 } = {}) {
	const deadline = Date.now() + timeoutMs;
	let last = -1;
	let stable = 0;
	const floor = Date.now() + 300;
	for (;;) {
		const count = launches();
		stable = count === last ? stable + 1 : 0;
		last = count;
		if (Date.now() >= deadline) return count;
		if (stable >= stableReads && Date.now() >= floor) return count;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
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
