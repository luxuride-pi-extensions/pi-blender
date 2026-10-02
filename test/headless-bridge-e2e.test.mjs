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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const exportAsset = await load("blender/export-asset.ts");
const ranking = await load("blender/ranking.ts");
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

/** A box with its own dimensions, for the scale contract to measure against. */
async function addSizedBox(ws, name, sx, sy, sz) {
	const utils = await load("blender/utils.ts");
	await utils.runBlenderJson({
		cwd: ws.root,
		blendPath: ws.blendPath,
		scriptSource: `
import bpy, json, sys
args = sys.argv[sys.argv.index("--") + 1:]
# args[0] is the JSON payload every script here shares, so the real arguments
# start at args[1].
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, float(args[5])))
bpy.context.object.scale = (float(args[2]), float(args[3]), float(args[4]))
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
bpy.context.object.name = args[1]
bpy.ops.wm.save_mainfile()
print("__PI_BLENDER_JSON_START__" + json.dumps({"ok": True}) + "__PI_BLENDER_JSON_END__")
`,
		payload: {},
		scriptArgs: [name, String(sx), String(sy), String(sz), String(sz / 2)],
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

test("the scale contract measures an object against the dimensions a brief named", { skip }, async () => {
	// A 0.9 x 0.6 x 0.94 m counter against a brief that asked for 900 x 600 x 900.
	// The height is 40mm over, which is inside nobody's tolerance for a worktop.
	const ws = await makeWorkspace();
	try {
		await addSizedBox(ws, "Counter", 0.9, 0.6, 0.94);
		const result = await geometryProbe.blenderGeometryProbe({
			cwd: ws.root,
			workspace: ws.workspacePath,
			objects: ["Counter"],
			specifications: { Counter: { width: 900, depth: "600mm", height: "0.9m" } },
			tolerance: 0.01,
		});

		assert.ok(result.checks.includes("scale"), `asking for specifications must imply the scale check, got ${result.checks}`);
		const entry = result.scaleContract.Counter;
		assert.equal(entry.status, "off-spec", `a 0.94m counter is not a 0.90m counter: ${entry.detail}`);
		assert.equal(entry.axes.width.measured, 0.9);
		assert.equal(entry.axes.width.withinTolerance, true, "900mm written bare and a 0.9m box are the same size");
		assert.equal(entry.axes.depth.target, 0.6, "600mm must normalize to 0.6m");
		assert.equal(entry.axes.height.withinTolerance, false);
		assert.ok(Math.abs(entry.axes.height.delta - 0.04) < 1e-6, `delta should be +0.04m, got ${entry.axes.height.delta}`);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("the scale contract catches a room built 1000x too large", { skip }, async () => {
	// The failure this check exists for: a scene built at the wrong scale is
	// internally consistent, so no render and no other measurement reports it.
	// A brief said "2400mm" ceiling, the build is 2.4m, and a worker that read
	// 2400 as metres produced a 2.4 KILOMETRE ceiling that still renders.
	const ws = await makeWorkspace();
	try {
		await addSizedBox(ws, "Room", 6000, 4000, 2400);
		const result = await geometryProbe.blenderGeometryProbe({
			cwd: ws.root,
			workspace: ws.workspacePath,
			objects: ["Room"],
			specifications: { Room: { width: 6000, depth: 4000, height: 2400 } },
		});

		const entry = result.scaleContract.Room;
		assert.equal(entry.status, "off-spec");
		assert.equal(entry.axes.height.target, 2.4, "a bare 2400 is 2400mm, which is how a brief writes a ceiling");
		assert.ok(entry.axes.width.ratio >= 999, `the report should make the 1000x mistake obvious, got ratio ${entry.axes.width.ratio}`);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("the scale contract reads a bare integer as millimetres and a bare decimal as metres", { skip }, async () => {
	// The same ceiling written two ways: "2400" and "2.4m" must compare equal,
	// or a brief that mixes styles reports a correct build as wrong.
	const ws = await makeWorkspace();
	try {
		await addSizedBox(ws, "Room", 6, 4, 2.4);
		const result = await geometryProbe.blenderGeometryProbe({
			cwd: ws.root,
			workspace: ws.workspacePath,
			objects: ["Room"],
			specifications: { Room: { width: 6000, depth: "4m", height: "2.4" } },
		});

		const entry = result.scaleContract.Room;
		assert.equal(entry.status, "on-spec", `2.4m and 2400mm are the same ceiling: ${entry.detail}`);
		assert.equal(entry.axes.depth.target, 4);
		assert.equal(entry.axes.height.target, 2.4, "a bare decimal is metres, so 2.4 is not 2.4mm");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("the scale contract reports a missing object instead of skipping it", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		await addSizedBox(ws, "Counter", 0.9, 0.6, 0.9);
		const result = await geometryProbe.blenderGeometryProbe({
			cwd: ws.root,
			workspace: ws.workspacePath,
			objects: ["Counter"],
			specifications: { Counter: { height: "900mm" }, Door: { height: "2100mm" } },
		});

		assert.equal(result.scaleContract.Counter.status, "on-spec", "a 0.9m counter against a 900mm spec is on-spec");
		assert.equal(result.scaleContract.Door.status, "missing");
		assert.match(result.scaleContract.Door.detail, /Door/, "the report has to name what it could not find");
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

/** A critique.log block exactly as blenderLogCritique writes one. */
function block(module, { score, validity, view = 2, decision }) {
	return [
		`[2026-01-01T00:00:00.000Z] iteration_01 module=${module} budget 1/5`,
		`Score: ${score}/12`,
		"Accuracy: 2/2",
		"Geometry & Proportions: 2/2",
		"Materials & Appearance: 2/2",
		"Completeness: 2/2",
		"Quality: 2/2",
		`Category validity: ${validity}/2`,
		`View adequacy: ${view}/2 — fine`,
		"Issues:",
		"- none",
		"Next action: present",
		decision,
		"",
	].join("\n");
}

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

test("an interior montage stands inside the room instead of orbiting it", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		// A room, not a prop: six walls with no ceiling in the way, so a camera
		// that framed the bounding sphere would be outside the building looking
		// at the outside of a wall.
		const utils = await load("blender/utils.ts");
		await utils.runBlenderJson({
			cwd: ws.root,
			blendPath: ws.blendPath,
			scriptSource: `
import bpy, json
def slab(name, location, scale):
    bpy.ops.mesh.primitive_cube_add(size=2, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return obj
slab("Floor", (0, 0, -0.05), (3.0, 2.0, 0.05))
slab("WallBack", (0, 2.0, 1.4), (3.0, 0.05, 1.4))
slab("WallLeft", (-3.0, 0, 1.4), (0.05, 2.0, 1.4))
slab("Counter", (1.6, 1.0, 0.45), (0.9, 0.4, 0.45))
bpy.ops.wm.save_mainfile()
print("__PI_BLENDER_JSON_START__" + json.dumps({"ok": True}) + "__PI_BLENDER_JSON_END__")
`,
			payload: {},
			timeoutMs: 120_000,
		});

		const result = await montage.blenderMontage({
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "room",
			views: ["interior-corner", "interior-corner-left"],
			subject: ["Floor", "WallBack", "WallLeft", "Counter"],
		});

		assert.equal(result.framing.family, "interior");
		assert.equal(result.framing.views.length, 2);
		for (const panel of result.framing.views) {
			assert.equal(panel.mode, "interior", `${panel.view} was placed on an orbit`);
			// The room spans roughly x -3..3, y -2..2, z -0.1..2.8. An eye
			// outside that box photographs the outside of a wall, so the bounds
			// are the assertion rather than a look at the images.
			assert.ok(panel.location[0] >= -3 && panel.location[0] <= 3, `${panel.view} eye x ${panel.location[0]}`);
			assert.ok(panel.location[1] >= -2 && panel.location[1] <= 2, `${panel.view} eye y ${panel.location[1]}`);
			assert.ok(panel.location[2] > 0.5 && panel.location[2] < 2.8, `${panel.view} eye z ${panel.location[2]}`);
		}
		// Two corners of one room must be two DIFFERENT views, or the sheet is
		// the same photograph twice.
		const [a, b] = result.framing.views;
		assert.notDeepEqual(a.target, b.target, "both corners aim at the same spot");

		for (const panel of result.panelPaths) {
			assert.ok(existsSync(panel), `no panel at ${panel}`);
		}
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("the two view families place the camera on opposite sides of the subject", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		await addBox(ws, "Subject", 0);
		const options = {
			cwd: ws.root,
			workspace: ws.workspacePath,
			moduleName: "body",
			subject: ["Subject"],
		};
		const orbit = await montage.blenderMontage({ ...options, views: ["front"] });
		const interior = await montage.blenderMontage({ ...options, views: ["interior-corner"] });

		// A 2m cube has no interior, but the placement is still well defined and
		// reported. The tool does not decide what counts as a room: it reports
		// where it put the eye so a caller can see a black panel's cause.
		assert.equal(interior.framing.family, "interior");
		assert.equal(interior.framing.views[0].mode, "interior");

		// The real invariant is the one that made interiors unrenderable: an
		// orbit eye sits OUTSIDE the bounding sphere, an interior eye inside it.
		const sphereRadius = orbit.framing.radius;
		const orbitEye = orbit.framing.views[0].location;
		const interiorEye = interior.framing.views[0].location;
		const inside = (point) => Math.hypot(...point.map((value, axis) => value - orbit.framing.center[axis])) < sphereRadius;
		assert.equal(inside(orbitEye), false, "an orbit eye is outside the subject by construction");
		assert.equal(inside(interiorEye), true, "an interior eye stands inside the subject");
		assert.ok(interiorEye[2] > 0, "and at a standing height rather than on the floor");
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

test("an asset exports to glTF headlessly, and the file is really there", { skip }, async () => {
	// The claim this whole feature makes is that the asset leaves Blender. A
	// reported path is not an asset, so the assertion is that a file exists with
	// a GLB header and the blend is untouched.
	const ws = await makeWorkspace();
	try {
		await addBox(ws, "Subject", 0);
		const out = join(ws.workspacePath, "exports");
		const result = await exportAsset.blenderExportAsset({
			cwd: ws.root,
			workspace: ws.workspacePath,
			format: "glb",
			objects: ["Subject"],
			outputDir: out,
			name: "subject",
		});

		assert.equal(result.format, "glb");
		assert.ok(existsSync(result.exportPath), `no export at ${result.exportPath}`);
		assert.ok(result.bytes > 0, "an export of zero bytes is a path, not an asset");
		// GLB is a binary container: the ASCII magic "glTF" then version 2.
		assert.equal(readFileSync(result.exportPath).subarray(0, 4).toString("ascii"), "glTF");
		assert.equal(result.meshCount >= 1, true);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("exporting a named object the blend does not have fails by name", { skip }, async () => {
	// Silently exporting the whole blend instead of the requested subset is the
	// failure this catches: it fills a dataset with studio cameras and lights
	// while the caller believes it selected the asset.
	const ws = await makeWorkspace();
	try {
		await addBox(ws, "Subject", 0);
		await assert.rejects(
			() =>
				exportAsset.blenderExportAsset({
					cwd: ws.root,
					workspace: ws.workspacePath,
					format: "glb",
					objects: ["Subject", "Nonexistent"],
					outputDir: join(ws.workspacePath, "exports"),
				}),
			/Nonexistent/,
			"an export that cannot find what it was asked for must name it, not proceed with something else",
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("an unsupported format is refused before Blender is ever spawned", { skip }, async () => {
	const ws = await makeWorkspace();
	try {
		await assert.rejects(
			() =>
				exportAsset.blenderExportAsset({
					cwd: ws.root,
					workspace: ws.workspacePath,
					format: "usd",
					outputDir: join(ws.workspacePath, "exports"),
				}),
			/Unsupported export format/,
		);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("the ranking keeps the best slice and says why when it cannot", { skip }, async () => {
	// A ranking is only useful if it refuses to pretend: a batch with nothing
	// presented has no selection, and saying so is the answer.
	const ws = await makeWorkspace();
	try {
		const log = join(ws.workspacePath, "critique.log");
		writeFileSync(
			log,
			[
				block("chair-a", { score: 9, validity: 2, decision: "Decision: present to user" }),
				block("chair-b", { score: 12, validity: 2, decision: "Decision: present to user" }),
				block("chair-c", { score: 11, validity: 1, decision: "Decision: present to user" }),
				block("stool", { score: 12, validity: 0, decision: "Decision: REJECT — the brief asked for a chair" }),
				block("table", { score: 12, validity: 2, decision: "Decision: present to user" }),
				"",
			].join(""),
			"utf-8",
		);
		const result = await ranking.blenderRankAssets({
			cwd: ws.root,
			workspace: ws.workspacePath,
			topFraction: 0.4,
		});

		assert.equal(result.eligible, 4, "four presented assets; the rejected stool is not one of them");
		assert.equal(result.selected.length, 2);
		assert.deepEqual(result.selected.map((a) => a.moduleName), ["chair-b", "table"], "two 12s, and the tie breaks on the name because both are equally valid");
		assert.equal(result.counts.reject, 1);
	} finally {
		rmSync(ws.root, { recursive: true, force: true });
	}
});

test("a viewport-only request refuses by name with no window", { skip }, async () => {
	// The REFUSAL is still real, and it still carries its own reason: silently
	// returning a plausible-looking mode from a process that never had a
	// viewport would be the worst possible outcome, because nothing in the result
	// would look wrong. requestBridge -- the generic entry point -- still throws.
	await assert.rejects(
		() =>
			bridge.requestBridge({
				payload: { type: "set-mode", blendPath: join(homedir(), "does-not-matter.blend"), mode: "OBJECT" },
			}),
		(error) => {
			assert.equal(error.name, "NoWatchWindowError", `expected a window error, got: ${error.message}`);
			assert.match(error.message, /\/blender-watch/);
			return true;
		},
	);
});

test("set-mode converts the refusal into a reported skip, and only that refusal", { skip }, async () => {
	// The tool boundary is where the refusal becomes an outcome, because an
	// agent cannot act on "open a window" -- only the user can. So the same
	// request returns ok:false here while requestBridge still throws, and a
	// caller that swallows one has not swallowed the other: a handler error
	// still propagates, because "the mode did not switch" and "the mode failed"
	// are different answers.
	const skipped = await bridge.requestLiveBlenderSetMode({
		blendPath: join(homedir(), "does-not-matter.blend"),
		mode: "OBJECT",
	});
	assert.equal(skipped.ok, false, "a windowless set-mode must report a skip rather than throw");
	assert.equal(skipped.mode, "OBJECT", "the requested mode comes back either way, so a caller reading `mode` is never handed undefined");
	assert.match(skipped.reason, /window/i, "the skip says why, because a silent false is indistinguishable from a mode that was never asked for");
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