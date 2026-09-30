/**
 * End-to-end: the windowless tools against a real headless Blender.
 *
 * /blender no longer opens a window, so "no window" is the DEFAULT state of a
 * session, not a degraded one. These are the tools that have to keep working
 * there: a geometry probe, a read-only script, a montage.
 *
 * The point of routing them through live-bridge.py in --serve mode is that the
 * windowed and headless paths run the SAME handlers, so this file also pins the
 * two behaviours that could only diverge by accident:
 *
 *   - a request that genuinely needs a viewport refuses, with the reason, rather
 *     than returning a number derived from nothing;
 *   - a refusal is reported as the handler's own message, not as a crash, so the
 *     caller can act on it.
 *
 * Skipped rather than failed when no Blender is resolvable.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const bridge = await load("blender/bridge.ts");
const geometryProbe = await load("blender/geometry-probe.ts");
const readonly = await load("blender/readonly.ts");
const montage = await load("blender/montage.ts");
const workspace = await load("blender/workspace.ts");
const launch = await load("launch.ts");

/**
 * Force the no-window path even when the developer's own machine has a watch
 * window open. Otherwise these tests assert the live bridge's behaviour and
 * pass without exercising the headless one at all.
 */
process.env.PI_BLENDER_BRIDGE_DIR = mkdtempSync(join(homedir(), ".cache", "pi-blender-nowindow-"));

