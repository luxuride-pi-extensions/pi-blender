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

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
// Import cycle: blender/utils.ts imports resolveBlenderArgv from this module,
// so this module must not import anything from blender/utils.ts. It may still
// import from blender/reap.ts and blender/liveness.ts, which depend only on
// config.js.
import { getBlankBlendPath, getBlenderBridgeDir, getBlenderInstanceId, getBundledBlankBootstrapPath, getBundledBlenderBridgePath, writeInstanceFile } from "./config.js";
import { formatReapResult, reapOrphanedBridgeDirs } from "./blender/reap.js";
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

/**
 * How long a cross-process launch claim is honoured before it is reclaimed.
 *
 * The claim is written microseconds before the spawn, so its only job is to
 * cover the window where a Blender has been spawned but has not written its
 * first heartbeat yet — during which isLiveBridgeAlive() is false in every
 * process sharing the dir, and every one of them would otherwise launch its own
 * UI. That window is the same cold-start budget the launcher already tolerates,
 * so the claim expires with it: a process that dies between claiming and
 * spawning must not lock every other process in the session out of Blender for
 * longer than one cold start would have taken anyway.
 */
const LAUNCH_CLAIM_STALE_MS = LIVE_BRIDGE_LAUNCH_WATCHDOG_MS;

/**
 * Claim the right to start the one UI for this bridge dir, across processes.
 *
 * `bridgeLaunchStarted` is module state, and module state is per-process. Once
 * a session's processes share one bridge dir (see config.ts), that flag can no
 * longer answer "is someone already starting a Blender here" — it only answers
 * "did THIS process try". With a shared dir and a manager plus several workers
 * all issuing their first tool call within a second of each other, every one of
 * them sees no heartbeat, all of them set their own flag, and the user gets a
 * Blender per subagent. The create-exclusive claim below is the same mechanism
 * acquireBridgeLock uses, for the same reason: the create IS the lock.
 *
 * Returns false when another live process already holds it, which callers treat
 * as "someone else is on it" rather than as an error.
 */
function tryClaimLaunch(): boolean {
	const path = join(getBlenderBridgeDir(), "launch.claim");
	try {
		mkdirSync(getBlenderBridgeDir(), { recursive: true });
		const handle = openSync(path, "wx");
		try {
			// writeFileSync accepts the raw fd; only the exclusive CREATE is
			// load-bearing here, so the content does not need its own atomic
			// publish (a peer reading it mid-write sees unreadable, which
			// releaseLaunchClaim treats as "not provably someone else's").
			writeFileSync(
				handle,
				JSON.stringify({ pid: process.pid, instanceId: getBlenderInstanceId(), at: Date.now() }),
			);
		} finally {
			closeSync(handle);
		}
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EEXIST") {
			// A dir we cannot write to is a real problem, but failing the launch
			// over it would leave the user with no Blender and no explanation.
			// Fall through to launching on the in-process flag alone.
			return true;
		}
		// A claim older than the cold-start budget belongs to a process that
		// died between claiming and spawning. Reclaim it rather than blocking
		// every process in the session out of Blender indefinitely.
		try {
			if (Date.now() - statSync(path).mtimeMs > LAUNCH_CLAIM_STALE_MS) {
				rmSync(path, { force: true });
				return tryClaimLaunch();
			}
		} catch {
			// The holder released it between our EEXIST and this stat. Retrying
			// the create is the correct response to a vanished claim.
			return tryClaimLaunch();
		}
		return false;
	}
}

/**
 * Release this process's claim, and only this process's.
 *
 * The pid check matters because claims outlive individual events: a slow
 * Blender becomes alive long after the launch it was claimed for, and by then
 * the claim may have been reclaimed and re-taken by another process. Removing
 * a claim this process no longer holds would delete a live peer's, and the peer
 * would then be free to start a second UI.
 */
function releaseLaunchClaim(): void {
	const path = join(getBlenderBridgeDir(), "launch.claim");
	try {
		const holder = JSON.parse(readFileSync(path, "utf-8")) as { pid?: number };
		if (holder?.pid !== process.pid) return;
	} catch {
		// Unreadable claim: the create-time content is this process's own, and
		// an unparseable file is not evidence of someone else's claim. The
		// staleness reclaim above is what recovers a genuinely abandoned one.
	}
	rmSync(path, { force: true });
}

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
// Set once this process has claimed its instance dir and swept its siblings.
let instanceClaimed = false;

