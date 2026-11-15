/**
 * Which Blender tools each subagent role may call.
 *
 * The agent frontmatter already limits the tool list pi-subagents hands a
 * child, but that is a launch-time declaration: a child that names a tool in a
 * script, or a definition that drifts from the code, is not checked by it. This
 * table is the runtime half of the same contract, enforced at the tool_call
 * boundary for every `blender_*` tool.
 *
 * The user's own session has no active agent and is deliberately unrestricted:
 * it is the one caller that may do anything. A child with a Blender role is
 * matched by name; an unknown `blender-*` agent is denied rather than trusted,
 * because a new role must state its capabilities here before it can mutate a
 * scene.
 *
 * Tool ownership lives once, in `CAPABILITY_BUNDLES`: five capability scopes
 * that say what each tool is for. A role is a composition of those scopes, and
 * `AGENT_TOOL_BUNDLES` is derived from it, so the refusal message, the MCP
 * surface and the runtime gate all read the same table instead of three lists
 * that drift. A role may hold only part of a scope -- a critic renders but does
 * not author a module -- which is why a composition names the tools it takes
 * from each scope rather than the whole scope. The validator below is what
 * keeps that honest: every name must be owned by the scope it is filed under.
 */

import { BLENDER_TOOL_NAMES } from "../core/tools.js";

export const CAPABILITY_BUNDLE_NAMES = [
	"blender.read",
	"blender.author",
	"blender.review",
	"blender.assemble",
	"blender.manage",
] as const;

export type CapabilityBundleName = (typeof CAPABILITY_BUNDLE_NAMES)[number];

/**
 * What each tool is for, independent of which role happens to hold it.
 *
 * A tool may appear in more than one scope when its purpose spans stages
 * (`blender_render` is both authoring output and review evidence); ownership is
 * "belongs to at least one", which is what the unowned-tool check enforces.
 */
export const CAPABILITY_BUNDLES: Record<CapabilityBundleName, readonly string[]> = {
	"blender.read": [
		"blender_session_context",
		"blender_scene_info",
		"blender_object_detail",
		"blender_geometry_probe",
		"blender_image_probe",
		"blender_read_only_python",
		"blender_bridge_status",
		"blender_usage_guess",
		"blender_get_python_api_docs",
		"blender_search_api_docs",
		"blender_search_manual_docs",
		"blender_job_status",
	],
	"blender.author": [
		"blender_workspace_init",
		"blender_module_run",
		"blender_branch_run",
		"blender_execute_python",
		"blender_save_view",
		"blender_render",
		"blender_add_reference",
		"blender_reference_search",
		"blender_import_asset",
		"blender_set_mode",
		"blender_switch_workspace",
		"blender_focus_view",
		"blender_window_layout",
	],
	"blender.review": [
		"blender_log_critique",
		"blender_montage",
		"blender_compare",
		"blender_image_probe",
		"blender_render",
		"blender_save_view",
	],
	"blender.assemble": [
		"blender_branch_apply",
		"blender_module_revert",
		"blender_export_asset",
		"blender_build_status",
		"blender_build_advance",
		"blender_workspace_prune",
	],
	"blender.manage": [
		"blender_workspace_init",
		"blender_workspace_prune",
		"blender_iteration_state",
		"blender_record_iteration_fact",
		"blender_rank_assets",
		"blender_session_context",
		"blender_job_status",
		"blender_job_cancel",
		"blender_build_status",
		"blender_build_advance",
	],
};

/** The slice of each capability a role holds, keyed by capability name. */
export type AgentCapabilityProfile = Partial<Record<CapabilityBundleName, readonly string[]>>;

