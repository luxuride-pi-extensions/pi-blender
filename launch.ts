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
import { randomUUID } from "node:crypto";
// Import cycle: blender/utils.ts imports resolveBlenderArgv from this module,
// so this module must not import anything from blender/utils.ts. It may still
// import from blender/reap.ts and blender/liveness.ts, which depend only on
// config.js.
import { getBlankBlendPath, getBlenderBridgeDir, getBlenderInstanceId, getBundledBlankBootstrapPath, getBundledBlenderBridgePath, writeInstanceFile } from "./config.js";
import { formatBlankReapResult, formatReapResult, reapOrphanedBridgeDirs, reapStaleBlankBlends } from "./blender/reap.js";
// isHeartbeatFresh is aliased on import because launch.ts has a local
// no-argument wrapper of the same name below; the module version takes a dir.
import { isBridgeAlive, isHeartbeatFresh as isHeartbeatFreshIn, LIVE_BRIDGE_LAUNCH_WATCHDOG_MS } from "./blender/liveness.js";

const DEFAULT_BLENDER_PATH = "/Applications/Blender.app/Contents/MacOS/Blender";
const FLATPAK_BLENDER_REF = "org.blender.Blender";
// The heartbeat file name and its 10 s staleness window now live in
// blender/liveness.ts, which the instance reaper reads with the same
// constants. See HEARTBEAT_STALE_MS there for why 10 s.
/**
 * How long a just-spawned Blender gets to write its first heartbeat before the
 * launch is considered failed.
 *
 * The value lives in blender/liveness.ts and is imported above, because the
 * instance reaper needs the same number to judge how long an unowned dir may sit
 * before it is certainly abandoned, and an import cycle (utils.ts -> launch.ts)
 * means one of the two has to reach sideways. See the constant's own comment.
 */
/** How often the supervisor re-checks the bridge while it is healthy.
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
 * The marker that records "this session asked for a windowed Blender".
 *
 * See isWatchWindowAuthorized for why this is a file and not a module flag.
 */
