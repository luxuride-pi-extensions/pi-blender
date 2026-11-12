import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTs } from "./paths.mjs";

const { AGENT_TOOL_BUNDLES, blenderToolRefusal } = await loadTs("../blender/agent-policy.ts");

const AGENTS = [
	"blender-manager",
	"blender-worker",
	"blender-critic",
	"blender-composition-critic",
	"blender-camera-aligner",
	"blender-finalizer",
	"blender-merger",
	"blender-script-runner",
	"blender-diagnostician",
	"blender-composition-planner",
	"blender-composition-worker",
	"blender-composition-merger",
	"blender-reference-describer",
];

test("the user session is unrestricted and non-Blender tools are never policed", () => {
	assert.equal(blenderToolRefusal(null, "blender_module_run"), null);
	assert.equal(blenderToolRefusal("blender-worker", "read"), null);
});

test("a role can use exactly the Blender tools its bundle names", () => {
	assert.equal(blenderToolRefusal("blender-worker", "blender_branch_run"), null);
	assert.match(blenderToolRefusal("blender-critic", "blender_module_run") ?? "", /cannot call blender_module_run/);
	assert.match(blenderToolRefusal("blender-finalizer", "blender_branch_apply") ?? "", /cannot call/);
	assert.match(blenderToolRefusal("blender-unknown", "blender_scene_info") ?? "", /no Blender capability bundle/);
});

test("every bundle matches the tools: line in the agent definition", () => {
	for (const agent of AGENTS) {
		const source = readFileSync(new URL(`../blender/agents/${agent}.md`, import.meta.url), "utf8");
		const line = source.split("\n").find((entry) => entry.startsWith("tools:"));
		assert.ok(line, `${agent} has no tools: line`);
		const declared = line
			.slice("tools:".length)
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name.startsWith("blender_"))
			.sort();
		assert.deepEqual([...AGENT_TOOL_BUNDLES[agent]].sort(), declared, `${agent} bundle drifted from its tools: line`);
	}
});

test("the extension installs the gate before any tool can run", () => {
	const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
	assert.match(source, /registerBlenderCapabilityGate\(pi\)/);
	assert.match(source, /blenderToolRefusal\(agent, event\.toolName\)/);
	assert.match(source, /return \{ block: true, reason: refusal \}/);
});