/**
 * Claim this process's instance dir and sweep its siblings, once.
 *
 * Deliberately tied to the FIRST LAUNCH rather than to session_start. A pi
 * session that never engages Blender has no business creating a directory under
 * the bridge root or enumerating the others: session_start fires for every pi
 * user in the world, and doing bridge bookkeeping there means a workspace-free
 * session leaves a directory behind and pays a sweep for it. The claim only
 * means anything once a UI exists to be claimed by, and the sweep only has work
 * to do once there are instance dirs to compare against.
 *
 * Sweep first, then claim, so this process never appears in its own sweep
 * output. The instance id is fresh per process, so there is no stale dir of
 * ours to protect — a previous process's dir is a sibling by definition, and
 * that is exactly the dir this sweep is for.
 */
async function ensureInstanceClaimed(): Promise<void> {
	if (instanceClaimed) return;
	instanceClaimed = true;
	try {
		const result = await reapOrphanedBridgeDirs();
		const summary = formatReapResult(result);
		if (summary) console.error(summary);
	} catch (error) {
		// Housekeeping over other processes' leftovers. A failure here costs a
		// stale dir, which the next launch also skips past, so it must never
		// stop this process from launching its own UI.
		console.error(
			`[pi-vibe-blender] could not sweep stale Blender instance dirs: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		writeInstanceFile();
	} catch (error) {
		console.error(
			`[pi-vibe-blender] could not record this Blender instance (${getBlenderBridgeDir()}): ${
				error instanceof Error ? error.message : String(error)
			}. Other pi instances will not be able to tell it apart from an orphan.`,
		);
	}
}

function clearBridgeWatchdog(): void {
	if (bridgeWatchdog) {
		clearTimeout(bridgeWatchdog);
		bridgeWatchdog = undefined;
	}
}

/**
 * Cleanup for the one liveness path that has work to do: a UI is confirmed
 * alive.
 *
 * The launch claim is released HERE, not only in the watchdog. The watchdog was
 * the only other thing that released it, and isLiveBridgeAlive() used to pass
 * clearBridgeWatchdog as its onFresh callback — so the very first tick after a
 * successful launch cancelled the timer whose firing would have released the
 * claim, and the claim then sat in the bridge dir for the rest of the session.
 * That is the one window it exists to close, already closed, so holding it only
 * keeps a peer out of a legitimate relaunch should this UI later die — up to
 * LAUNCH_CLAIM_STALE_MS of "someone else is starting a Blender here" for a
 * Blender that is not coming. Releasing it is safe from every caller: it only
 * ever removes THIS process's claim, and it only runs on a heartbeat that is
 * both fresh and pid-confirmed, so it cannot fire during the pre-heartbeat
 * window the claim was taken out for.
 */
function confirmBridgeLaunched(): void {
	clearBridgeWatchdog();
	releaseLaunchClaim();
}

function armBridgeWatchdog(): void {
	if (bridgeWatchdog) return;
	bridgeWatchdog = setTimeout(() => {
		bridgeWatchdog = undefined;
		if (isLiveBridgeAlive()) {
			// The UI is up. The claim has done its job — it only ever covered the
			// pre-heartbeat window — and holding it for the rest of the session
			// would keep peers out of a legitimate relaunch should Blender die.
			// confirmBridgeLaunched() has already released it by this point;
			// repeating it here keeps the watchdog correct on its own terms.
			releaseLaunchClaim();
			return;
		}
		// Spawned, but never alive. Release the launch flag so a later call can
		// retry instead of trusting a Blender that is not there.
		releaseLaunchClaim();
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
	return isBridgeAlive(getBlenderBridgeDir(), confirmBridgeLaunched);
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
	// The in-process flag is not the only thing that suppresses a launch: a
	// claim this process still holds would keep peers out even after a reset, so
	// a forced relaunch has to give the claim back too.
	releaseLaunchClaim();
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
	// Cross-process first: a peer in this session that is already starting a
	// Blender owns the launch, and this process must not add a second window.
	if (!tryClaimLaunch()) return;
	bridgeLaunchStarted = true;
	bridgeSpawnInFlight = true;
	// Claim + sweep belong to the launch, not to session_start: see
	// ensureInstanceClaimed. Fire-and-forget, and deliberately not awaited —
	// the spawn below must not wait on a sweep of other processes' dirs, and
	// the claim only has to land before a PEER looks, which is many seconds
	// away.
	void ensureInstanceClaimed();
	if (process.env.VIBE_BLENDER_NO_BLENDER?.trim() === "1") {
		// Nothing will be spawned, so the claim must not outlive this call: peers
		// would skip their own launch for a UI that is never coming.
		releaseLaunchClaim();
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
				releaseLaunchClaim();
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
			releaseLaunchClaim();
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