const WATCH_WINDOW_AUTHORIZED_FILE = "watch-window.json";
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
	} catch (error) {
		// A claim file that does not exist is the common case and the correct
		// one to fall through on: rmSync below is a no-op.
		//
		// A claim that EXISTS but cannot be parsed is a different thing, and it
		// used to be treated the same way -- which deleted a peer's live claim.
		// tryClaimLaunch creates the file with openSync(path, "wx") and only
		// then writes the JSON, so for the few microseconds in between a peer
		// reading it sees an empty file, JSON.parse throws, and this process
		// removed the claim of a process that was about to spawn. The peer then
		// spawned, and so did we: two windows, which is the single thing the
		// claim exists to prevent, caused by the mechanism meant to prevent it.
		//
		// So an unparseable claim is left alone. The cost of being conservative
		// is that this process does not release a claim it is not sure of
		// holding, and the staleness reclaim in tryClaimLaunch still clears an
		// abandoned one after one cold-start budget. That is the right trade:
		// a late launch costs nothing, a duplicate window costs the user their
		// Blender session.
		//
		// ENOENT is the only error that means "there is nothing here". Checked
		// against the code rather than the error's shape because a parse failure
		// is a SyntaxError, which has no code at all -- testing for the absence
		// of a code, as an earlier version of this did, treats every parse
		// failure as ENOENT and deletes exactly the claim it was written to
		// protect.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
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

export const BLENDER_VERSION_FLOOR = "4.2.0";

export function parseBlenderVersion(output: string): string | null {
	const match = output.match(/Blender\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/i);
	return match?.[1] ?? null;
}

export function isBlenderVersionSufficient(version: string, floor = BLENDER_VERSION_FLOOR): boolean {
	const parse = (v: string): [number, number, number] => {
		const parts = v.split(".").map((n) => parseInt(n, 10) || 0);
		return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
	};
	const [vMaj, vMin, vPatch] = parse(version);
	const [fMaj, fMin, fPatch] = parse(floor);
	if (vMaj !== fMaj) return vMaj > fMaj;
	if (vMin !== fMin) return vMin > fMin;
	return vPatch >= fPatch;
}

export function assertBlenderVersionFloor(versionOutput: string, commandDescription: string): string {
	const version = parseBlenderVersion(versionOutput);
	if (!version) {
		throw new Error(
			`Could not parse Blender version from '${commandDescription} --version':\n${versionOutput.trim()}`,
		);
	}
	if (!isBlenderVersionSufficient(version, BLENDER_VERSION_FLOOR)) {
		throw new Error(
			`Blender version ${version} found at '${commandDescription}', but pi-blender requires Blender >= ${BLENDER_VERSION_FLOOR} (Blender 4.2 LTS or later).\n` +
				`Earlier versions lack required APIs (such as EEVEE-Next, modern OBJ/STL exporters). Please upgrade Blender or set BLENDER_PATH to a supported build.`,
		);
	}
	return version;
}

export function clearCachedBlenderArgv(): void {
	cachedArgv = undefined;
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
// Set once the bundled scripts a launch needs turned out to be missing on
// disk. See assertLaunchAssetsAvailable.
let launchAssetsMissing = false;
// Launches, back to back, that produced no heartbeat. See
// MAX_CONSECUTIVE_FAILED_LAUNCHES.
let consecutiveFailedLaunches = 0;
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
 * output. Every OTHER instance id is a sibling by definition, and that is
 * exactly what this sweep is for: the id is inherited through the environment
 * across a delegation tree, so a worker reuses the root session's dir rather
 * than minting a new one.
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
			`[pi-blender] could not sweep stale Blender instance dirs: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		// After the bridge sweep, because a bootstrap blend is judged abandoned
		// by the liveness of the bridge dir its instance id names.
		const blanks = await reapStaleBlankBlends();
		const blankSummary = formatBlankReapResult(blanks);
		if (blankSummary) console.error(blankSummary);
	} catch (error) {
		console.error(
			`[pi-blender] could not sweep stale bootstrap blends: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	try {
		writeInstanceFile();
	} catch (error) {
		console.error(
			`[pi-blender] could not record this Blender instance (${getBlenderBridgeDir()}): ${
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
	// A heartbeat that is both fresh and pid-confirmed is proof the launch
	// worked, so the failure run is over. Resetting here rather than anywhere
	// else is deliberate: the counter has to survive resetBridgeLaunch(), which
	// the supervisor calls immediately before every retry, or the backoff below
	// would reset itself on the tick that is meant to be counted.
	consecutiveFailedLaunches = 0;
}

/**
 * The bundled scripts a launch feeds to Blender, or null when they are all
 * present.
 *
 * This exists because a launch can fail in a way that looks exactly like a
 * Blender that will not start. Blender is given `--python <bootstrap>
 * <blank.blend> --python <bridge>`, and if either path does not exist Blender
 * exits during boot without writing a heartbeat. Every layer above then reads
 * that as a dead bridge: the watchdog releases the claim, and the 15 s
 * supervisor resets and relaunches. The user gets a window every fifteen
 * seconds for as long as the session lives, with no error naming a cause.
 *
 * The cause is always an installation that no longer matches the code asking
 * for it — a repository renamed under a running session, a partial checkout, a
 * deploy that dropped the .py files. It is not transient, so retrying cannot
 * fix it, and the honest behaviour is to say so once and stop.
 */
function missingLaunchAsset(): string | undefined {
	for (const path of [getBundledBlankBootstrapPath(), getBundledBlenderBridgePath()]) {
		if (!existsSync(path)) return path;
	}
	return undefined;
}

/**
 * Refuse a launch whose scripts are not on disk, at most once per process.
 *
 * Checked synchronously before the spawn, and cached, so the supervisor does
 * not re-stat two files every fifteen seconds for the rest of the session. The
 * cache is what makes this a fix rather than a delay: without it, every tick
 * would pass the check as soon as the file came back, which is correct — but
 * the failure mode we are closing is a loop that never ends, and a loop that
 * could be resumed by a well-meaning repair is a loop that hides the repair.
 */
function assertLaunchAssetsAvailable(): boolean {
	if (launchAssetsMissing) return false;
	const missing = missingLaunchAsset();
	if (!missing) return true;
	launchAssetsMissing = true;
	stopBridgeSupervisor();
	console.error(
		`[pi-blender] not launching Blender: the bundled script ${missing} does not exist. ` +
			"This extension cannot start its bridge, and retrying would reopen a window every " +
			`${LIVE_BRIDGE_SUPERVISE_INTERVAL_MS / 1000}s for the rest of the session without ever working. ` +
			"Usually this means the checkout was renamed, moved, or updated while a pi session was already " +
			"running with the old path resolved. Restart the pi session so it loads the current extension, " +
			"then run a blender_* tool again.",
	);
	return false;
}

/**
 * What happens when a launch produced no heartbeat within the cold-start budget.
 *
 * Named rather than left as an inline arrow for two reasons, both about the
 * tests rather than the code: the timeout body is the only thing that can
 * advance the failure counter, and a counter that is only advanced by a
 * 120-second timer makes the retry ceiling untestable in a suite that should
 * run in seconds. A named function the driver can call is the difference
 * between "the ceiling is three" being an assertion and being a comment.
 *
 * It is also the single definition of what a failed launch means. The counter
 * is reset in confirmBridgeLaunched() and nowhere else, deliberately: the
 * supervisor calls resetBridgeLaunch() immediately before every retry, so a
 * reset there would clear the very run the ceiling is counting.
 */
export function onBridgeWatchdogExpired(): void {
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
	consecutiveFailedLaunches += 1;
	console.error(
		`[pi-blender] warning: Blender was launched but wrote no bridge heartbeat within ${LIVE_BRIDGE_LAUNCH_WATCHDOG_MS / 1000}s. Treating the launch as failed; the next blender_* call will retry. If Blender is slow to start on this machine, raise the wait or launch it manually.`,
	);
}

function armBridgeWatchdog(): void {
	if (bridgeWatchdog) return;
	bridgeWatchdog = setTimeout(onBridgeWatchdogExpired, LIVE_BRIDGE_LAUNCH_WATCHDOG_MS);
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

/**
 * Launch the live-bridge Blender UI detached if it is not alive and no
 * launch is in flight. Safe to call repeatedly (session_start, pre-request,
 * timeout retry). Re-spawns when a previously launched UI has since been
 * closed (e.g. across /new within the same pi process).
 *
 * GATED ON /blender-watch HAVING ASKED FOR A WINDOW. See
 * isWatchWindowAuthorized. This is the chokepoint every tool path goes
 * through, so the gate is here rather than at the call sites: a gate only
 * some callers remember is not a gate.
 */
export function ensureLiveBridgeLaunched(): void {
	if (bridgeSpawnInFlight || isLiveBridgeAlive() || bridgeLaunchStarted) return;
	if (!isWatchWindowAuthorized()) return;
	launchBridge();
}

/**
 * Whether this session has authorized a windowed Blender at all.
 *
 * The rule is deliberately narrow: a window exists if and only if /blender-watch
 * asked for one. A tool call must not bring a UI up behind the user's back, and
 * neither may the supervisor.
 *
 * Recorded durably rather than in module state, because /reload rebuilds this
 * module instance while the window it launched keeps running: a flag on `this`
 * would read false in the fresh instance and the next blender_* call would treat
 * a window the user is watching as unauthorized, then launch a second one. The
 * marker is per-instance by design (config.ts gives every process in a
 * delegation tree the SAME instance id, so a manager and its workers share one
 * window rather than each opening their own), which is what "at most one window
 * per session" needs.
 */
export function isWatchWindowAuthorized(): boolean {
	return existsSync(join(getBlenderBridgeDir(), WATCH_WINDOW_AUTHORIZED_FILE));
}

/** Mark this session's window as wanted, so the tools may drive it. */
export function authorizeWatchWindow(): void {
	mkdirSync(getBlenderBridgeDir(), { recursive: true });
	writeFileSync(join(getBlenderBridgeDir(), WATCH_WINDOW_AUTHORIZED_FILE), `${Date.now()}\n`, "utf-8");
}

/**
 * Withdraw the window's authorization.
 *
 * Called when the window is deliberately closed. Without this, a later tool
 * call would find the authorization still on disk, decide the window is merely
 * not-yet-up, and launch one — the supervisor's whole reason for existing,
 * applied to a window the user just asked to have closed.
 */
export function unauthorizeWatchWindow(): void {
	try {
		rmSync(join(getBlenderBridgeDir(), WATCH_WINDOW_AUTHORIZED_FILE), { force: true });
	} catch {
		// An authorization this process cannot remove is not a reason to fail a
		// tool call; the absence check is what every reader uses.
	}
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
 *
 * A SUBAGENT child process never supervises, and this is the fix for "close the
 * stray Blender and it comes back". A child does not own the UI's lifetime:
 * index.ts's session_shutdown already exempts every child from shutting the
 * shared UI down, because a worker whose run simply finished would otherwise
 * destroy the manager's window. A child that ALSO supervises is the same
 * asymmetry pointing the other way — it keeps a UI alive (and keeps respawning
 * it) for a session that may have moved on, and it has no way to know, because
 * a long-lived async runner process outlives the turns that launched it. The
 * respawn lands on the per-instance blank bootstrap blend, so what comes back
 * is a window holding nothing the user cares about, and it survives every
 * subsequent close. The reaper cannot clean it up either: the owner pid is
 * genuinely still running, which is the only thing the reaper trusts.
 *
 * The consequence of the child exemption is deliberate and bounded: if a child
 * launched the FIRST UI of a session and the user then closes it, nothing
 * relaunches it, because the root process never launched one and has no
 * supervisor of its own to run. The next blender_* call reports a dead bridge
 * instead of quietly opening a fresh empty window over a model.blend the user
 * was looking at, which is the better of the two failures.
 */
export function runBridgeSupervisorTick(): void {
	if (isLiveBridgeAlive()) return;
	// Never resurrect a UI into a request someone is still waiting on.
	if (isBridgeLocked()) return;
	// A heartbeat this fresh means the UI is starting, not dead: the
	// watchdog owns that window and releasing the flag here would race it.
	// Deliberately mtime-only, ignoring the pid: a fresh heartbeat with a
	// dead pid is a crash, and the tick above already returned for that.
	if (isHeartbeatFresh()) return;
	// Still inside the cold-start budget of a launch this process already made.
	//
	// isHeartbeatFresh() only covers HEARTBEAT_STALE_MS (10s) while the budget
	// is LIVE_BRIDGE_LAUNCH_WATCHDOG_MS (120s), so without this the tick went
	// on relaunching for the two minutes a slow-but-working Blender needs, and
	// opened a fresh window every fifteen seconds throughout. That is the
	// relaunch-loop report this supervisor was added to fix, still reachable
	// through the tick rather than through a launch that could not work.
	//
	// The watchdog is the right thing to ask, not a timestamp: it is armed
	// exactly for that window and cleared by both outcomes — the heartbeat
	// (confirmBridgeLaunched) and the timeout (its own body) — so it is the
	// one piece of state that already knows whether a launch is still owed
	// patience. Checking a second clock here instead would be a second answer
	// to the same question, and the two would drift.
	if (bridgeWatchdog) return;
	// No script to launch with. Checking here as well as at the spawn means
	// a supervisor that is already running goes quiet the moment the
	// condition appears, instead of on its next launch attempt.
	if (!assertLaunchAssetsAvailable()) return;
	// A run of launches that each produced nothing is not a Blender that is
	// slow to start, and it will not become one. Stop rather than reopen a
	// window every fifteen seconds for the rest of the session: a Blender
	// that is genuinely slow to start still gets the full cold-start budget
	// on the first attempt, and every retry after a real death resets the
	// count when the heartbeat confirms the launch.
	if (consecutiveFailedLaunches >= MAX_CONSECUTIVE_FAILED_LAUNCHES) {
		stopBridgeSupervisor();
		console.error(
			`[pi-blender] warning: ${consecutiveFailedLaunches} Blender launches in a row produced no bridge heartbeat, so automatic relaunching has stopped for this session. ` +
				"Launch Blender manually, or restart the pi session; a blender_* call will still try once.",
		);
		return;
	}
	resetBridgeLaunch();
	ensureLiveBridgeLaunchedForce();
}

/**
 * Arm the interval that calls runBridgeSupervisorTick.
 *
 * Split from the tick so a test can exercise the retry ceiling without waiting
 * on it: three launches at fifteen seconds each is over a minute of wall clock
 * to assert something that is otherwise a constant. The tick is factored out
 * rather than duplicated, because two copies of a retry policy means one of
 * them is wrong within a month, and a test that passes against the copy is a
 * test of nothing.
 *
 * A previous version of this claimed that stop-then-start "makes the outcome
 * the same whether the reload reused this module instance or created a new
 * one". That was wrong, and the claim is why the ownership marker below
 * exists. pi's extension loader re-imports with `moduleCache: false`
 * (dist/core/extensions/loader.js, loadExtensionModule), so a `/reload` builds
 * a NEW module instance: a new `bridgeSupervisor` variable holding undefined,
 * and a new interval. stopBridgeSupervisor() can only reach the handle in the
 * instance that owns it, so the old interval keeps running with nothing
 * pointing at it. Every reload leaked one supervisor, each with its own copy of
 * the failure counter — so the ceiling of three was three PER INSTANCE, and a
 * session reloaded four times opened up to twelve windows where it should have
 * opened none.
 *
 * A pid cannot detect this: a leaked interval belongs to a process that is
 * very much still alive, and is in fact this one. So ownership is a token on
 * disk instead, and the LEAKED interval is the thing that notices — it can
 * clear its own handle from inside its own tick, which is the only handle
 * anybody still has a reference to.
 */
function startBridgeSupervisor(): void {
	if (bridgeSupervisor) return;
	if (isSubagentChildProcess()) return;
	// A fresh token per arming. Taken BEFORE the marker is written so the
	// interval below is the first thing that could ever observe it.
	supervisorToken = randomUUID();
	writeSupervisorOwner(supervisorToken);
	bridgeSupervisor = setInterval(onSupervisorInterval, LIVE_BRIDGE_SUPERVISE_INTERVAL_MS);
	// Never hold the pi process open for a supervisor.
	bridgeSupervisor.unref?.();
}

/**
 * One turn of the interval: check ownership, then decide.
 *
 * Named and exported for the same reason the other two are — a leaked interval
 * is the failure this whole mechanism exists to catch, and it can only be
 * tested by invoking that interval's body directly. Waiting fifteen seconds per
 * tick is not a test; calling this is. The ownership check is FIRST, before
 * every other gate, because a leaked interval that still believed it owned the
 * session would relaunch, and the only thing that can stop one is the interval
 * itself.
 */
export function onSupervisorInterval(): void {
	if (!stillOwnsSupervisor()) {
		clearInterval(bridgeSupervisor);
		bridgeSupervisor = undefined;
		supervisorToken = undefined;
		return;
	}
	runBridgeSupervisorTick();
}

/**
 * This instance's supervisor token, or undefined when it is not supervising.
 *
 * Module state for the same reason the other launch flags are: it describes
 * what THIS process is doing, and no other process's answer would be useful.
 */
let supervisorToken: string | undefined;

/**
 * The on-disk record of which module instance owns supervision in this bridge
 * dir.
 *
 * Written by whoever arms, and readable by every process sharing the dir — but
 * only a root process ever writes one, since startBridgeSupervisor refuses to
 * arm in a subagent child. A child reading it therefore sees a live owner and
 * does nothing, which is the same answer it would reach by not arming at all.
 */
const SUPERVISOR_OWNER_FILE = "supervisor.owner";

function writeSupervisorOwner(token: string): void {
	try {
		mkdirSync(getBlenderBridgeDir(), { recursive: true });
		writeFileSync(
			join(getBlenderBridgeDir(), SUPERVISOR_OWNER_FILE),
			JSON.stringify({ pid: process.pid, token, at: Date.now() }),
		);
	} catch (error) {
		// Not fatal, and the consequence is stated rather than swallowed: this
		// instance keeps supervising, and any instance leaked by a later reload
		// cannot detect it. So a failed write degrades to the old behaviour —
		// duplicate supervisors after a reload — instead of stopping supervision
		// altogether, which would be a worse trade for a marker file.
		console.error(
			`[pi-blender] could not record supervisor ownership (${getBlenderBridgeDir()}): ${
				error instanceof Error ? error.message : String(error)
			}. A /reload may leave a second supervisor running; the launch claim still stops it opening a second window.`,
		);
	}
}

/**
 * Whether this module instance is still the one that owns supervision.
 *
 * A missing or unreadable marker counts as NOT owning, which is the direction
 * that fails toward one supervisor rather than several. The marker is written
 * by arming and removed only by this module's own stopBridgeSupervisor(), which
 * also clears the handle — so "handle armed but no marker" means something
 * else removed it, and continuing to relaunch on that evidence is the one
 * outcome this file exists to prevent.
 */
function stillOwnsSupervisor(): boolean {
	if (!supervisorToken) return false;
	try {
		const parsed = JSON.parse(
			readFileSync(join(getBlenderBridgeDir(), SUPERVISOR_OWNER_FILE), "utf-8"),
		) as { pid?: number; token?: string };
		return parsed?.pid === process.pid && parsed.token === supervisorToken;
	} catch {
		return false;
	}
}

/**
 * How many launches may produce no heartbeat before supervision gives up.
 *
 * Three is the smallest number that distinguishes a machine too slow to boot
 * Blender from a launch that cannot work. One is indistinguishable from a
 * momentary stall, and a supervisor that gave up after one would silently
 * stop the recovery it exists for; a larger number just means a longer time
 * the user spends watching a window that will never answer.
 */
const MAX_CONSECUTIVE_FAILED_LAUNCHES = 3;

/**
 * Stop supervising, leaving the rest of the launch state alone.
 *
 * Both halves matter. `clearInterval` stops THIS instance's tick, and
 * removing the owner marker stands every other instance down as well — so a
 * stop that did only the first would leave a leaked interval from an earlier
 * /reload running and, on its next tick, take the marker back for itself. The
 * two are a single operation for that reason, and neither is done conditionally
 * on the other: this instance may hold a marker without holding an interval
 * (it was disowned) and the reverse.
 *
 * Safe to call when no supervisor is running, and idempotent. It does not touch
 * `bridgeLaunchStarted` or the launch claim: a stopped supervisor means "stop
 * checking", not "forget what was launched".
 */
export function stopBridgeSupervisor(): void {
	if (bridgeSupervisor) {
		clearInterval(bridgeSupervisor);
		bridgeSupervisor = undefined;
	}
	if (!supervisorToken) return;
	// Only this instance's marker, checked by token, for the same reason
	// releaseLaunchClaim checks by pid: a marker left by an instance that has
	// already been disowned is not this one's to delete, and deleting it would
	// hand supervision to whichever tick noticed next.
	if (stillOwnsSupervisor()) {
		try {
			rmSync(join(getBlenderBridgeDir(), SUPERVISOR_OWNER_FILE), { force: true });
		} catch {
			// Nothing to do: the token is cleared below either way, so this
			// instance will not re-take a marker it no longer owns, and a stale
			// marker only means a leaked tick stands itself down.
		}
	}
	supervisorToken = undefined;
}

/**
 * Whether supervision is currently armed.
 *
 * Exported for the same reason createManagerMode exposes isEngaged: the
 * supervisor's existence is the whole behaviour, a module-private flag is the
 * only honest place it lives, and a test that cannot read it can only assert
 * that the source contains a particular line -- which is a comment with a
 * syntax error in it.
 */
export function isBridgeSupervisorRunning(): boolean {
	return bridgeSupervisor !== undefined;
}

/**
 * Arm supervision at a session_start, which `/reload` also fires.
 *
 * Stop first, then start, so the outcome is the same whether the reload reused
 * this module instance or built a new one — which is exactly the thing that
 * cannot be relied on, since pi's extension cache is keyed on a generation
 * counter and the reload path does not visibly advance it.
 *
 * GATED ON A DURABLE MARKER, and the gate is the whole point of this function.
 * Arming unconditionally was a fix for a real leak (nothing was arming
 * supervision at all, so a Blender closed mid-session stayed closed) and it
 * immediately broke the other invariant: the tick LAUNCHES Blender when there is
 * no heartbeat, and a session that has never engaged Blender has no heartbeat
 * file at all, which is indistinguishable from a dead bridge. So every fresh pi
 * user opened a Blender window they never asked for — the exact thing the
 * lazy-launch contract exists to prevent, and the reason this file's own
 * ensureLiveBridgeLaunched comment says supervision must not be tied to
 * session_start.
 *
 * Neither "did this process launch?" nor "is a supervisor already armed?"
 * answers it, and both were tried:
 *   - module state cannot survive a /reload, which is the case the re-arm
 *     exists for: a new instance would arm nothing, and the leak the re-arm
 *     fixes would come straight back.
 *   - the owner marker is per-instance by design, so a fresh instance sees no
 *     owner and learns nothing.
 * A file in the bridge dir outlives the module instance, is written only by a
 * launch that actually produced a Blender process, and is left behind by a
 * child that launched the first UI of a session — which is exactly the case
 * where a root process has to take over supervision it never started.
 *
 * Note what is deliberately NOT consulted: the heartbeat. It cannot be, because
 * "no heartbeat" is the very state the tick acts on.
 *
 * startBridgeSupervisor is still the place that refuses to run in a child, so
 * calling this from a child's session_start is harmless: it does not start.
 */
export function restartBridgeSupervisor(): void {
	stopBridgeSupervisor();
	if (!isSupervisionWanted()) return;
	startBridgeSupervisor();
}

/**
 * The on-disk record that this bridge dir belongs to a session that launched a
 * Blender, and so wants one kept alive.
 *
 * Written where the launch is known to have produced a process — after the
 * spawn resolves, next to armBridgeWatchdog — rather than at the top of
 * launchBridge, because a launch that was suppressed (PI_BLENDER_NO_UI) or that
 * never reached a spawn must not arm a supervisor. Under PI_BLENDER_NO_UI that
 * would be a silent fifteen-second loop: the tick resets the launch, the launch
 * does nothing, and nothing ever advances the failure counter that would stop
 * it, because that counter only moves on a watchdog timeout.
 *
 * Never removed. Supervision stays wanted for the life of the bridge dir, so a
 * /reload after the retry ceiling re-arms and re-learns the ceiling with its own
 * fresh counter — the same behaviour a reloaded instance has for every other
 * piece of launch state, and the reason the ceiling is per session rather than
 * per bridge dir.
 */
function isSupervisionWanted(): boolean {
	return existsSync(join(getBlenderBridgeDir(), SUPERVISION_WANTED_FILE));
}

function markSupervisionWanted(): void {
	try {
		mkdirSync(getBlenderBridgeDir(), { recursive: true });
		writeFileSync(
			join(getBlenderBridgeDir(), SUPERVISION_WANTED_FILE),
			JSON.stringify({ pid: process.pid, at: Date.now() }),
			"utf-8",
		);
	} catch (error) {
		// Degrades to "a session that has launched Blender is not supervised",
		// which is the older behaviour and not a wrong answer — a closed window
		// stays closed until the next blender_* call, and that call relaunches.
		console.error(
			`[pi-blender] could not record that this session wants a supervised Blender (${getBlenderBridgeDir()}): ${
				error instanceof Error ? error.message : String(error)
			}. Blender will not be reopened automatically if it is closed; the next blender_* call will still start it.`,
		);
	}
}

/** See isSupervisionWanted. */
const SUPERVISION_WANTED_FILE = "supervise.want";

/**
 * Whether this process hosts subagent child sessions rather than a user session.
 *
 * pi-subagents sets PI_SUBAGENT_CHILD=1 in the async runner that backs every
 * spawned subagent (src/runs/background/subagent-runner.js). The same value is
 * already the discriminator for the shutdown guard in index.ts, and it is read
 * the same way here on purpose: one fact, one test, so the process that refuses
 * to close the UI is exactly the process that refuses to reopen it.
 */
function isSubagentChildProcess(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1";
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
	// Same authorization gate as the lazy path, and for the same reason: the
	// supervisor's relaunch reaches this function, so an ungated force would
	// reopen the window the user just closed. The one caller that is allowed to
	// open a window unconditionally is requestWatchWindowLaunch, and it
	// authorizes first.
	if (!isWatchWindowAuthorized()) return;
	launchBridge();
}

/**
 * Open this session's watch window, or do nothing if it is already up.
 *
 * The single authorized path to a windowed Blender. The marker is written
 * BEFORE the spawn so a launch that races the first tool call is already
 * legitimate, and so a second /blender-watch in the same session is a no-op
 * rather than a second window.
 *
 * resetBridgeLaunch() first so a window closed moments ago is replaced even
 * though the stale-heartbeat check would otherwise treat the request as
 * satisfied.
 */
export async function requestWatchWindowLaunch(): Promise<void> {
	// Idempotent on the authorization, not merely on liveness. The second
	// /blender-watch of a session arrives in the window between the spawn and
	// the first heartbeat, where isLiveBridgeAlive() is still false — so a
	// liveness check alone would reset the launch flags below and start a SECOND
	// window over the one already coming up. "At most one window" has to be
	// enforced by the record of having asked, which is what the marker is.
	//
	// This is also why the window's own death needs no path here: the marker is
	// removed when the window is closed deliberately, and a marker left behind
	// by a crash is what the supervisor's relaunch exists for.
	if (isWatchWindowAuthorized()) {
		await whenLaunchSettled();
		return;
	}
	// The marker is written BEFORE the spawn so a tool call that races this
	// launch finds the window legitimate rather than unauthorized.
	authorizeWatchWindow();
	resetBridgeLaunch();
	ensureLiveBridgeLaunchedForce();
	await whenLaunchSettled();
}

function launchBridge(): void {
	// Before the claim: a launch that cannot work must not take the launch claim
	// away from a peer that might be able to.
	if (!assertLaunchAssetsAvailable()) return;
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
	if (process.env.PI_BLENDER_NO_UI?.trim() === "1") {
		// Nothing will be spawned, so the claim must not outlive this call: peers
		// would skip their own launch for a UI that is never coming.
		releaseLaunchClaim();
		bridgeSpawnInFlight = false;
		return;
	}
	// Deliberately NOT here. Supervising a launch is the root session's job:
	// startBridgeSupervisor refuses to run in a subagent child, and a child that
	// launched the first UI of a session has no root process to supervise it.
	// Calling it anyway would be silently different in the two processes -- a
	// root would reopen a closed window, a child would not -- and the
	// supervision the root already owns is the one that matters.
	// resetBridgeSupervisorHold is not needed either: a child simply never set
	// the hold, so the first root session_start re-arms normally.
	//
	// Assigned, not left floating, so a caller can wait on the spawn rather than
	// guess how long it takes. See whenLaunchSettled.
	pendingLaunch = (async () => {
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
					`[pi-blender] warning: failed to start Blender (${command} ${args.join(" ")}): ${error.message}. Fix BLENDER_PATH or install Blender; the next blender_* call will retry.`,
				);
			});
			child.unref();
			// A Blender process now exists, so this session wants one kept
			// alive: record it durably, which is what a later session_start
			// (including a /reload's fresh module instance) reads to decide
			// whether supervision belongs here. Written here and not at the top
			// of launchBridge so a suppressed or failed launch does not arm a
			// supervisor for a UI that is not coming. See isSupervisionWanted.
			markSupervisionWanted();
			// The spawn succeeded, which is not proof of a UI: it may die before
			// its first poll. Watch for the first heartbeat.
			armBridgeWatchdog();
		} catch (error) {
			clearBridgeWatchdog();
			releaseLaunchClaim();
			const message = error instanceof Error ? error.message : String(error);
			const target = launched ? `${launched.command} ${launched.args.join(" ")}`.trim() : "Blender";
			console.error(`[pi-blender] warning: failed to launch Blender (${target}): ${message}`);
			bridgeLaunchStarted = false;
		}
		finally {
			bridgeSpawnInFlight = false;
		}
	})();
}

/**
 * Resolves once the spawn this module has in flight has settled, or immediately
 * when there is none.
 *
 * Exported for the tests rather than for production callers, and deliberately
 * not a timeout: the point is to stop guessing how long a spawn takes, not to
 * give up on one. The harness used to sleep a fixed 300ms between supervisor
 * ticks and 1500ms after a launch, which spends most of a suite waiting and
 * still races: on a machine slower than the sleep the tick's launch has not
 * been counted yet, so a ceiling of three reads as five and the test fails for
 * a reason that has nothing to do with the code under test. Waiting on the real
 * event makes a slow machine slower rather than wrong.
 */
export function whenLaunchSettled(): Promise<void> {
	return pendingLaunch ?? Promise.resolve();
}

/** The in-flight spawn, or undefined when nothing is launching. */
let pendingLaunch: Promise<void> | undefined;
