import { randomUUID } from "node:crypto";
import { access, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { getBlenderAssetsDir, getBlenderBridgeDir, getBlenderTempDir } from "../config.js";
import { parseLockHolderPid, pidIsRunning } from "./liveness.js";
import { reclaimLockIfUnchanged } from "./lock-reclaim.js";
import { execCommand } from "../core/exec.js";
import { resolveBlenderArgv } from "../launch.js";
import { ParallelRunGate, resolveRunBudget } from "./concurrency.js";
import { acquireRunLease, releaseRunLease } from "./run-leases.js";
import type {
	BlenderRunResult,
	BlenderSavedView,
	RunBlenderJsonOptions,
	SessionContextWarningCode,
} from "./types.js";

export const MANIFEST_FILE = "blender-workspace.json";
export const WORKSPACE_SCRIPT_FILE = "script.py";
export const CRITIQUE_LOG_FILE = "critique.log";
export const DEFAULT_RENDER_EXTENSION = ".png";

/**
 * How much a session-context warning matters when only one line fits in the
 * per-turn prompt.
 *
 * A peer holding the same blend outranks everything: it is the one warning
 * about a destructive outcome for the user's file rather than about the shape
 * of the current selection. Ties keep source order, so the first-raised
 * warning still wins among equals.
 */
export const WARNING_SEVERITY: Record<SessionContextWarningCode, number> = {
	"shared-with-peer": 3,
	"workspace-mismatch": 2,
	"unsaved-scene": 2,
	// A failed headless read outranks a mode note: it means the file and scene
	// sections are from the manifest, not from the .blend, which is a weaker
	// answer than the same sections read for real.
	"headless-probe-failed": 2,
	"unsaved-changes": 1,
	"no-viewport": 1,
	"ambiguous-selection": 1,
	// Lowest, because it is the NORMAL state of any session that has not run
	// /blender-watch and is about the mode rather than about the file. It
	// matters that it is ranked at all: in a one-line prompt it has to be able
	// to outrank nothing but still lose to anything about the user's data.
	"no-watch-window": 0,
};
/**
 * Default wait for a bridge request when the caller does not supply one.
 *
 * Callers that run user scripts pass an explicit budget (`timeoutSeconds * 1000`,
 * default 120 s from blender_execute_python / blender_module_run), because a
 * heavy bpy script legitimately outlives this window. Raising this default
 * instead would make every genuinely-dead bridge take 2 minutes to report.
 */
export const LIVE_BRIDGE_TIMEOUT_MS = 30_000;
/** Extra budget for the request that cold-launched the Blender UI (boot can be slow). */
export const LIVE_BRIDGE_COLD_START_TIMEOUT_MS = 120_000;
export const LIVE_BRIDGE_INIT_TIMEOUT_MS = 5_000;
export const LIVE_BRIDGE_POLL_MS = 200;
/**
 * A bridge request holds the single live-Blender slot for at most this long.
 * The lock is force-reclaimable after this, so a crashed pi process or an
 * abandoned request can never wedge the bridge permanently.
 */
export const LIVE_BRIDGE_LOCK_STALE_MS = 600_000;

export function nowIso(): string {
	return new Date().toISOString();
}

export function createWorkspaceId(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(
		now.getMinutes(),
	)}${pad(now.getSeconds())}`;
}

export function normalizeWorkspacePath(cwd: string, workspace?: string): string {
	if (!workspace || workspace.trim().length === 0) {
		return resolve(cwd, "outputs", createWorkspaceId());
	}
	if (isAbsolute(workspace)) {
		return workspace;
	}
	return resolve(cwd, workspace);
}

export function normalizeUserPath(cwd: string, filePath: string): string {
	return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
}

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function getSavedViewCameraObjectName(savedView: BlenderSavedView): string | null {
	if (typeof savedView.cameraObjectName === "string" && savedView.cameraObjectName.length > 0) {
		return savedView.cameraObjectName;
	}
	return typeof savedView.cameraName === "string" && savedView.cameraName.length > 0 ? savedView.cameraName : null;
}

export function normalizeSavedView(savedView: BlenderSavedView): BlenderSavedView {
	const cameraObjectName = getSavedViewCameraObjectName(savedView);
	if (!cameraObjectName) {
		throw new Error(`Saved view "${savedView.name}" does not reference a camera object.`);
	}
	return {
		name: savedView.name,
		cameraObjectName,
		cameraSettingsName: savedView.cameraSettingsName,
		cameraName: savedView.cameraName,
		source: savedView.source,
		savedAt: savedView.savedAt,
	};
}

export async function writeJsonTempFile(prefix: string, contents: string): Promise<string> {
	// Flatpak sandbox cannot see /tmp or $XDG_RUNTIME_DIR, so scripts must
	// live in a flatpak-visible dir (XDG cache home by default).
	const filePath = join(getBlenderTempDir(), `${prefix}${randomUUID()}.py`);
	await writeFile(filePath, contents, "utf-8");
	return filePath;
}

export async function cleanupTempFile(filePath: string): Promise<void> {
	await rm(filePath, { force: true });
}

export function parseJsonBlock<T>(stdout: string): T {
	const startMarker = "__PI_BLENDER_JSON_START__";
	const endMarker = "__PI_BLENDER_JSON_END__";
	const start = stdout.indexOf(startMarker);
	const end = stdout.indexOf(endMarker);
	if (start === -1 || end === -1 || end <= start) {
		throw new Error(`Failed to parse Blender JSON output.\n\n${stdout}`);
	}
	const payload = stdout.slice(start + startMarker.length, end).trim();
	try {
		return JSON.parse(payload) as T;
	} catch (error) {
		throw new Error(
			`Failed to parse Blender JSON output payload: ${error instanceof Error ? error.message : String(error)}\n\n${payload}`,
		);
	}
}

/**
 * A Blender failure message that keeps both streams.
 *
 * A failing script's traceback is on stderr and its own diagnostics are almost
 * always on stdout, because a script that prints its measurements before it
 * discovers the problem prints them. Picking one stream discards the half that
 * explains what the script was doing, so both are labelled and an empty stream
 * says so rather than leaving a blank section.
 */
export function formatBlenderFailure(options: {
	streams: { stdout: string; stderr: string };
	subject: string;
}): string {
	const label = (name: string, value: string): string =>
		`--- ${name} ---\n${value.trim() || "(empty)"}`;
	return [options.subject, label("stdout", options.streams.stdout), label("stderr", options.streams.stderr)].join(
		"\n",
	);
}

export async function runBlenderProcess(options: {
	cwd: string;
	blendPath?: string;
	scriptPath: string;
	payload: Record<string, unknown>;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** What this run is for, recorded on the lease. Diagnostics only. */
	label?: string;
	/**
	 * Flags for the SCRIPT, appended after the `--` separator that ends
	 * Blender's own arguments. They cannot go before the blend: Blender's
	 * argument parser treats an unrecognised `--flag` there as a filename and
	 * reports `Cannot read file ".../--serve"`, so a script-level flag placed in
	 * the natural position stops the run before the script is ever loaded.
	 */
	scriptArgs?: string[];
}): Promise<BlenderRunResult> {
	const { command, args: blenderArgs } = await resolveBlenderArgv();
	const trailing = options.scriptArgs ?? [];
	const tail = [JSON.stringify(options.payload), ...trailing];
	const args = options.blendPath
		? [...blenderArgs, "--background", options.blendPath, "--python", options.scriptPath, "--", ...tail]
		: [...blenderArgs, "--background", "--factory-startup", "--python", options.scriptPath, "--", ...tail];

	// Every headless Blender in this extension is spawned here, so this is the
	// one place the concurrency ceiling can be enforced. The warning is emitted
	// once per resolved budget rather than per run: a fan-out of twenty renders
	// would otherwise print the same projection twenty times, and the operator
	// only needs to be told that the clamp engaged, not that it engaged again.
	const budget = resolveRunBudget();
	const clampWarning = budget.warning;
	if (clampWarning && !warnedAboutClamp.has(clampWarning)) {
		warnedAboutClamp.add(clampWarning);
		console.warn(`[pi-blender] ${clampWarning}`);
	}

	const release = await headlessGate().acquire();
	// Leased after the slot and after the spawn, so what gets counted is a
	// process that exists. The lease is what makes the count correct across the
	// session tree: the gate above is per-process, so a manager asking how many
	// Blenders are open would otherwise see only its own.
	let leasedPid: number | null = null;
	try {
		const result = await execCommand(command, args, options.cwd, {
			signal: options.signal,
			timeout: options.timeoutMs,
			onSpawn: (pid) => {
				leasedPid = pid;
				acquireRunLease(pid, options.label);
			},
		});

		return {
			stdout: result.stdout,
			stderr: result.stderr,
			code: result.code,
		};
	} finally {
		if (leasedPid !== null) releaseRunLease(leasedPid);
		release();
	}
}

/** Warnings already printed, so a fan-out does not repeat itself per run. */
const warnedAboutClamp = new Set<string>();

/**
 * The process-wide headless gate.
 *
 * One gate for the whole process rather than one per call site: the limit is a
 * machine property, and a per-call-site gate would let four callers each admit
 * four runs and produce sixteen on a box that budgeted for four. Deliberately
 * not shared across processes either — each pi session has its own budget to
 * honour, and a cross-process gate would put module workers in the same queue
 * as the session that spawned them.
 */
let gate: ParallelRunGate | null = null;
function headlessGate(): ParallelRunGate {
	if (gate === null) {
		gate = new ParallelRunGate(resolveRunBudget().effective);
	}
	return gate;
}

/** Reset the cached gate and warning set. For the tests, which vary the env. */
export function resetHeadlessGateForTests(): void {
	gate = null;
	warnedAboutClamp.clear();
}

export async function runBlenderJson<T>(options: RunBlenderJsonOptions): Promise<T> {
	const scriptPath = await writeJsonTempFile("pi-blender-", options.scriptSource);
	try {
		const result = await runBlenderProcess({
			cwd: options.cwd,
			blendPath: options.blendPath,
			scriptPath,
			payload: options.payload,
			timeoutMs: options.timeoutMs,
			signal: options.signal,
			label: options.label,
			scriptArgs: options.scriptArgs,
		});
		if (result.code !== 0) {
			// Both streams: this path is a headless probe with no live UI to
			// report to, so the JSON never arrives and the streams are the only
			// evidence of what failed.
			throw new Error(
				formatBlenderFailure({
					streams: { stdout: result.stdout, stderr: result.stderr },
					subject: `Blender exited with code ${result.code}`,
				}),
			);
		}
		try {
			return parseJsonBlock(result.stdout) as T;
		} catch (error) {
			// A missing JSON block on a ZERO exit code is not a parse bug, it is a
			// script that raised at top level: Blender's `--python` prints the
			// traceback to stderr and still exits 0, so `result.code === 0` says
			// nothing about whether the script ran. Without this, a single bad
			// subscript in a Blender data API reported "failed to parse JSON
			// output" and the traceback naming the actual line was discarded --
			// the caller could not tell a malformed payload from a wrong API call.
			// Both streams are included for the same reason as above.
			throw new Error(
				formatBlenderFailure({
					streams: { stdout: result.stdout, stderr: result.stderr },
					subject: `Blender exited with code 0 but produced no JSON result block: ${
						error instanceof Error ? error.message : String(error)
					}`,
				}),
			);
		}
	} finally {
		await cleanupTempFile(scriptPath);
	}
}

export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("Operation aborted.");
	}
	if (!signal) {
		await new Promise<void>((resolveDelay) => {
			setTimeout(resolveDelay, ms);
		});
		return;
	}
	const abortSignal = signal;

	await new Promise<void>((resolveDelay, rejectDelay) => {
		const timeout = setTimeout(() => {
			abortSignal.removeEventListener("abort", onAbort);
			resolveDelay();
		}, ms);

		function onAbort(): void {
			clearTimeout(timeout);
			abortSignal.removeEventListener("abort", onAbort);
			rejectDelay(abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Operation aborted."));
		}

		abortSignal.addEventListener("abort", onAbort, { once: true });
	});
}

export function getStringRecordValue(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" ? value : null;
}

export function normalizeRenderOutputName(name?: string): string {
	if (!name || name.trim().length === 0) {
		return `render${DEFAULT_RENDER_EXTENSION}`;
	}
	return name.endsWith(DEFAULT_RENDER_EXTENSION) ? name : `${name}${DEFAULT_RENDER_EXTENSION}`;
}

export function getBundledBlenderSkillsDir(): string {
	return join(getBlenderAssetsDir(), "skills");
}

/**
 * Location of the bundled blender-worker/blender-critic agent templates.
 *
 * Not wired into `resources_discover`: pi 0.87.1's ResourcesDiscoverResult
 * only carries skillPaths/promptPaths/themePaths, so an extension has no hook
 * for registering agent definitions. Exported anyway so the path is
 * discoverable (and the templates can be copied to ~/.pi/agent/agents/) without
 * hardcoding the assets layout; the README documents the manual step.
 */
export function getBundledBlenderAgentsDir(): string {
	return join(getBlenderAssetsDir(), "agents");
}

/**
 * Disk lock shared by every pi process that talks to this bridge dir.
 *
 * The live Blender UI is a single mutable session: two concurrent requests
 * interleave scene mutations, mode changes and saves with no ordering
 * guarantee. Acquire this before writing a request; release it when the
 * response is read (or the request times out). A lock whose holder pid is gone
 * is force-reclaimed, so a dead holder cannot wedge the bridge forever. Age
 * reclaims only a lock that predates the pid field, because a live holder is
 * never displaced no matter how long it has held the lock.
 *
 * The reclaim is CONDITIONAL: it removes the lock only if the file is still
 * byte-for-byte the one the reclaim decision was made about. Deciding "this
 * holder is dead" and then unlinking the path are two steps, and between them
 * the holder can release() and a third waiter can create a fresh lock that
 * this process would then delete -- handing the one live Blender UI to two
 * concurrent requests. See lock-reclaim.ts; the policy below is unchanged.
 */
export async function acquireBridgeLock(options?: {
	signal?: AbortSignal;
	timeoutMs?: number;
	label?: string;
}): Promise<{ release: () => Promise<void>; waitedMs: number }> {
	const lockPath = join(getBlenderBridgeDir(), "bridge.lock");
	const deadline = Date.now() + (options?.timeoutMs ?? LIVE_BRIDGE_LOCK_STALE_MS);
	const startedAt = Date.now();

	while (true) {
		try {
			// wx = exclusive create; fails when the lock already exists.
			const handle = await open(lockPath, "wx");
			await handle.writeFile(
				JSON.stringify({ pid: process.pid, label: options?.label ?? null, acquiredAt: nowIso() }),
				"utf-8",
			);
			await handle.close();
			return {
				waitedMs: Date.now() - startedAt,
				release: async () => {
					await rm(lockPath, { force: true });
				},
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") {
				throw error;
			}

			// Reclaim a lock whose holder is gone at any age, or a pre-pid lock
			// that has aged out. A lock with a readable pid is never taken on age
			// alone: this lock is documented to be held for minutes (a render
			// alone allows 360s), so an mtime rule would interleave two requests
			// against the one live UI it exists to serialize.
			let reclaimable = false;
			let observed = "";
			try {
				const stats = await stat(lockPath);
				// Read the bytes once and derive the pid from them. A stat plus a
				// separate pid read would be two looks at a path that can be
				// replaced between them, and the reclaim below compares against
				// exactly what was read here.
				observed = await readFile(lockPath, "utf-8");
				const holderPid = parseLockHolderPid(observed);
				reclaimable =
					holderPid === null
						? Date.now() - stats.mtimeMs > LIVE_BRIDGE_LOCK_STALE_MS
						: !pidIsRunning(holderPid);
			} catch {
				// The holder released it between the failed create and this stat.
				continue;
			}
			if (reclaimable) {
				await reclaimLockIfUnchanged(lockPath, observed);
				continue;
			}

			if (Date.now() >= deadline) {
				// Name the holder. A module run can hold the lock for minutes
				// (a render alone allows 360s), so a caller blocked here is
				// almost always queued behind a concurrent module, not facing
				// a dead bridge. Reporting only the path made that look like a
				// timeout instead of "wait your turn", which is how a parallel
				// spawn turned into a silent failure.
				const holder = await readBridgeLock();
				let who = "";
				if (holder) {
					const holderName = holder.label ? `"${holder.label}"` : "another request";
					who = ` It is held by ${holderName} (pid ${holder.pid ?? "unknown"}), held for ${Math.round(holder.ageMs / 1000)}s.`;
				}
				throw new Error(
					`Timed out after ${Math.round((Date.now() - startedAt) / 1000)}s waiting for the live Blender bridge lock (${lockPath}).${who} The live Blender UI is ONE mutable session and serializes every request, so concurrent work queues rather than running in parallel. If you are running several modules or subagents at once, run them one at a time and await each before starting the next; do not retry in a tight loop, and do not start a second module while one is in flight.`,
				);
			}
			await delay(LIVE_BRIDGE_POLL_MS, options?.signal);
		}
	}
}

/** Read-only lock snapshot for status reporting; never mutates the lock. */
export async function readBridgeLock(): Promise<{ pid: number | null; label: string | null; acquiredAt: string | null; ageMs: number } | null> {
	const lockPath = join(getBlenderBridgeDir(), "bridge.lock");
	try {
		const [stats, raw] = await Promise.all([stat(lockPath), readFile(lockPath, "utf-8")]);
		const parsed = JSON.parse(raw) as { pid?: number; label?: string | null; acquiredAt?: string | null };
		return {
			pid: typeof parsed.pid === "number" ? parsed.pid : null,
			label: parsed.label ?? null,
			acquiredAt: parsed.acquiredAt ?? null,
			ageMs: Date.now() - stats.mtimeMs,
		};
	} catch {
		return null;
	}
}
