// Every registered Blender tool must be reachable by somebody, and the
// manager's gate must say exactly what its prompt says it says.
//
// The branch pair was registered, documented and armed, but absent from the
// manager allowlist and every agent template, so the conflict-checked apply
// could not be called at all. Nothing caught it because the branch tests call
// the functions directly. These tests read the declared surfaces, not the
// implementations, which is the only layer where unreachability is visible.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

const indexSource = read("index.ts");
const managerBlock = indexSource.slice(
	indexSource.indexOf("const MANAGER_ALLOWED_TOOL_NAMES"),
	indexSource.indexOf("]);", indexSource.indexOf("const MANAGER_ALLOWED_TOOL_NAMES")),
);
const managerAllowed = new Set(
	[...managerBlock.matchAll(/^\s*"([a-z_]+)",?$/gm)].map((match) => match[1]),
);
const promptTools = new Set(
	read("blender/agents/blender-manager.md")
		.match(/^tools: (.*)$/m)[1]
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean),
);
const templateTools = new Set();
for (const file of readdirSync(new URL("blender/agents/", root)).filter((name) => name.endsWith(".md"))) {
	const line = read(`blender/agents/${file}`).match(/^tools: (.*)$/m);
	if (!line) continue;
	for (const name of line[1].split(",")) templateTools.add(name.trim());
}
const blenderTools = [
	...new Set([...read("core/tools.ts").matchAll(/name: "(blender_[a-z_]+)"/g)].map((match) => match[1])),
];

/**
 * Tools a user session may call but no orchestrated role is handed.
 *
 * These are interactive conveniences: a window layout, a docs search, a
 * one-off import. Listing them is the point of the test -- a registered tool
 * that is neither here nor in a `tools:` line is one nobody can call, which is
 * exactly how the branch pair disappeared.
 */
const USER_SESSION_ONLY = new Set([
	"blender_focus_view",
	"blender_get_python_api_docs",
	"blender_import_asset",
	"blender_job_status",
	"blender_object_detail",
	"blender_search_api_docs",
	"blender_search_manual_docs",
	"blender_set_mode",
	"blender_switch_workspace",
	"blender_usage_guess",
	"blender_window_layout",
]);

test("the manager allowlist and the manager prompt name the same tools", () => {
	const missingFromGate = [...promptTools].filter((name) => !managerAllowed.has(name)).sort();
	const missingFromPrompt = [...managerAllowed].filter((name) => !promptTools.has(name)).sort();
	assert.deepEqual(missingFromGate, [], "the prompt promises tools the gate refuses");
	assert.deepEqual(missingFromPrompt, [], "the gate grants tools the prompt never mentions");
});

test("every registered Blender tool is reachable by a role or named as user-session-only", () => {
	const reachable = new Set([...managerAllowed, ...templateTools]);
	const unreachable = blenderTools.filter((name) => !reachable.has(name) && !USER_SESSION_ONLY.has(name));
	assert.deepEqual(unreachable, [], "these tools are registered but no gate or template grants them");
});

test("the branch pair is granted to the manager that is told to apply branches", () => {
	const prompt = read("blender/agents/blender-manager.md");
	for (const name of ["blender_branch_run", "blender_branch_apply"]) {
		assert.ok(blenderTools.includes(name), `${name} must be registered`);
		assert.ok(managerAllowed.has(name), `${name} must be granted to the manager`);
	}
	assert.match(prompt, /blender_branch_apply/, "the prompt tells the manager to apply staged branches");

	const worker = read("blender/agents/blender-worker.md");
	assert.match(worker, /^tools: .*blender_branch_run/m, "a fanned-out worker must be able to stage");
	const runner = read("blender/agents/blender-script-runner.md");
	assert.match(runner, /^tools: .*blender_branch_run/m);
	assert.match(runner, /^tools: .*blender_branch_apply/m, "the serialization point must be able to merge");
});
