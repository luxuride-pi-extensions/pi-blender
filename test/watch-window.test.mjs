/**
 * The window authorization gate: a window exists if and only if
 * /blender-watch asked for one, and there is never more than one.
 *
 * WHY THIS NEEDS A CHILD PROCESS. The gate is a marker file in the bridge dir
 * and three module-level flags (bridgeLaunchStarted, bridgeSpawnInFlight, the
 * supervision token), and jiti caches modules per process. An in-process test
 * would authorize the window with one instance and read the other instance's
 * memory back, so it would be testing a state no real session can be in. The
 * staged-copy harness exists for exactly this and is documented there.
 *
 * WHY A FAKE BLENDER. Nothing here may open a window. `stageFakeBlender({
 * recordEach: true })` records one line per spawn, which is what makes the COUNT
 * assertable — and the count is the entire claim, since "at most one window"
 * is indistinguishable from "a relaunch loop" when you can only observe that
 * something launched.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { loadTs } from "./paths.mjs";
import {
	cleanupSandboxes,
	countLaunches,
	readDriverJson,
	runDriver,
	stageBridgeDir,
	stageExtension,
	stageFakeBlender,
} from "./launch-harness.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DRIVER = join(REPO, "test", "launch-guard-driver.mjs");

after(cleanupSandboxes);

/** The watch driver, against a staged launcher, counting spawns. */
function runWatch({ watchAuthorized = true } = {}) {
	const staged = stageExtension({ withScripts: true });
	const blender = stageFakeBlender({ recordEach: true });
	const bridge = stageBridgeDir();
	const result = runDriver(DRIVER, staged, ["watch"], {
		bridge,
		blender: blender.path,
		launched: true,
		watchAuthorized,
	});
	if (result.status !== 0) {
		assert.fail(`watch driver failed (${result.status}): ${result.stderr}`);
	}
	return { ...readDriverJson(result), launches: () => countLaunches(blender.record), bridge };
}

describe("the watch window authorization gate", () => {
	it("does not launch a window for a session that never ran /blender-watch", () => {
		const run = runWatch({ watchAuthorized: false });
		assert.equal(
			run.unauthorizedLaunches,
			0,
			"ensureLiveBridgeLaunched spawned a Blender with no authorization on disk. A tool call must never bring a window up behind the user's back.",
		);
	});

	it("does not let the supervisor relaunch a window that was never authorized", () => {
		const run = runWatch({ watchAuthorized: false });
		assert.equal(
			run.supervisorUnauthorized,
			0,
			"a supervisor tick launched an unauthorized window. The gate has to be on the force path too, or closing the window starts a relaunch loop.",
		);
	});

	it("opens exactly one window when /blender-watch asks", () => {
		// The sandbox starts unauthorized, so the launch counted here is one
		// the authorization alone produced.
		const run = runWatch({ watchAuthorized: false });
		assert.equal(run.authorizedLaunches, 1, "requestWatchWindowLaunch did not open the window it is the only authorized path to opening.");
	});

	it("opens no second window on a second /blender-watch", () => {
		const run = runWatch({ watchAuthorized: false });
		assert.equal(
			run.afterSecondWatch,
			1,
			"a second /blender-watch added a window. The rule is at most one windowed Blender per session, and the authorization marker is what enforces it.",
		);
	});

	it("leaves the authorization on disk so a /reload does not re-gate the running window", () => {
		const run = runWatch({ watchAuthorized: false });
		assert.ok(
			existsSync(join(run.bridge, "watch-window.json")),
			"the watch-window.json marker is gone. It is deliberately durable: /reload rebuilds the module while the window keeps running, so a flag in module state would read false and the next tool call would launch a second window.",
		);
	});
});

describe("the authorization marker", () => {
	/** Load the real launch module in-process for a pure file assertion. */
	async function withLaunch(fn) {
		const bridge = stageBridgeDir();
		const previous = process.env.PI_BLENDER_BRIDGE_DIR;
		process.env.PI_BLENDER_BRIDGE_DIR = bridge;
		try {
			const launch = await loadTs(join(REPO, "launch.ts"));
			return await fn(launch, bridge);
		} finally {
			if (previous === undefined) delete process.env.PI_BLENDER_BRIDGE_DIR;
			else process.env.PI_BLENDER_BRIDGE_DIR = previous;
		}
	}

	it("authorizing creates the marker and withdrawing removes it", async () => {
		await withLaunch(async (launch, bridge) => {
			const marker = join(bridge, "watch-window.json");
			assert.equal(existsSync(marker), false, "a staged bridge dir must start unauthorized");
			launch.authorizeWatchWindow();
			assert.ok(existsSync(marker), "authorizeWatchWindow did not write the marker");
			launch.unauthorizeWatchWindow();
			assert.equal(existsSync(marker), false, "unauthorizeWatchWindow did not remove the marker");
		});
	});

	it("withdrawing is safe when there was nothing to withdraw", async () => {
		// A missing marker is the normal state of a session that never ran
		// /blender-watch, and shutdown calls this unconditionally. Throwing here
		// would turn "no window" into a shutdown failure.
		await withLaunch(async (launch) => {
			launch.unauthorizeWatchWindow();
			launch.unauthorizeWatchWindow();
		});
	});
});

describe("the headless fallback contract", () => {
	it("NoWatchWindowError is a class, so a fallback keys on instanceof rather than on a message", async () => {
		const bridge = await loadTs(join(REPO, "blender", "bridge.ts"));
		assert.equal(typeof bridge.NoWatchWindowError, "function", "NoWatchWindowError is not exported");
		const error = new bridge.NoWatchWindowError("execute_python");
		assert.ok(error instanceof Error);
		assert.ok(error instanceof bridge.NoWatchWindowError, "the error does not survive instanceof, so no caller can fall back on it");
		assert.equal(error.requestType, "execute_python", "the error lost the request type that names what had no window to run in");
		// The message is the fallback's LAST resort, so it has to name the command
		// the user can actually run, not merely report the absence.
		assert.match(error.message, /\/blender-watch/);
	});

	it("a render result says whether it fell back, so a caller never mistakes the two images", async () => {
		// A viewport screenshot and a background render are judged differently, and
		// a critic that cannot tell which one it is looking at is being asked a
		// question with no answer. This asserts the field exists on the type the
		// render path returns.
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(join(REPO, "blender", "types.ts"), "utf-8");
		assert.match(source, /fellBackToBackground: boolean;/, "RenderResult lost fellBackToBackground");
	});
});
