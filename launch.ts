/**
 * Blender launcher for the pi extension.
 *
 * Resolution order (BLENDER_PATH may contain spaces, e.g.
 * "flatpak run --command=blender org.blender.Blender"):
 *   1. $BLENDER_PATH (whitespace-split into argv)
 *   2. /Applications/Blender.app/Contents/MacOS/Blender (macOS)
 *   3. flatpak org.blender.Blender (if `flatpak info` finds it)
 *   4. "blender" on PATH
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { getBlankBlendPath, getBlenderBridgeDir, getBundledBlankBootstrapPath, getBundledBlenderBridgePath } from "./config.js";
// isHeartbeatFresh is aliased on import because launch.ts has a local
// no-argument wrapper of the same name below; the module version takes a dir.
import { isBridgeAlive, isHeartbeatFresh as isHeartbeatFreshIn } from "./blender/liveness.js";

const DEFAULT_BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender";
const FLATPAK_BLENDER_REF = "org.blender.Blender";
// The heartbeat file name and its 10 s staleness window now live in
// blender/liveness.ts, which the instance reaper reads with the same
// constants. See HEARTBEAT_STALE_MS there for why 10 s.
/**
 * How long a just-spawned Blender gets to write its first heartbeat before the
 * launch is considered failed. A successful spawn is not proof of a UI: the
 * process can die during boot, or be killed by the OS, and the request will
 * then sit in the queue until its own timeout. On expiry the launch flag is
 * released so the next ensureLiveBridgeLaunched() retries instead of treating a
 * dead UI as "already launched" for the rest of the pi process.
 */
const LIVE_BRIDGE_LAUNCH_WATCHDOG_MS = 120_000;
/**
 * How often the supervisor re-checks the bridge while it is healthy.
 *
 * This is what makes a Blender that dies mid-session come back on its own.
 * Nothing in the tool path can notice: every tool call blocks on a bridge
 * request that will simply time out, and a request that times out is
 * indistinguishable from a slow one, so a user who closed Blender has to
 * notice the failure themselves and ask again. A supervisor turns that into
 * the next call launching a fresh UI.
 *
 * 15 s is well inside the 10 s staleness window plus one poll cycle, so a
 * transient stall is not mistaken for a death, and it costs one stat() call
 * per tick rather than a bridge request.
 */
const LIVE_BRIDGE_SUPERVISE_INTERVAL_MS = 15_000;
/**
 * Matches LIVE_BRIDGE_LOCK_STALE_MS in blender/utils.ts, and duplicated for the
 * same reason as the lock read above: importing from utils.ts here would close
 * an import cycle (utils.ts imports resolveBlenderArgv from this module).
 * The two must agree, or the supervisor will either wait out a lock the bridge
 * has already reclaimed or ignore a live one.
 */
const LIVE_BRIDGE_LOCK_STALE_MS = 600_000;

export interface BlenderArgv {
	command: string;
	args: string[];
}

let cachedArgv: Promise<BlenderArgv> | undefined;

