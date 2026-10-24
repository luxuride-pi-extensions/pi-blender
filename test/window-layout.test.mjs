import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const bridge = await load("blender/bridge.ts");
const windowLayout = await load("blender/window-layout.ts");
const launch = await load("launch.ts");

const toolsSource = readFileSync(new URL("../core/tools.ts", import.meta.url), "utf8");
const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
const designSource = readFileSync(new URL("../docs/DESIGN.md", import.meta.url), "utf8");
const bridgeSource = readFileSync(new URL("../blender/bridge.ts", import.meta.url), "utf8");

function toolDescription(name) {
	const start = toolsSource.indexOf(`name: "${name}"`);
	assert.notEqual(start, -1, `${name} is not registered in index.ts`);
	const from = toolsSource.indexOf("description:", start);
	assert.notEqual(from, -1, `${name} has no description`);
	const end = toolsSource.indexOf('",', from);
	assert.notEqual(end, -1, `${name}'s description never closes`);
	return toolsSource.slice(from, end);
}

test("blender_window_layout is registered with annotations", () => {
	assert.ok(toolsSource.includes('name: "blender_window_layout"'), "blender_window_layout is registered");
	// Slice the array rather than anchoring on it ending with this name: other
	// tool PRs append their own entries, and a name that is merely no longer
	// last is still declared.
	// #39 replaced the hand-written LAZY_BLENDER_TOOL_NAMES array with a
	// derivation from BLENDER_TOOLS, so membership is now structural: every
	// registered tool is lazy. Accept either shape, but require that this tool
	// IS in BLENDER_TOOLS, which is what membership now means.
	// The lazy list lives in index.ts (it is the pi registration surface), while
	// the tool roster lives in core/tools.ts after #39's extraction.
	const lazyStart = indexSource.indexOf("LAZY_BLENDER_TOOL_NAMES = [");
	if (lazyStart !== -1) {
		const lazyEnd = indexSource.indexOf("];", lazyStart);
		assert.ok(lazyEnd !== -1, "LAZY_BLENDER_TOOL_NAMES array never closes");
		assert.ok(
			indexSource.slice(lazyStart, lazyEnd).includes('"blender_window_layout"'),
			"blender_window_layout is declared in LAZY_BLENDER_TOOL_NAMES",
		);
	} else {
		assert.match(
			indexSource,
			/LAZY_BLENDER_TOOL_NAMES = BLENDER_TOOLS\.map\(/,
			"LAZY_BLENDER_TOOL_NAMES must be derived from BLENDER_TOOLS",
		);
		assert.match(
			toolsSource,
			/blenderWindowLayoutTool,/,
			"blender_window_layout must be in the BLENDER_TOOLS roster",
		);
	}

	// Find the tool registration block
	// core/tools.ts holds `CoreToolDefinition` literals, not `pi.registerTool({`
	// calls, so the block ends at the literal's closing brace at depth 0.
	const start = toolsSource.indexOf('name: "blender_window_layout"');
	assert.notEqual(start, -1, "blender_window_layout is defined in core/tools.ts");
	const from = toolsSource.lastIndexOf("{", start);
	let depth = 0;
	let blockEnd = from;
	for (; blockEnd < toolsSource.length; blockEnd += 1) {
		if (toolsSource[blockEnd] === "{") depth += 1;
		else if (toolsSource[blockEnd] === "}") {
			depth -= 1;
			if (depth === 0) break;
		}
	}
	const toolBlock = toolsSource.slice(from, blockEnd + 1);

	// readOnlyHint must be false: screenshot mode writes a PNG to a
	// caller-supplied output_path (blender/live-bridge.py:836). pi gates the
	// confirmation prompt on readOnlyHint, so claiming true here would let a
	// filesystem write through with no prompt.
	assert.match(toolBlock, /readOnlyHint:\s*false/, "must declare readOnlyHint: false in annotations");
	assert.match(toolBlock, /destructiveHint:\s*false/, "must declare destructiveHint: false in annotations");
	assert.match(toolBlock, /openWorldHint:\s*true/, "must declare openWorldHint: true in annotations");
});

test("blender_window_layout description states the byte cap and pixel_size awareness", () => {
	const description = toolDescription("blender_window_layout");
	assert.match(description, /500\s*KB|512,?000\s*bytes/i, "description must state the byte cap (500 KB / 512,000 bytes)");
	assert.match(description, /pixel_size/i, "description must mention pixel_size awareness");
	assert.match(description, /layout:\s*null/i, "description must document layout: null outcome when windowless");
	assert.match(description, /captured:\s*false/i, "description must document captured: false outcome when windowless");
});

test("window-only: registered in WINDOW_ONLY_REQUEST_TYPES in bridge.ts", () => {
	assert.match(
		bridgeSource,
		/WINDOW_ONLY_REQUEST_TYPES[\s\S]*?"window-layout"/,
		"window-layout must be registered in WINDOW_ONLY_REQUEST_TYPES",
	);
});

test("window-only: requestBridge rejects with NoWatchWindowError when no window is open", async () => {
	// With no live watch window running, requestBridge throws NoWatchWindowError
	await assert.rejects(
		() =>
			bridge.requestBridge({
				payload: { type: "window-layout" },
			}),
		(error) => {
			assert.equal(error.name, "NoWatchWindowError", `expected NoWatchWindowError, got: ${error.message}`);
			assert.equal(error.requestType, "window-layout");
			return true;
		},
	);
});

test("window-only: blenderWindowLayout reports layout: null and captured: false with a reason instead of throwing", async () => {
	// The tool wrapper converts the NoWatchWindowError into a graceful skip result
	const result = await windowLayout.blenderWindowLayout({ as_json: true });
	assert.equal(result.ok, false, "ok should be false when no window is active");
	assert.equal(result.layout, null, "layout should be null");
	assert.equal(result.captured, false, "captured should be false");
	assert.ok(typeof result.reason === "string" && result.reason.length > 0, "must report a reason");
	assert.match(result.reason, /watch/i, "reason should explain why (no watch window)");
});

test("window-only: requestLiveBlenderWindowLayout reports layout: null and captured: false instead of throwing", async () => {
	const result = await bridge.requestLiveBlenderWindowLayout({ as_json: true });
	assert.equal(result.ok, false);
	assert.equal(result.layout, null);
	assert.equal(result.captured, false);
	assert.ok(typeof result.reason === "string" && result.reason.length > 0);
});

test("docs/DESIGN.md records why image captures are capped rather than raw", () => {
	assert.match(
		designSource,
		/blender_window_layout/,
		"docs/DESIGN.md must document blender_window_layout",
	);
	assert.match(
		designSource,
		/blender_image_probe/,
		"docs/DESIGN.md must connect to blender_image_probe reasoning",
	);
	assert.match(
		designSource,
		/blender_montage/,
		"docs/DESIGN.md must connect to blender_montage reasoning",
	);
	assert.match(
		designSource,
		/byte-capped/i,
		"docs/DESIGN.md must record that image captures are byte-capped rather than raw",
	);
	assert.match(
		designSource,
		/pixel_size/i,
		"docs/DESIGN.md must record pixel_size awareness for HiDPI downscaling",
	);
});

// Real Blender execution tests (skip if Blender cannot be resolved)
const hasBlender = await (async () => {
	try {
		const { command, args } = await launch.resolveBlenderArgv();
		execFileSync(command, [...args, "--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

test("as_json returns layout, areas, active object and selection; asserts no image payload", { skip: !hasBlender }, async () => {
	const { command, args } = await launch.resolveBlenderArgv();
	const scriptPath = join(REPO, "blender", "live-bridge.py");
	const stdout = execFileSync(
		command,
		[...args, "--background", "--python", scriptPath, "--", JSON.stringify({ type: "window-layout", as_json: true }), "--serve"],
		{ encoding: "utf8" },
	);

	const start = stdout.indexOf("__PI_BLENDER_JSON_START__") + "__PI_BLENDER_JSON_START__".length;
	const end = stdout.indexOf("__PI_BLENDER_JSON_END__");
	assert.notEqual(start, -1, "response must have start marker");
	assert.notEqual(end, -1, "response must have end marker");

	const parsed = JSON.parse(stdout.slice(start, end).trim());
	assert.equal(parsed.ok, true, `expected ok: true, got ${stdout}`);
	const res = parsed.result;

	assert.equal(res.ok, true);
	assert.ok(res.layout, "result must contain layout");
	assert.ok(Array.isArray(res.layout.windows), "layout must contain windows list");
	assert.ok(Array.isArray(res.layout.screens), "layout must contain screens list");
	assert.ok(Array.isArray(res.areas), "result must contain areas list");
	assert.ok(res.areas.length > 0, "must report areas");

	// Active object and selection
	assert.ok(res.activeObject !== undefined, "activeObject must be present");
	assert.ok(res.selection, "selection must be present");
	assert.ok(Array.isArray(res.selection.selectedObjects), "selection.selectedObjects must be an array");
	assert.equal(typeof res.selection.selectedObjectCount, "number", "selection.selectedObjectCount must be a number");

	// Hard constraint: NO image payload for as_json
	assert.equal(res.captured, false, "captured must be false for as_json");
	assert.equal(res.imagePath, undefined, "imagePath must not be present");
	assert.equal(res.image, undefined, "image must not be present");
	assert.equal(res.imageData, undefined, "imageData must not be present");
	assert.equal(res.base64, undefined, "base64 must not be present");
});

test("downscale_image_to_size_limit downscales with pixel_size awareness and stays strictly under max_bytes", { skip: !hasBlender }, async () => {
	const { command, args } = await launch.resolveBlenderArgv();
	const testDir = mkdtempSync(join(tmpdir(), "pi-blender-downscale-"));
	try {
		const pythonScript = `
import sys, os, tempfile, json
import bpy, imbuf

sys.path.insert(0, ${JSON.stringify(join(REPO, "blender"))})
from importlib import import_module
bridge_mod = import_module("live-bridge")
downscale_func = bridge_mod.downscale_image_to_size_limit

# Create a synthetic large 2000x2000 image with color grid so file is large
test_dir = ${JSON.stringify(testDir)}
raw_path = os.path.join(test_dir, "test_raw.png")
out_path = os.path.join(test_dir, "test_out.png")

img = bpy.data.images.new("test_raw", 2000, 2000)
img.generated_type = "COLOR_GRID"
img.filepath_raw = raw_path
img.file_format = "PNG"
img.save()
raw_size = os.path.getsize(raw_path)

# Test 1: Byte cap of 40 KB
budget_40k = 40 * 1024
res_40k = downscale_func(raw_path, out_path, max_bytes=budget_40k)
size_40k = os.path.getsize(out_path)

# Test 2: Simulate HiDPI pixel_size = 2.0
out_hidpi = os.path.join(test_dir, "test_hidpi.png")
res_hidpi = downscale_func(raw_path, out_hidpi, max_bytes=1000 * 1024, pixel_size=2.0)

print("__RESULT__" + json.dumps({
    "raw_size": raw_size,
    "res_40k": res_40k,
    "size_40k": size_40k,
    "res_hidpi": res_hidpi,
}))
`;

		const stdout = execFileSync(
			command,
			[...args, "--background", "--python-expr", pythonScript],
			{ encoding: "utf8" },
		);

		const marker = "__RESULT__";
		const jsonIndex = stdout.indexOf(marker);
		assert.notEqual(jsonIndex, -1, `Could not find result marker in output: ${stdout}`);
		const result = JSON.parse(stdout.slice(jsonIndex + marker.length).trim().split("\n")[0]);

		// Check 40 KB cap
		assert.ok(result.size_40k <= 40 * 1024, `output size ${result.size_40k} exceeded 40 KB budget`);
		assert.equal(result.res_40k.maxBytes, 40 * 1024);
		assert.ok(result.res_40k.dimensions.width <= 2000);
		assert.ok(result.res_40k.dimensions.height <= 2000);

		// Check pixel_size awareness
		assert.equal(result.res_hidpi.pixelSize, 2.0, "should report pixelSize 2.0");
		// 2000 / 2.0 = 1000 width, 2000 / 2.0 = 1000 height
		assert.equal(result.res_hidpi.dimensions.width, 1000, "width should be downscaled by pixel_size 2.0");
		assert.equal(result.res_hidpi.dimensions.height, 1000, "height should be downscaled by pixel_size 2.0");
	} finally {
		rmSync(testDir, { recursive: true, force: true });
	}
});
