import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderBridgeDir } from "../config.js";
import { isLiveBridgeAlive } from "../launch.js";
import type { BridgeStatusOptions, BridgeStatusResult } from "./types.js";
import { readBridgeLock } from "./utils.js";

/**
 * @param deps Injectable liveness check, so the busy/idle recommendation can be
 * exercised without a running Blender UI.
 */
export interface BridgeStatusDeps {
	isAlive?: () => boolean;
}

/**
 * Report whether the live Blender bridge can serve a request right now.
 *
 * Without this, a worker or manager that needs a fast answer either guesses
 * or burns a 30-120 s bridge timeout. The UI is a single mutable session, so
 * "busy" is a first-class state worth surfacing before mutating.
 */
export async function blenderBridgeStatus(
	options: BridgeStatusOptions,
	deps?: BridgeStatusDeps,
): Promise<BridgeStatusResult> {
	const bridgeDir = getBlenderBridgeDir();
	const requestsDir = join(bridgeDir, "requests");
	const alive = (deps?.isAlive ?? isLiveBridgeAlive)();
	const lock = await readBridgeLock();

	let pendingRequests = 0;
	try {
		const entries = await readdir(requestsDir);
		pendingRequests = entries.filter((name) => name.endsWith(".json")).length;
	} catch {
		pendingRequests = 0;
	}

	const busy = lock !== null || pendingRequests > 0;
	const recommendation = !alive
		? "The live Blender UI is not running (stale or missing heartbeat). The next blender_* call will cold-launch it and may take up to ~120 s."
		: busy
			? "The live Blender UI is busy with another request. Wait for it to finish before mutating the scene; concurrent requests interleave in one shared session."
			: "The live Blender UI is idle and ready.";

	return {
		alive,
		busy,
		pendingRequests,
		lock: lock
			? {
					pid: lock.pid,
					label: lock.label,
					acquiredAt: lock.acquiredAt,
					ageMs: lock.ageMs,
				}
			: null,
		bridgeDir,
		requestsDir,
		workspacePath: options.workspace ?? null,
		recommendation,
	};
}
