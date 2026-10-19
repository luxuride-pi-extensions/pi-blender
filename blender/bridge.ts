import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderAssetsDir, getBlenderBridgeDir } from "../config.js";
import { ensureLiveBridgeLaunched, isLiveBridgeAlive } from "../launch.js";
import { isHeartbeatFresh, readHeartbeatBlendPath } from "./liveness.js";
import type {
	BlenderRenderViewSource,
	BlenderViewportShading,
	CompareResult,
	GeometryProbeResult,
	GeometryProbeSpecification,
	MontageResult,
	WindowLayoutResult,
} from "./types.js";
import {
	acquireBridgeLock,
	delay,
	fileExists,
	formatBlenderFailure,
	LIVE_BRIDGE_COLD_START_TIMEOUT_MS,
	LIVE_BRIDGE_POLL_MS,
	LIVE_BRIDGE_TIMEOUT_MS,
	runBlenderProcess,
} from "./utils.js";

/**
 * How long checkLiveBlenderBlend waits for the heartbeat to name the blend that
 * was just opened, and how often it re-reads in that window.
 *
 * Sized against POLL_INTERVAL_SECONDS (0.5 s, live-bridge.py) rather than
 * invented: the poller writes its heartbeat at the TOP of each cycle, so the
 * open a request performed is only visible on the FOLLOWING cycle. Two cycles
 * plus a poll of slack covers a normally-scheduled one without turning a real
 * failure into a multi-second stall, and HEARTBEAT_STALE_MS (10 s) is far above
 * it, so a UI that is merely slow to come up is never misreported as gone.
 */
const LIVE_BLEND_PATH_SETTLE_MS = 1_500;
const HEARTBEAT_RECHECK_MS = 100;

/**
 * A montage is one render per panel, so its budget has to cover the panels
 * rather than the single render LIVE_BRIDGE_TIMEOUT_MS was sized for. Four
 * panels at the studio resolution is a few minutes on CPU, and cutting a sheet
 * off partway through would leave panels on disk with no sheet to read.
 */
const DEFAULT_MONTAGE_TIMEOUT_MS = LIVE_BRIDGE_TIMEOUT_MS * 4;

/**
 * A comparison renders every panel twice, and the baseline set costs an extra
 * blend open on top. Doubling the montage budget is the panel count; the open is
 * not a render at all and rides inside that slack.
 */
const DEFAULT_COMPARE_TIMEOUT_MS = LIVE_BRIDGE_TIMEOUT_MS * 8;

function getLiveBridgePaths(): {
	bridgeDir: string;
	requestsDir: string;
	responsesDir: string;
} {
	const bridgeDir = getBlenderBridgeDir();
	return {
		bridgeDir,
		requestsDir: join(bridgeDir, "requests"),
		responsesDir: join(bridgeDir, "responses"),
	};
}

/**
 * A live-bridge request that arrived with no window to serve it.
 *
 * A distinct type rather than a message, because the callers that CAN work
 * without a window have to be able to recognize this and fall back: an error
 * that only reads well is an error every caller has to string-match on, and
 * string-matching an error is exactly how a reworded message silently changes
 * behaviour. The tools that fall back check `instanceof`.
 */
export class NoWatchWindowError extends Error {
	readonly requestType: string;

	constructor(requestType: string) {
		super(
			`No Blender window is open, so "${requestType}" has nothing to run in. This is a windowed-Blender-only tool: ` +
				"use the headless path instead (blender_branch_run for module work, blender_render with renderMethod " +
				'"background" for a still, blender_scene_info for what is on disk). An agent CANNOT open the window ' +
				"itself -- only the user can run /blender-watch -- so do not stop the build to wait for it. If a " +
				"window is genuinely wanted, say so in your report and let the user decide.",
		);
		this.name = "NoWatchWindowError";
		this.requestType = requestType;
	}
}

/**
 * Run one bridge request in a throwaway headless Blender.
 *
 * The windowed path answers from a session whose UI may hold unsaved work, a
 * selection, a mode and a viewport; none of those exist here, and a request that
 * needs one of them (set-mode, capture-view) still refuses, loudly, from the
 * same handler. What the remaining requests actually need is a loaded blend
 * and bpy, so they run against live-bridge.py itself in `--serve` mode: one
 * request through the SAME dispatch table the window uses, then exit. Reusing
 * the table is the point — a second headless implementation of a geometry probe
 * is a second answer to "how far apart are these two parts".
 *
 * The blend is opened by Blender from argv rather than by
 * ensure_requested_blend_open, because a fresh process has nothing to discard
 * and the dirty-blend guard would only ever be true here if the file itself
 * changed under us.
 */
