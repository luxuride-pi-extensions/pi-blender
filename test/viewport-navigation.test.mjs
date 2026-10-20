import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const bridge = await load("blender/bridge.ts");
const viewport = await load("blender/viewport.ts");
const workspace = await load("blender/workspace.ts");

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

test("WINDOW_ONLY_REQUEST_TYPES registers switch-workspace and focus-view", () => {
	assert.ok(
		bridge.WINDOW_ONLY_REQUEST_TYPES.has("switch-workspace"),
		"switch-workspace must be registered as window-only",
	);
	assert.ok(
		bridge.WINDOW_ONLY_REQUEST_TYPES.has("focus-view"),
		"focus-view must be registered as window-only",
	);
});

test("index.ts registers blender_switch_workspace and blender_focus_view in LAZY_BLENDER_TOOL_NAMES", () => {
	assert.match(
		indexSource,
		/"blender_switch_workspace"/,
		"blender_switch_workspace must be in LAZY_BLENDER_TOOL_NAMES",
	);
	assert.match(
		indexSource,
		/"blender_focus_view"/,
		"blender_focus_view must be in LAZY_BLENDER_TOOL_NAMES",
	);
});

test("tool descriptions state window-only semantics and graceful refusal", () => {
	const startSwitch = indexSource.indexOf('name: "blender_switch_workspace"');
	assert.notEqual(startSwitch, -1);
	const switchSection = indexSource.slice(startSwitch, startSwitch + 800);
	assert.match(switchSection, /switched:\s*false/);
	assert.match(switchSection, /Window-only/i);

	const startFocus = indexSource.indexOf('name: "blender_focus_view"');
	assert.notEqual(startFocus, -1);
	const focusSection = indexSource.slice(startFocus, startFocus + 800);
	assert.match(focusSection, /moved:\s*false/);
	assert.match(focusSection, /Window-only/i);
});

test("without watch window, blenderSwitchWorkspace reports switched: false with reason and does not throw", async () => {
	const cacheDir = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache");
	const root = mkdtempSync(join(cacheDir, "pi-blender-viewport-test-"));
	try {
		const ws = await workspace.blenderWorkspaceInit({ cwd: root, template: "blank" });
		const result = await viewport.blenderSwitchWorkspace({
			cwd: root,
			workspace: ws.workspacePath,
			workspaceName: "Modeling",
		});
		assert.equal(result.switched, false);
		assert.equal(result.moved, false);
		assert.ok(result.reason, "must report reason why workspace could not be switched");
		assert.match(result.reason, /window/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("without watch window, blenderFocusView reports moved: false with reason and does not throw", async () => {
	const cacheDir = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache");
	const root = mkdtempSync(join(cacheDir, "pi-blender-viewport-test-"));
	try {
		const ws = await workspace.blenderWorkspaceInit({ cwd: root, template: "blank" });
		const result = await viewport.blenderFocusView({
			cwd: root,
			workspace: ws.workspacePath,
			objectName: "Cube",
		});
		assert.equal(result.moved, false);
		assert.equal(result.focused, false);
		assert.ok(result.reason, "must report reason why view could not be focused");
		assert.match(result.reason, /window/i);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("live-bridge.py defines handle_switch_workspace and handle_focus_view", () => {
	const bridgePy = readFileSync(new URL("../blender/live-bridge.py", import.meta.url), "utf8");
	assert.match(bridgePy, /def handle_switch_workspace\(/);
	assert.match(bridgePy, /def handle_focus_view\(/);
	assert.match(bridgePy, /request_type == "switch-workspace"/);
	assert.match(bridgePy, /request_type == "focus-view"/);
});
