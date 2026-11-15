/**
 * Capability bundles: the one table that says what each Blender tool is for.
 *
 * The failure these tests exist for is drift, not behaviour: a tool added to
 * the registry but to no bundle is invisible to every role and to the MCP
 * façade, and a role that files a tool under the wrong capability reports a
 * surface it cannot actually use. Both are silent at runtime, so they are
 * asserted here.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./paths.mjs";

const { BLENDER_TOOLS, BLENDER_TOOL_NAMES } = await loadTs("../core/tools.ts");
const {
	AGENT_CAPABILITY_PROFILES,
	AGENT_TOOL_BUNDLES,
	CAPABILITY_BUNDLES,
	CAPABILITY_BUNDLE_NAMES,
	describeAgentCapabilities,
	validateCapabilityBundles,
} = await loadTs("../blender/agent-policy.ts");

/** The repository's own estimate; the schema-budget test uses the same one. */
const CHARS_PER_TOKEN = 3.6;

function estimatedTokens(toolNames) {
	const byName = new Map(BLENDER_TOOLS.map((tool) => [tool.name, tool]));
	let characters = 0;
	for (const name of toolNames) {
		const tool = byName.get(name);
		assert.ok(tool, `${name} is not in the registry`);
		characters += JSON.stringify({ description: tool.description, parameters: tool.parameters }).length;
	}
	return Math.ceil(characters / CHARS_PER_TOKEN);
}

test("the tree has no capability-bundle drift", () => {
	assert.deepEqual(validateCapabilityBundles(), []);
});

test("each capability bundle is declared once and owns the tools it names", () => {
	assert.deepEqual(Object.keys(CAPABILITY_BUNDLES), [...CAPABILITY_BUNDLE_NAMES]);
	for (const name of CAPABILITY_BUNDLE_NAMES) {
		assert.ok(CAPABILITY_BUNDLES[name].length > 0, `${name} must not be empty`);
	}
	const owned = new Set(Object.values(CAPABILITY_BUNDLES).flat());
	assert.deepEqual(
		BLENDER_TOOL_NAMES.filter((name) => !owned.has(name)),
		[],
		"these registered tools belong to no capability bundle",
	);
});

test("the validator names each kind of drift", () => {
	const registry = ["blender_scene_info", "blender_render", "blender_export_asset"];
	const bundles = {
		"blender.read": ["blender_scene_info", "blender_missing_tool"],
		"blender.author": ["blender_render"],
		"blender.review": [],
		"blender.assemble": [],
		"blender.manage": [],
	};
	const profiles = {
		"blender-manager": { "blender.read": ["blender_scene_info"], "blender.nonexistent": [] },
		"blender-worker": { "blender.read": ["blender_export_asset"] },
	};
	const kinds = new Set(
		validateCapabilityBundles({ bundles, profiles, registry }).map((issue) => issue.kind),
	);
	assert.deepEqual(
		[...kinds].sort(),
		["empty-bundle", "misplaced-tool", "unknown-capability", "unknown-tool", "unowned-tool"],
	);
});

test("every agent bundle is a composition of declared capabilities", () => {
	for (const [role, profile] of Object.entries(AGENT_CAPABILITY_PROFILES)) {
		for (const capability of Object.keys(profile)) {
			assert.ok(
				CAPABILITY_BUNDLE_NAMES.includes(capability),
				`${role} references unknown capability ${capability}`,
			);
		}
		for (const tool of AGENT_TOOL_BUNDLES[role]) {
			assert.ok(BLENDER_TOOL_NAMES.includes(tool), `${role} names unregistered tool ${tool}`);
		}
	}
});

// The critic reads renders and writes critique records, nothing else. If a
// finalize or export tool ever reaches this list, the role's whole safety story
// ("judge, do not fix") is gone.
test("the critic holds no mutating stage tools", () => {
	const critic = AGENT_TOOL_BUNDLES["blender-critic"];
	for (const forbidden of [
		"blender_branch_apply",
		"blender_export_asset",
		"blender_module_run",
		"blender_execute_python",
	]) {
		assert.ok(!critic.includes(forbidden), `the critic must not hold ${forbidden}`);
	}
});

test("the critic's schema stays inside its token budget", () => {
	const tokens = estimatedTokens(AGENT_TOOL_BUNDLES["blender-critic"]);
	assert.ok(tokens < 4000, `the critic bundle costs ~${tokens} tokens; the budget is 4000`);
});

test("the refusal names the capability bundles the role owns", () => {
	const message = describeAgentCapabilities("blender-critic");
	assert.match(message, /blender\.read \(/);
	assert.match(message, /blender\.review \(/);
	assert.doesNotMatch(message, /blender\.assemble/);
});