async function runHeadlessBridgeRequest<T>(options: {
	payload: Record<string, unknown>;
	signal?: AbortSignal;
	timeoutMs?: number;
	cwd?: string;
	label?: string;
}): Promise<T> {
	const requestType = String(options.payload.type ?? "unknown");
	const result = await runBlenderProcess({
		cwd: options.cwd ?? process.cwd(),
		blendPath: typeof options.payload.blendPath === "string" ? options.payload.blendPath : undefined,
		scriptPath: join(getBlenderAssetsDir(), "live-bridge.py"),
		// Blender has to be told to serve rather than poll. The flag goes AFTER
		// the `--`: in the position where it belongs semantically, Blender's
		// argument parser reads it as a blend filename and refuses to start
		// (`unknown argument, loading as file: --serve`). `execCommand` appends
		// `-- <payload>`, so serve_once finds the request in sys.argv and the
		// mode flag behind it.
		payload: options.payload,
		timeoutMs: options.timeoutMs ?? LIVE_BRIDGE_TIMEOUT_MS,
		signal: options.signal,
		label: options.label ?? `headless ${requestType}`,
		scriptArgs: ["--serve"],
	});

	// Blender exits 0 even when a --python script raises, so the exit code says
	// only that Blender started. The payload is the answer, and a missing one
	// means serve_once never got to print — which is a crash in the bridge
	// itself, not a refused request, so both streams are kept.
	if (result.code !== 0 || !result.stdout.includes("__PI_BLENDER_JSON_START__")) {
		throw new Error(
			formatBlenderFailure({
				streams: { stdout: result.stdout, stderr: result.stderr },
				subject:
					result.code !== 0
						? `Headless Blender exited with code ${result.code} serving "${requestType}"`
						: `Headless Blender served "${requestType}" but printed no result block`,
			}),
		);
	}

	const start = result.stdout.indexOf("__PI_BLENDER_JSON_START__") + "__PI_BLENDER_JSON_START__".length;
	const end = result.stdout.indexOf("__PI_BLENDER_JSON_END__");
	let response: { ok: true; result: T } | { ok: false; error?: string; traceback?: string };
	try {
		response = JSON.parse(result.stdout.slice(start, end).trim()) as typeof response;
	} catch (error) {
		// A block that is present but unparseable is Blender's own JSON encoder
		// failing on the result, not a request this code got wrong, so the raw
		// block is kept alongside both streams.
		throw new Error(
			formatBlenderFailure({
				streams: { stdout: result.stdout, stderr: result.stderr },
				subject: `Headless "${requestType}" produced a result block that is not JSON: ${error instanceof Error ? error.message : String(error)}`,
			}),
		);
	}
	if (!response.ok) {
		// The refusal messages here are written for a user reading a terminal:
		// "no live VIEW_3D viewport" tells them to run /blender-watch, which is
		// the only thing that can fix it.
		throw new Error(`${response.error ?? `Headless "${requestType}" failed.`}${response.traceback ? `\n\n${response.traceback}` : ""}`);
	}
	return response.result;
}

/**
 * A request that does not need a window, run wherever it can run.
 *
 * `required` names the windowed-only request types, and it lives here rather
 * than in each caller because "which requests need a viewport" is a property of
 * the bridge, not of the five tools that happen to call it today. A type that
 * is not listed and has no window still raises from its own handler, which is
 * the honest outcome: the tool found out by trying, and said why.
 */
const WINDOW_ONLY_REQUEST_TYPES = new Set([
	"set-mode",
	"capture-view",
	"window-layout",
	"get-window-layout",
	"window-screenshot",
]);

export async function requestBridge<T>(options: {
	payload: Record<string, unknown>;
	signal?: AbortSignal;
	timeoutMs?: number;
	cwd?: string;
	label?: string;
}): Promise<T> {
	if (isLiveBridgeAlive()) {
		return await requestLiveBlenderBridge<T>(options);
	}
	if (WINDOW_ONLY_REQUEST_TYPES.has(String(options.payload.type ?? ""))) {
		throw new NoWatchWindowError(String(options.payload.type ?? "unknown"));
	}
	return await runHeadlessBridgeRequest<T>(options);
}

