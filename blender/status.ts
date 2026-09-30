import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderBridgeDir } from "../config.js";
import { isLiveBridgeAlive } from "../launch.js";
import { resolveRunBudget } from "./concurrency.js";
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
	const headless = resolveRunBudget();
	const bridgeLine = !alive
		? "The live Blender UI is not running (stale or missing heartbeat). The next blender_* call will cold-launch it and may take up to ~120 s."
		: busy
			? "The live Blender UI is busy with another request. Wait for it to finish before mutating the scene; concurrent requests interleave in one shared session."
			: "The live Blender UI is idle and ready.";

	// The headless budget is stated whenever it binds, because the bridge line
	// above talks about ONE live UI and says nothing about the runs that do not
	// touch it. A manager fanning out to four workers needs to know it is
	// spending four headless processes, not queueing behind the bridge.
	const headlessLine = headless.clamped
		? ` Headless runs are capped at ${headless.effective} of the ${headless.requested} requested (${headless.reasons.join("; ")}).`
		: ` Headless runs may go up to ${headless.effective} at once.`;

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
		recommendation: `${bridgeLine}${headlessLine}`,
		headless: {
			requested: headless.requested,
			effective: headless.effective,
			clamped: headless.clamped,
			reasons: headless.reasons,
			warning: headless.warning ?? null,
		},
	};
}
