import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderBridgeDir } from "../config.js";
import { ensureLiveBridgeLaunched, isLiveBridgeAlive } from "../launch.js";
import type { BlenderRenderViewSource, BlenderViewportShading, GeometryProbeResult } from "./types.js";
import {
	acquireBridgeLock,
	delay,
	fileExists,
	LIVE_BRIDGE_COLD_START_TIMEOUT_MS,
	LIVE_BRIDGE_POLL_MS,
	LIVE_BRIDGE_TIMEOUT_MS,
} from "./utils.js";

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

async function runLockedBridgeRequest<T>(options: {
	payload: Record<string, unknown>;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<T> {
	const { requestsDir, responsesDir } = getLiveBridgePaths();

	// Lazy launch: if the UI is not running yet, start it before polling so
	// the first tool call doesn't just time out while Blender is booting.
	// "Alive" is liveness-based (bridge heartbeat), not just the launch
	// memory flag — a UI closed across /new is relaunched via
	// ensureLiveBridgeLaunched() at session start and re-checked here.
	const coldStart = !isLiveBridgeAlive();
	ensureLiveBridgeLaunched();

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

	// When this process just cold-launched the UI, give it a longer window to
	// boot (the caller's explicit timeoutMs still wins).
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
}): Promise<{ mode: string; blenderMode: string; objectName: string; uvEditorOverlay: boolean }> {
	return await requestLiveBlenderBridge({
		payload: {
			type: "set-mode",
			blendPath: options.blendPath,
			mode: options.mode,
			objectName: options.objectName,
		},
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});
}

export async function requestLiveBlenderGeometryProbe(options: {
	objects?: string[];
	pairs?: string[][];
	checks?: string[];
	tolerance?: number;
	expectedAxis?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}): Promise<GeometryProbeResult> {
	return await requestLiveBlenderBridge<GeometryProbeResult>({
		payload: {
			type: "geometry-probe",
			objects: options.objects,
			pairs: options.pairs,
			checks: options.checks,
			tolerance: options.tolerance,
			expectedAxis: options.expectedAxis,
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