function flatpakHasBlender(): boolean {
	try {
		const result = spawnSync("flatpak", ["info", "--show-ref", FLATPAK_BLENDER_REF], {
			timeout: 5_000,
			encoding: "utf-8",
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

export function resolveBlenderArgv(): Promise<BlenderArgv> {
	cachedArgv ??= (async () => {
		const configured = process.env.BLENDER_PATH?.trim();
		if (configured) {
			const [command, ...args] = configured.split(/\s+/).filter(Boolean);
			if (command) {
				return { command, args };
			}
		}
		if (existsSync(DEFAULT_BLENDER_PATH)) {
			return { command: DEFAULT_BLENDER_PATH, args: [] };
		}
		if (flatpakHasBlender()) {
			return { command: "flatpak", args: ["run", "--command=blender", FLATPAK_BLENDER_REF] };
		}
		return { command: "blender", args: [] };
	})();
	return cachedArgv;
}

let bridgeLaunchStarted = false;
// Set only while the spawn promise is pending, so a hung await can never
// wedge the guard forever.
let bridgeSpawnInFlight = false;
// Fires when a spawned Blender has still not written a heartbeat after the
// cold-start budget; see LIVE_BRIDGE_LAUNCH_WATCHDOG_MS.
let bridgeWatchdog: ReturnType<typeof setTimeout> | undefined;
// Re-checks the bridge while a session runs, so a Blender that dies
// mid-session is restarted instead of silently timing out the next request.
let bridgeSupervisor: ReturnType<typeof setInterval> | undefined;

function clearBridgeWatchdog(): void {
	if (bridgeWatchdog) {
		clearTimeout(bridgeWatchdog);
		bridgeWatchdog = undefined;
	}
}

function armBridgeWatchdog(): void {
	if (bridgeWatchdog) return;
	bridgeWatchdog = setTimeout(() => {
		bridgeWatchdog = undefined;
		if (isLiveBridgeAlive()) return;
		// Spawned, but never alive. Release the launch flag so a later call can
		// retry instead of trusting a Blender that is not there.
		bridgeLaunchStarted = false;
		console.error(
			`[pi-vibe-blender] warning: Blender was launched but wrote no bridge heartbeat within ${LIVE_BRIDGE_LAUNCH_WATCHDOG_MS / 1000}s. Treating the launch as failed; the next blender_* call will retry. If Blender is slow to start on this machine, raise the wait or launch it manually.`,
		);
	}, LIVE_BRIDGE_LAUNCH_WATCHDOG_MS);
	// Never hold the pi process open just to watch a Blender we already unref'd.
	bridgeWatchdog.unref?.();
}

/**
 * True when this instance's bridge is alive: a heartbeat refreshed within
 * HEARTBEAT_STALE_MS AND a pid that is still running.
 *
 * A freshly started UI that has not reached its first poll yet reports
 * not-alive — that is intentional, so the pending launch is not interrupted and
 * the request keeps its cold-start timeout budget.
 *
 * The read side of this lives in blender/liveness.ts because the instance
 * reaper needs the identical two-signal answer for OTHER dirs; duplicating it
 * here would let the two drift, and a reaper using a different staleness
 * window than the launcher would classify the same dead dir as alive.
 */
export function isLiveBridgeAlive(): boolean {
	return isBridgeAlive(getBlenderBridgeDir(), clearBridgeWatchdog);
}

/**
 * Launch the live-bridge Blender UI detached if it is not alive and no
 * launch is in flight. Safe to call repeatedly (session_start, pre-request,
 * timeout retry). Re-spawns when a previously launched UI has since been
 * closed (e.g. across /new within the same pi process).
 */
export function resetBridgeLaunch(): void {
	bridgeLaunchStarted = false;
	clearBridgeWatchdog();
}

export function ensureLiveBridgeLaunched(): void {
	if (bridgeSpawnInFlight || isLiveBridgeAlive() || bridgeLaunchStarted) return;
	launchBridge();
}

/**
 * Keep a live UI alive across the session, restarting it if it dies.
 *
 * Nothing in the tool path can notice a death on its own. Every tool call
 * blocks on a bridge request that simply times out, and a timeout is
 * indistinguishable from a slow render, so a user who closed Blender would
 * have to notice the failure themselves and ask again. A supervisor turns that
 * into the next call launching a fresh UI.
 *
 * Started once per pi process, the first time a launch is actually attempted.
 * Deliberately NOT called from session_start: a session that has never engaged
 * Blender has no heartbeat file at all, which is indistinguishable from a dead
 * bridge, so a session_start supervisor would launch a Blender UI for every pi
 * user who never asked for one — the exact thing the lazy-launch contract
 * exists to prevent. Tying it to launchBridge() means supervision begins when
 * the user engages Blender and never before.
 *
 * Restarting on a death costs a window, so the tick is deliberately lazy about
 * it. It only relaunches when nothing is holding the bridge lock, because
 * relaunching a UI while a request is in flight would put two Blenders on one
 * bridge dir — the duplicate-window race the request claim in live-bridge.py
 * exists to make harmless, but harmless is not the same as tidy. A tick that
 * finds the bridge busy simply waits for the next one.
 */
function startBridgeSupervisor(): void {
	if (bridgeSupervisor) return;
	bridgeSupervisor = setInterval(() => {
		if (isLiveBridgeAlive()) return;
		// Never resurrect a UI into a request someone is still waiting on.
		if (isBridgeLocked()) return;
		// A heartbeat this fresh means the UI is starting, not dead: the
		// watchdog owns that window and releasing the flag here would race it.
		// Deliberately mtime-only, ignoring the pid: a fresh heartbeat with a
		// dead pid is a crash, and the tick above already returned for that.
		if (isHeartbeatFresh()) return;
		resetBridgeLaunch();
		ensureLiveBridgeLaunchedForce();
	}, LIVE_BRIDGE_SUPERVISE_INTERVAL_MS);
	// Never hold the pi process open for a supervisor.
	bridgeSupervisor.unref?.();
}

/**
 * Whether a bridge request currently holds the lock.
 *
 * This duplicates the path in blender/utils.ts rather than importing
 * readBridgeLock() for two reasons: that function is async and the supervisor
 * tick is a synchronous interval, and blender/utils.ts already imports
 * resolveBlenderArgv from this module — importing back would close a cycle.
 *
 * Freshness rather than mere existence is the right test. A lock file older
 * than LIVE_BRIDGE_LOCK_STALE_MS is force-reclaimed by acquireBridgeLock, so a
 * supervisor that waited on it would refuse to relaunch a dead Blender for as
 * long as a crashed pi process left the file behind.
 */
function isBridgeLocked(): boolean {
	try {
		const mtimeMs = statSync(join(getBlenderBridgeDir(), "bridge.lock")).mtimeMs;
		return Date.now() - mtimeMs < LIVE_BRIDGE_LOCK_STALE_MS;
	} catch {
		return false;
	}
}

/** Whether the heartbeat was touched recently, ignoring the pid check. */
function isHeartbeatFresh(): boolean {
	return isHeartbeatFreshIn(getBlenderBridgeDir());
}

/**
 * Force-launch the live-bridge Blender UI, releasing this process's own
 * launch bookkeeping first.
 *
 * Used at session start and by /blender, where a Blender that is already up
 * must not be re-spawned. The liveness check is what makes that safe: it
 * reads the heartbeat file, which survives across pi processes, so a fresh
 * process that finds a live Blender leaves it alone.
 *
 * This used to skip the liveness check entirely. That was only safe while
 * bridgeLaunchStarted was set by the same process that launched, but it is
 * module state: in a new pi process it starts false, so /blender in a second
 * session spawned a SECOND Blender on the same bridge dir. Two pollers then
 * raced for the same requests, and which UI answered — and whether the scene
 * was mutated once or twice — was a race. The live-bridge.py request claim
 * now makes double execution impossible regardless, so this check is about
 * not confusing the user with a duplicate window, not about correctness.
 *
 * The stale-but-recent heartbeat case the old comment worried about is
 * already covered: isLiveBridgeAlive() only trusts a heartbeat refreshed
 * within the heartbeat staleness window, and the launch watchdog re-arms the
 * flag if the spawned Blender never writes one.
 */
export function ensureLiveBridgeLaunchedForce(): void {
	if (isLiveBridgeAlive()) return;
	if (bridgeSpawnInFlight || bridgeLaunchStarted) return;
	launchBridge();
}

function launchBridge(): void {
	bridgeLaunchStarted = true;
	bridgeSpawnInFlight = true;
	if (process.env.VIBE_BLENDER_NO_BLENDER?.trim() === "1") {
		bridgeSpawnInFlight = false;
		return;
	}
	startBridgeSupervisor();

	void (async () => {
		// Declared outside the try: the failure reporter below needs to name
		// the command it tried, and referencing a try-scoped binding there was
		// a ReferenceError waiting to happen.
		let launched: BlenderArgv | undefined;
		try {
			launched = await resolveBlenderArgv();
			const { command, args } = launched;
			const bridgeScriptPath = getBundledBlenderBridgePath();
			const bridgeDir = getBlenderBridgeDir();
			// Launch with a bootstrap script that strips the default startup
			// scene (Cube/Camera/Light) and saves a clean blank.blend, so the
			// live session starts from a saved, unsaved-changes-free scene
			// that tools can open and inspect immediately.
			const blankBootstrapPath = getBundledBlankBootstrapPath();
			const blankBlendPath = getBlankBlendPath();
			const child = spawn(command, [...args, "--python", blankBootstrapPath, blankBlendPath, "--python", bridgeScriptPath], {
				detached: true,
				env: {
					...process.env,
					PI_BLENDER_BRIDGE_DIR: bridgeDir,
					VIBE_BLENDER_BLENDER_BRIDGE_DIR: bridgeDir,
					PI_BLENDER_BLANK_BLEND_PATH: blankBlendPath,
				},
				stdio: "ignore",
			});
			// With stdio:"ignore" + unref() a failed exec is otherwise silent:
			// a bad BLENDER_PATH produces ENOENT here and nowhere else, and the
			// caller's only symptom is a timeout with no cause.
			child.on("error", (error) => {
				clearBridgeWatchdog();
				bridgeLaunchStarted = false;
				console.error(
					`[pi-vibe-blender] warning: failed to start Blender (${command} ${args.join(" ")}): ${error.message}. Fix BLENDER_PATH or install Blender; the next blender_* call will retry.`,
				);
			});
			child.unref();
			// The spawn succeeded, which is not proof of a UI: it may die before
			// its first poll. Watch for the first heartbeat.
			armBridgeWatchdog();
		} catch (error) {
			clearBridgeWatchdog();
			const message = error instanceof Error ? error.message : String(error);
			const target = launched ? `${launched.command} ${launched.args.join(" ")}`.trim() : "Blender";
			console.error(`[pi-vibe-blender] warning: failed to launch Blender (${target}): ${message}`);
			bridgeLaunchStarted = false;
		}
		finally {
			bridgeSpawnInFlight = false;
		}
	})();
}
