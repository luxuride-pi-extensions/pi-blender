/**
 * One launch of a staged copy of launch.ts, in a fresh process. Test-only.
 *
 *   node test/launch-guard-driver.mjs <dir containing the staged launcher>
 *
 * Prints a JSON result on stdout so the parent never has to infer anything from
 * exit codes: the guard's whole job is to NOT spawn, and "it did not spawn" is
 * not something a status code can express.
 */

import { loadTs } from "./paths.mjs";

const staged = process.argv[2];
if (!staged) {
	console.error("usage: node test/launch-guard-driver.mjs <staged-dir>");
	process.exit(2);
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