export const AGENT_CAPABILITY_PROFILES: Record<string, AgentCapabilityProfile> = {
	"blender-manager": {
		"blender.read": ["blender_scene_info", "blender_bridge_status", "blender_session_context"],
		"blender.author": [
			"blender_workspace_init",
			"blender_add_reference",
			"blender_reference_search",
			"blender_branch_run",
		],
		"blender.review": ["blender_log_critique", "blender_compare"],
		"blender.assemble": [
			"blender_module_revert",
			"blender_branch_apply",
			"blender_export_asset",
			"blender_build_status",
			"blender_build_advance",
			"blender_workspace_prune",
		],
		"blender.manage": ["blender_rank_assets", "blender_iteration_state", "blender_record_iteration_fact"],
	},
	"blender-worker": {
		"blender.read": [
			"blender_scene_info",
			"blender_geometry_probe",
			"blender_read_only_python",
			"blender_session_context",
		],
		"blender.author": ["blender_module_run", "blender_branch_run", "blender_execute_python"],
	},
	"blender-critic": {
		"blender.read": ["blender_scene_info", "blender_bridge_status"],
		"blender.review": [
			"blender_log_critique",
			"blender_save_view",
			"blender_render",
			"blender_montage",
			"blender_compare",
			"blender_image_probe",
		],
	},
	"blender-composition-critic": {
		"blender.read": ["blender_scene_info", "blender_bridge_status", "blender_geometry_probe"],
		"blender.review": [
			"blender_log_critique",
			"blender_render",
			"blender_montage",
			"blender_image_probe",
		],
	},
	"blender-camera-aligner": {
		"blender.read": ["blender_scene_info", "blender_bridge_status", "blender_geometry_probe"],
		"blender.author": ["blender_save_view", "blender_render", "blender_execute_python"],
	},
	"blender-finalizer": {
		"blender.read": [
			"blender_scene_info",
			"blender_bridge_status",
			"blender_geometry_probe",
			"blender_session_context",
		],
		"blender.author": ["blender_module_run", "blender_execute_python"],
		"blender.assemble": ["blender_build_status", "blender_build_advance", "blender_export_asset"],
	},
	"blender-merger": {
		"blender.read": [
			"blender_scene_info",
			"blender_bridge_status",
			"blender_geometry_probe",
			"blender_session_context",
		],
		"blender.author": ["blender_module_run", "blender_execute_python"],
		"blender.assemble": ["blender_build_status", "blender_build_advance"],
	},
	"blender-script-runner": {
		"blender.read": [
			"blender_scene_info",
			"blender_bridge_status",
			"blender_geometry_probe",
			"blender_session_context",
		],
		"blender.author": ["blender_module_run", "blender_branch_run"],
		"blender.assemble": ["blender_branch_apply", "blender_module_revert"],
	},
	"blender-diagnostician": {
		"blender.read": [
			"blender_scene_info",
			"blender_bridge_status",
			"blender_geometry_probe",
			"blender_read_only_python",
			"blender_session_context",
		],
		"blender.manage": ["blender_iteration_state", "blender_record_iteration_fact"],
	},
	"blender-composition-planner": {
		"blender.read": [
			"blender_scene_info",
			"blender_bridge_status",
			"blender_geometry_probe",
			"blender_image_probe",
		],
	},
	"blender-composition-worker": {
		"blender.read": [
			"blender_scene_info",
			"blender_bridge_status",
			"blender_geometry_probe",
			"blender_image_probe",
			"blender_read_only_python",
		],
		"blender.author": ["blender_module_run"],
		"blender.review": ["blender_montage"],
	},
	"blender-composition-merger": {
		"blender.read": [
			"blender_scene_info",
			"blender_bridge_status",
			"blender_geometry_probe",
			"blender_read_only_python",
		],
		"blender.author": ["blender_module_run"],
		"blender.review": ["blender_montage"],
	},
	// A describer reads references, never a scene: an empty composition is a
	// declaration, not an omission, so the validator only rejects empty bundles.
	"blender-reference-describer": {},
};

function composeBundle(profile: AgentCapabilityProfile): readonly string[] {
	const tools: string[] = [];
	for (const name of CAPABILITY_BUNDLE_NAMES) {
		for (const tool of profile[name] ?? []) {
			if (!tools.includes(tool)) tools.push(tool);
		}
	}
	return tools;
}