async function requestLiveBlenderBridge<T>(options: {
	payload: Record<string, unknown>;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<T> {
	const { requestsDir, responsesDir } = getLiveBridgePaths();
	await mkdir(requestsDir, { recursive: true });
	await mkdir(responsesDir, { recursive: true });

	// The live Blender UI is ONE mutable session: concurrent requests interleave
	// scene mutations, mode switches and saves with no ordering guarantee. Take
	// the cross-process lock before writing the request so tool calls serialize
	// even across parallel pi sessions or subagents.
	const requestLabel = typeof options.payload.label === "string" ? options.payload.label : String(options.payload.type ?? "request");
	const lock = await acquireBridgeLock({
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		label: requestLabel,
	});
	try {
		return await runLockedBridgeRequest<T>(options);
	} finally {
		await lock.release().catch(() => undefined);
	}
}

/**
 * Whether the live UI is showing `blendPath` right now, read from the file the
 * bridge rewrites every poll rather than from a request of its own.
 *
 * This exists because a successful bridge response is NOT evidence about the
 * UI's state. A response only proves that SOME Blender polling this dir ran
 * the request, and that Blender can be gone — or be one of several — by the
 * time the caller reads the file. `blender_workspace_init` used to report
 * openedInLiveBlender: true on the strength of the response alone, which is
 * how a session that had just lost its UI to a supervisor relaunch was told it
 * was looking at the workspace blend while the only live window sat on the
 * bootstrap blank.
 *
 * A file read rather than a `get-session-context` request, deliberately: it
 * needs no lock, cannot queue behind a request that is already holding the
 * bridge, and adds no window for the UI to die in.
 *
 * The wait is load-bearing, not politeness. live-bridge.py's poll_requests()
 * calls touch_heartbeat() BEFORE it processes the request queue, so the
 * heartbeat written during the poll that ran the open still names the PREVIOUS
 * blend. Reading the file the instant the response appears therefore samples
 * the old state and reports a false mismatch on a perfectly healthy session
 * that just opened the file. The next poll (POLL_INTERVAL_SECONDS, 0.5 s) fixes
 * it, so this retries within a few poll cycles before concluding anything.
 *
 * This names the poller that is beating NOW, which is the one the next request
 * will be answered by unless there is more than one alive — with two pollers on
 * one dir, this is a sample written every 0.5 s, not a guarantee. The check
 * narrows the claim; it cannot make it absolute.
 */
export async function checkLiveBlenderBlend(
	blendPath: string,
	options?: { signal?: AbortSignal; settleMs?: number },
): Promise<{ matches: true } | { matches: false; heartbeatFresh: boolean; liveBlendPath: string | null }> {
	const bridgeDir = getBlenderBridgeDir();
	// The poller writes its heartbeat once per POLL_INTERVAL_SECONDS before
	// draining the queue, so allow a couple of cycles for the open to show up.
	// Bounded because a UI that never reports the file is exactly the case the
	// caller needs an answer about; an unbounded wait would turn a wrong claim
	// into a hang.
	const settleMs = options?.settleMs ?? LIVE_BLEND_PATH_SETTLE_MS;
	const deadline = Date.now() + settleMs;
	for (;;) {
		// No heartbeat at all is its own answer: there is no live session to
		// have opened anything, and a stale one means the poller that answered
		// the request has stopped. Retrying cannot change either, so return at
		// once rather than sitting out the full settle window.
		if (!isHeartbeatFresh(bridgeDir)) {
			return { matches: false, heartbeatFresh: false, liveBlendPath: null };
		}
		const liveBlendPath = readHeartbeatBlendPath(bridgeDir) ?? null;
		// Plain string equality, the same test session-context makes: both
		// sides are absolute paths, and inventing a normalisation here would
		// only let the two disagree about the same file.
		if (liveBlendPath === blendPath) return { matches: true };
		if (Date.now() >= deadline) return { matches: false, heartbeatFresh: true, liveBlendPath };
		await delay(HEARTBEAT_RECHECK_MS, options?.signal);
	}
}

async function runLockedBridgeRequest<T>(options: {
	payload: Record<string, unknown>;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<T> {
	const { requestsDir, responsesDir } = getLiveBridgePaths();

	// Fail fast when there is no window, rather than polling to a timeout.
	//
	// A window exists if and only if /blender-watch opened one (see
	// isWatchWindowAuthorized). Without that, nothing is going to answer this
	// request: no process is polling the queue and none will be launched, so
	// waiting out the deadline would report a slow bridge where the truth is
	// that there is no bridge. The error names the command, because "no live
	// Blender" without a next step is the kind of dead end that reads as a bug.
	if (!isLiveBridgeAlive()) {
		ensureLiveBridgeLaunched();
		if (!isLiveBridgeAlive()) {
			throw new NoWatchWindowError(String(options.payload.type ?? "unknown"));
		}
	}

	// Whether this request is racing a window that is still booting. Measured
	// AFTER the launch above, so it reflects the window that will actually
	// answer rather than the one that was absent a moment ago.
	const coldStart = !isHeartbeatFresh();

	const requestId = randomUUID();
	const requestPath = join(requestsDir, `${requestId}.json`);
	const responsePath = join(responsesDir, `${requestId}.json`);
	const tempRequestPath = join(requestsDir, `${requestId}.tmp`);
	await writeFile(
		tempRequestPath,
		JSON.stringify(
			{
				id: requestId,
				...options.payload,
			},
			null,
			2,
		),
		"utf-8",
	);
	await rename(tempRequestPath, requestPath);

	// A cold start (a window the user just opened with /blender-watch, still
	// booting) gets the longer budget; an already-running bridge does not.
	const deadline = Date.now() + (options.timeoutMs ?? (coldStart ? LIVE_BRIDGE_COLD_START_TIMEOUT_MS : LIVE_BRIDGE_TIMEOUT_MS));
	while (Date.now() < deadline) {
		if (await fileExists(responsePath)) {
			const responseRaw = await readFile(responsePath, "utf-8");
			await rm(responsePath, { force: true });
			let response: { ok: true; result: T } | { ok: false; error?: string; traceback?: string };
			try {
				response = JSON.parse(responseRaw) as typeof response;
			} catch (error) {
				throw new Error(
					`Failed to parse live Blender bridge response (${requestPath}): ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			if (!response.ok) {
				const details = response.traceback ? `\n\n${response.traceback}` : "";
				throw new Error(`${response.error ?? "Live Blender bridge request failed."}${details}`);
			}
			// The parsed JSON is cast, not validated, so `result` is only typed
			// T — a bridge that answered ok:true without a result would hand
			// every caller `undefined` and fail much later with a confusing
			// error. Check it while the response is still in hand.
			if (response.result === undefined) {
				throw new Error(
					`Live Blender bridge returned a success response with no result for request ${requestId} (${String(options.payload.type ?? "unknown")}).`,
				);
			}
			return response.result;
		}
		await delay(LIVE_BRIDGE_POLL_MS, options.signal);
	}

	await rm(requestPath, { force: true });
	const waitedSeconds = Math.round(
		(options.timeoutMs ?? (coldStart ? LIVE_BRIDGE_COLD_START_TIMEOUT_MS : LIVE_BRIDGE_TIMEOUT_MS)) / 1000,
	);
	// A timeout is ambiguous: the UI may be dead, or the script may still be
	// running long. Say which window elapsed and what to check instead of
	// implying the user simply forgot to open Blender.
	throw new Error(
		`Timed out after ${waitedSeconds}s waiting for the live Blender bridge (request: ${String(options.payload.type ?? "unknown")}). The request was withdrawn, but a long-running script may still be finishing inside Blender. Check blender_bridge_status, confirm the bridge script is loaded and the workspace .blend is open, then retry.`,
	);
}

export async function requestLiveBlenderCapture(options: {
	blendPath: string;
	viewName: string;
	cameraObjectName: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ cameraObjectName: string; cameraSettingsName: string | null; activeCameraName: string | null }> {
	return await requestLiveBlenderBridge({
		payload: {
			type: "capture-view",
			blendPath: options.blendPath,
			viewName: options.viewName,
			cameraObjectName: options.cameraObjectName,
			cameraSettingsName: `${options.cameraObjectName}.settings`,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderExecutePython(options: {
	blendPath: string;
	workspacePath: string;
	iterationPath: string;
	userScriptPath: string;
	saveBeforePath?: string;
	saveAfter: boolean;
	label?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number; changed: boolean }> {
	return await requestLiveBlenderBridge({
		payload: {
			type: "execute-python",
			blendPath: options.blendPath,
			workspacePath: options.workspacePath,
			iterationPath: options.iterationPath,
			userScriptPath: options.userScriptPath,
			saveBeforePath: options.saveBeforePath,
			saveAfter: options.saveAfter,
			label: options.label,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderOpenBlend(options: {
	blendPath: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ blendPath: string }> {
	return await requestLiveBlenderBridge({
		payload: {
			type: "open-blend",
			blendPath: options.blendPath,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderReloadBlend(options: {
	blendPath: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ blendPath: string }> {
	return await requestLiveBlenderBridge({
		payload: {
			type: "reload-blend",
			blendPath: options.blendPath,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderRender(options: {
	blendPath: string;
	cameraName?: string;
	outputPath: string;
	viewSource: BlenderRenderViewSource;
	viewportShading: BlenderViewportShading;
	resolution?: {
		x: number;
		y: number;
		percentage?: number;
	};
	samples?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{
	outputPath: string;
	cameraName: string | null;
	/**
	 * Present only on the background path, which sets the scene engine and
	 * reports which enum member it landed on. A live render goes through the
	 * viewport and never touches the engine, so it is absent.
	 */
	resolvedEngine?: string;
	resolution: { x: number; y: number; percentage: number };
}> {
	return await requestLiveBlenderBridge({
		payload: {
			type: "render",
			blendPath: options.blendPath,
			cameraName: options.cameraName,
			outputPath: options.outputPath,
			viewSource: options.viewSource,
			viewportShading: options.viewportShading,
			resolution: options.resolution,
			samples: options.samples,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderSetMode(options: {
	blendPath: string;
	mode: string;
	objectName?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<
	| { ok: true; mode: string; blenderMode: string; objectName: string; uvEditorOverlay: boolean }
	| { ok: false; mode: string; reason: string }
> {
	try {
		const switched = await requestLiveBlenderBridge<{
			mode: string;
			blenderMode: string;
			objectName: string;
			uvEditorOverlay: boolean;
		}>({
			payload: {
				type: "set-mode",
				blendPath: options.blendPath,
				mode: options.mode,
				objectName: options.objectName,
			},
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
		return { ok: true, ...switched };
	} catch (error) {
		// A viewport mode is the one result that cannot exist without a window:
		// it is a statement about a UI, and a headless Blender has no UI to be
		// in. Everything else the caller was going to do still happens -- the
		// paint is applied as bpy data either way -- so this reports what did
		// not happen rather than raising, and the tool result carries it, so
		// nobody has to notice a missing field to know the mode never switched.
		if (error instanceof NoWatchWindowError) {
			return { ok: false, mode: options.mode, reason: error.message };
		}
		throw error;
	}
}

export async function requestLiveBlenderWindowLayout(options: {
	blendPath?: string;
	format?: "json" | "image";
	screenshot?: boolean;
	as_image?: boolean;
	as_json?: boolean;
	area_type?: string;
	max_bytes?: number;
	output_path?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<WindowLayoutResult> {
	try {
		return await requestBridge<WindowLayoutResult>({
			payload: {
				type: "window-layout",
				blendPath: options.blendPath,
				format: options.format,
				screenshot: options.screenshot,
				as_image: options.as_image,
				as_json: options.as_json,
				area_type: options.area_type,
				max_bytes: options.max_bytes,
				output_path: options.output_path,
			},
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		if (error instanceof NoWatchWindowError) {
			return {
				ok: false,
				layout: null,
				areas: [],
				activeObject: null,
				selection: null,
				captured: false,
				reason: error.message,
			};
		}
		throw error;
	}
}

export async function requestLiveBlenderMontage(options: {
	views: string[];
	subject?: string[];
	columns?: number;
	panelResolution?: { x: number; y: number };
	outputDir: string;
	outputName?: string;
	blendPath: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<MontageResult> {
	return await requestBridge<MontageResult>({
		payload: {
			type: "montage",
			views: options.views,
			subject: options.subject,
			columns: options.columns,
			panelResolution: options.panelResolution,
			outputDir: options.outputDir,
			outputName: options.outputName,
			blendPath: options.blendPath,
		},
		signal: options.signal,
		// One render per panel, so the default render timeout would cut a
		// four-panel sheet off partway through.
		timeoutMs: options.timeoutMs ?? DEFAULT_MONTAGE_TIMEOUT_MS,
	});
}

export async function requestLiveBlenderCompare(options: {
	baselineBlendPath: string;
	baselineLabel?: string;
	currentLabel?: string;
	views: string[];
	subject?: string[];
	columns?: number;
	panelResolution?: { x: number; y: number };
	outputDir: string;
	outputName?: string;
	blendPath: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<CompareResult> {
	return await requestBridge<CompareResult>({
		payload: {
			type: "compare",
			baselineBlendPath: options.baselineBlendPath,
			baselineLabel: options.baselineLabel,
			currentLabel: options.currentLabel,
			views: options.views,
			subject: options.subject,
			columns: options.columns,
			panelResolution: options.panelResolution,
			outputDir: options.outputDir,
			outputName: options.outputName,
			blendPath: options.blendPath,
		},
		signal: options.signal,
		// Two generations of panels, and one of them renders after opening a
		// second blend, so this needs more than a single montage's budget.
		timeoutMs: options.timeoutMs ?? DEFAULT_COMPARE_TIMEOUT_MS,
	});
}

export async function requestLiveBlenderGeometryProbe(options: {
	blendPath: string;
	objects?: string[];
	pairs?: string[][];
	checks?: string[];
	specifications?: Record<string, GeometryProbeSpecification>;
	tolerance?: number;
	expectedAxis?: string;
	/** Metres; `clearance` and `path` sampling granularity. */
	cell?: number;
	/** Metres; `clearance` and `path` person reach. */
	body?: number;
	/** World [x, y] positions; implies the `path` check. */
	points?: [number, number][];
	/** `path` zig-zag threshold, default 1.45. */
	detour?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<GeometryProbeResult> {
	return await requestBridge<GeometryProbeResult>({
		payload: {
			type: "geometry-probe",
			// Named, and not optional: the windowed bridge always has the
			// workspace blend open, which is why this used to work without one.
			// Headless there is no session, so a probe with no blendPath would
			// measure whatever --factory-startup gave it and report it as the
			// workspace.
			blendPath: options.blendPath,
			objects: options.objects,
			pairs: options.pairs,
			checks: options.checks,
			specifications: options.specifications,
			tolerance: options.tolerance,
			expectedAxis: options.expectedAxis,
			cell: options.cell,
			body: options.body,
			points: options.points,
			detour: options.detour,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderReadOnlyPython(options: {
	blendPath: string;
	workspacePath: string;
	iterationPath: string;
	userScriptPath: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number; readOnly: true }> {
	return await requestBridge({
		payload: {
			type: "read-only-python",
			blendPath: options.blendPath,
			workspacePath: options.workspacePath,
			iterationPath: options.iterationPath,
			userScriptPath: options.userScriptPath,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderShutdown(options: {
	save?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{
	saved: boolean;
	savedPath: string | null;
	quitting: boolean;
	blendPath: string | null;
	wasDirty: boolean;
	saveError?: string;
	note?: string;
}> {
	// No `await` before the return: this wrapper adds nothing to the promise
	// it hands back, and awaiting it here would only widen the microtask gap
	// inside a shutdown path.
	return requestLiveBlenderBridge({
		payload: {
			type: "shutdown",
			save: options.save ?? true,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderSessionContext(options?: {
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<{
	blendPath: string | null;
	isSaved: boolean;
	isDirty: boolean;
	scene: {
		name: string | null;
		availableScenes: string[];
		frameCurrent: number | null;
		activeCameraName: string | null;
	};
	selection: {
		activeObject: { name: string; type: string } | null;
		selectedObjects: Array<{ name: string; type: string }>;
		selectedObjectCount: number;
	};
	mode: {
		mode: string | null;
		activeObjectType: string | null;
	};
	viewport: {
		hasViewport: boolean;
		areaSize: number | null;
		viewPerspective: string | null;
		shadingType: string | null;
		cameraName: string | null;
		isCameraView: boolean;
	};
}> {
	return await requestLiveBlenderBridge({
		payload: {
			type: "get-session-context",
		},
		signal: options?.signal,
		timeoutMs: options?.timeoutMs,
	});
}