async function blenderAvailable() {
	try {
		const { command, args } = await launch.resolveBlenderArgv();
		execFileSync(command, [...args, "--version"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

const hasBlender = await blenderAvailable();
const skip = hasBlender ? false : "no headless Blender available on this machine";

function scratchRoot() {
	const base = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-blender", "test-scratch");
	mkdirSync(base, { recursive: true });
	return mkdtempSync(join(base, "nowindow-"));
}

async function makeWorkspace() {
	const root = scratchRoot();
	const created = await workspace.blenderWorkspaceInit({ cwd: root, template: "studio" });
	return { root, workspacePath: created.workspacePath, blendPath: created.blendPath };
}

/** A 2m box named `name`, at `x`, saved into the workspace blend. */
async function addBox(ws, name, x) {
	const utils = await load("blender/utils.ts");
	await utils.runBlenderJson({
		cwd: ws.root,
		blendPath: ws.blendPath,
		scriptSource: `
import bpy, json, sys
args = sys.argv[sys.argv.index("--") + 1:]
bpy.ops.mesh.primitive_cube_add(size=2, location=(float(args[1]), 0, 0))
bpy.context.object.name = args[2]
bpy.ops.wm.save_mainfile()
# runBlenderJson needs a result block; the cube is the point, this just satisfies it.
print("__PI_BLENDER_JSON_START__" + json.dumps({"ok": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
		// Name and x ride as trailing script arguments: args[0] is the JSON
		// payload every script in this codebase shares.
		scriptArgs: [String(x), name],
		timeoutMs: 120_000,
	});
}

test("a geometry probe measures the workspace blend with no window", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		await addBox(ws, "Box", 0);
		const result = await geometryProbe.blenderGeometryProbe({
			cwd: ws.root,
			workspace: ws.workspacePath,
			objects: ["Box"],
			checks: ["transform", "bounds"],
		});

		assert.deepEqual(Object.keys(result.objects), ["Box"]);
		assert.equal(result.objects.Box.bounds.size[0], 2, "a 2m cube should measure 2m across");
		assert.deepEqual(result.warnings, [], "a headless probe is reading exactly the workspace blend, so nothing should be warned about");
		assert.equal(
			result.matchesWorkspace,
			true,
			"headless reads the file it was asked for, so the live-session mismatch warning must not fire",
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a geometry probe finds a real gap between two objects with no window", { skip }, async () => {
	// The measurement is only worth having if it is the same measurement. Two
	// boxes with a known metre between them must measure as a metre apart, and
	// that answer comes from the same handler the windowed path uses.
	const ws = await makeWorkspace();
	try {
		await addBox(ws, "Near", 0);
		await addBox(ws, "Far", 5);
		const result = await geometryProbe.blenderGeometryProbe({
			cwd: ws.root,
			workspace: ws.workspacePath,
			pairs: [["Near", "Far"]],
			checks: ["pair"],
			tolerance: 0.002,
		});
		const pair = result.pairs["Near|Far"];
		assert.ok(pair, "the probe returned no pair measurement at all");
		assert.equal(pair.verdict, "separated");
		// Two 2m boxes centred 5m apart leave 3m between their surfaces.
		assert.ok(
			Math.abs(pair.closestSurfaceDistance - 3) < 0.01,
			`measured ${pair.closestSurfaceDistance} where the geometry puts 3m between the surfaces`,
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a read-only script runs with no window, and is still refused the mutating half", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		const measured = await readonly.blenderReadOnlyPython({
			cwd: ws.root,
			workspace: ws.workspacePath,
			script: `
import bpy
print("OBJECT_COUNT", len(bpy.data.objects))
`,
		});
		assert.equal(measured.exitCode, 0);
		assert.match(measured.stdout, /OBJECT_COUNT \d+/);
		assert.equal(measured.refused, false);

		// The guard is the reason to prefer this tool over a full script run, and
		// it lives in the bridge rather than in the prompt. Losing it headless
		// would make the safest measurement tool the one that can delete things.
		const refused = await readonly.blenderReadOnlyPython({
			cwd: ws.root,
			workspace: ws.workspacePath,
			script: `
import bpy
bpy.ops.object.delete()
`,
		});
		assert.equal(refused.refused, true, "a read-only script deleted an object, so the guard was not installed");
		assert.equal(refused.exitCode, 2);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a montage renders its panels headless", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		await addBox(ws, "Subject", 0);
		const result = await montage.blenderMontage({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "body",
			views: ["front", "three-quarter"],
			subject: ["Subject"],
		});

		assert.ok(existsSync(result.montagePath), `no sheet at ${result.montagePath}`);
		assert.equal(result.panelPaths.length, 2);
		for (const panel of result.panelPaths) {
			assert.ok(existsSync(panel), `no panel at ${panel}`);
		}
		assert.deepEqual(result.views, ["front", "three-quarter"]);
		assert.deepEqual(
			result.subject,
			["Subject"],
			"the sheet framed something other than what was asked for, which is the failure a fixed orbit is supposed to prevent",
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a viewport-only request refuses by name with no window", { skip }, async () => {
	// Not a fallback: a refusal, carrying the handler's own reason. Silently
	// returning a plausible-looking number from a headless process that never
	// had a viewport would be the worst possible outcome, because nothing in the
	// result would look wrong.
	await assert.rejects(
		() =>
			bridge.requestLiveBlenderSetMode({
				blendPath: join(homedir(), "does-not-matter.blend"),
				mode: "OBJECT",
			}),
		(error) => {
			assert.equal(error.name, "NoWatchWindowError", `expected a window error, got: ${error.message}`);
			assert.match(error.message, /\/blender-watch/);
			return true;
		},
	);
});

test("the headless bridge reports a handler's own error, not a crash", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		await assert.rejects(
			() =>
				bridge.requestBridge({
					payload: { type: "geometry-probe", objects: ["NoSuchObject"], blendPath: ws.blendPath },
					timeoutMs: 120_000,
				}),
			(error) => {
				// The handler's message, verbatim. A caller that wanted to
				// rename an object and typo'd it needs to see which name.
				assert.match(error.message, /NoSuchObject/);
				assert.match(error.message, /was not found/);
				return true;
			},
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("an unknown request type is refused by the bridge, not swallowed", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		await assert.rejects(
			() =>
				bridge.requestBridge({
					payload: { type: "not-a-request", blendPath: ws.blendPath },
					timeoutMs: 120_000,
				}),
			/not-a-request/,
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test.after(() => {
	rmSync(process.env.PI_BLENDER_BRIDGE_DIR, { recursive: true, force: true });
});