/** Role -> tools, derived from `AGENT_CAPABILITY_PROFILES`. */
export const AGENT_TOOL_BUNDLES: Record<string, readonly string[]> = Object.fromEntries(
	Object.entries(AGENT_CAPABILITY_PROFILES).map(([role, profile]) => [role, composeBundle(profile)]),
);

export interface CapabilityBundleIssue {
	kind: "unknown-tool" | "unowned-tool" | "empty-bundle" | "unknown-capability" | "misplaced-tool";
	message: string;
}

export interface CapabilityBundleValidationInput {
	bundles?: Record<string, readonly string[]>;
	profiles?: Record<string, AgentCapabilityProfile>;
	registry?: readonly string[];
}

/**
 * Reports bundle drift instead of throwing at import time.
 *
 * The extension is loaded for every session, so a broken table must not brick
 * the editor; the test suite asserts this returns nothing and the failure lands
 * there, where it can be fixed, rather than in a user's first tool call.
 */
export function validateCapabilityBundles(input: CapabilityBundleValidationInput = {}): CapabilityBundleIssue[] {
	const bundles: Record<string, readonly string[]> = input.bundles ?? CAPABILITY_BUNDLES;
	const profiles = input.profiles ?? AGENT_CAPABILITY_PROFILES;
	const registry = new Set(input.registry ?? BLENDER_TOOL_NAMES);
	const issues: CapabilityBundleIssue[] = [];

	for (const [name, tools] of Object.entries(bundles)) {
		if (tools.length === 0) {
			issues.push({ kind: "empty-bundle", message: `Capability bundle "${name}" names no tools.` });
		}
		for (const tool of tools) {
			if (!registry.has(tool)) {
				issues.push({
					kind: "unknown-tool",
					message: `Capability bundle "${name}" names "${tool}", which is not in the BLENDER_TOOLS registry.`,
				});
			}
		}
	}

	const owned = new Set(Object.values(bundles).flat());
	for (const tool of registry) {
		if (!owned.has(tool)) {
			issues.push({
				kind: "unowned-tool",
				message: `"${tool}" is registered but belongs to no capability bundle, so no role can be granted it.`,
			});
		}
	}

	for (const [role, profile] of Object.entries(profiles)) {
		for (const [capability, tools] of Object.entries(profile)) {
			const bundle = bundles[capability];
			if (!bundle) {
				issues.push({
					kind: "unknown-capability",
					message: `Agent "${role}" composes "${capability}", which is not a capability bundle.`,
				});
				continue;
			}
			for (const tool of tools ?? []) {
				if (!bundle.includes(tool)) {
					issues.push({
						kind: "misplaced-tool",
						message: `Agent "${role}" files "${tool}" under "${capability}", which does not own it.`,
					});
				}
			}
		}
	}

	return issues;
}

/** The capability slices a role owns, as `name (tool, tool)` clauses. */
export function describeAgentCapabilities(agentName: string): string {
	const profile = AGENT_CAPABILITY_PROFILES[agentName] ?? {};
	const clauses = CAPABILITY_BUNDLE_NAMES.filter((name) => (profile[name] ?? []).length > 0).map(
		(name) => `${name} (${(profile[name] ?? []).join(", ")})`,
	);
	return clauses.length > 0 ? clauses.join("; ") : "none";
}

/** Tools that write files under the workspace rather than a Blender scene. */
export function blenderToolRefusal(agentName: string | null, toolName: string): string | null {
	if (agentName === null || !toolName.startsWith("blender_")) return null;
	const allowed = AGENT_TOOL_BUNDLES[agentName];
	if (!allowed) {
		// A user-defined agent may opt into a Blender tool in its own tools:
		// line; only our own roles are guaranteed to have a bundle.
		if (!agentName.startsWith("blender-")) return null;
		return `Agent "${agentName}" has no Blender capability bundle, so ${toolName} is refused. Add the role and its tools to blender/agent-policy.ts and to the agent's own tools: line.`;
	}
	if (allowed.includes(toolName)) return null;
	return `Agent "${agentName}" cannot call ${toolName}. Its capability bundles are: ${describeAgentCapabilities(agentName)}. Ask the manager for a role that owns this stage, or report the missing capability instead of working around it.`;
}
