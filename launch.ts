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

const DEFAULT_BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender";
const FLATPAK_BLENDER_REF = "org.blender.Blender";
// The live bridge writes this file every poll cycle (0.5 s). A stale or
// missing heartbeat means the UI is gone, so the launch guard can re-spawn
// (memory alone cannot know — the module state survives /new within one
// pi process). 10 s of silence counts as gone: short enough to detect a
// UI closed at session start even when it was closed moments ago, long
// enough to survive brief main-thread blocks (modal dialogs) without
// false positives.
const LIVE_BRIDGE_HEARTBEAT_FILE = "heartbeat";
// 10 s: short enough to detect a closed Blender at session start even
// when it was closed moments ago, long enough to survive brief main-
// thread blocks (modal dialogs, quick renders) without false positives.
const LIVE_BRIDGE_HEARTBEAT_STALE_MS = 10_000;
/**
 * How long a just-spawned Blender gets to write its first heartbeat before the
 * launch is considered failed. A successful spawn is not proof of a UI: the
 * process can die during boot, or be killed by the OS, and the request will
 * then sit in the queue until its own timeout. On expiry the launch flag is
 * released so the next ensureLiveBridgeLaunched() retries instead of treating a
 * dead UI as "already launched" for the rest of the pi process.
 */
const LIVE_BRIDGE_LAUNCH_WATCHDOG_MS = 120_000;

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
 * True when the heartbeat file (touched by live-bridge.py every poll cycle)
 * was refreshed within LIVE_BRIDGE_HEARTBEAT_STALE_MS. A freshly started
 * UI that has not reached its first poll yet reports not-alive — that is
 * intentional, so the pending launch is not interrupted and the request
 * keeps its cold-start timeout budget.
 */
export function isLiveBridgeAlive(): boolean {
	try {
		const mtimeMs = statSync(join(getBlenderBridgeDir(), LIVE_BRIDGE_HEARTBEAT_FILE)).mtimeMs;
		if (Date.now() - mtimeMs < LIVE_BRIDGE_HEARTBEAT_STALE_MS) {
			clearBridgeWatchdog();
			return true;
		}
		return false;
	} catch {
		return false;
	}
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
 * within LIVE_BRIDGE_HEARTBEAT_STALE_MS, and the launch watchdog re-arms the
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
