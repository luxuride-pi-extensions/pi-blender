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
 */

const INSPECT = ["blender_scene_info", "blender_bridge_status"] as const;

const MEASURE = ["blender_geometry_probe", "blender_read_only_python"] as const;

export const AGENT_TOOL_BUNDLES: Record<string, readonly string[]> = {
	"blender-manager": [
		"blender_workspace_init",
		"blender_scene_info",
		"blender_add_reference",
		"blender_module_revert",
		"blender_workspace_prune",
		"blender_build_status",
		"blender_build_advance",
		"blender_branch_run",
		"blender_branch_apply",
		"blender_bridge_status",
		"blender_log_critique",
		"blender_rank_assets",
		"blender_iteration_state",
		"blender_record_iteration_fact",
		"blender_export_asset",
		"blender_session_context",
	],
	"blender-worker": [
		"blender_module_run",
		"blender_branch_run",
		"blender_scene_info",
		"blender_geometry_probe",
		"blender_execute_python",
		"blender_read_only_python",
		"blender_session_context",
	],
	"blender-critic": [
		...INSPECT,
		"blender_log_critique",
		"blender_save_view",
		"blender_render",
		"blender_montage",
		"blender_compare",
		"blender_image_probe",
	],
	"blender-composition-critic": [
		...INSPECT,
		"blender_geometry_probe",
		"blender_log_critique",
		"blender_render",
		"blender_montage",
		"blender_image_probe",
	],
	"blender-camera-aligner": [
		...INSPECT,
		"blender_geometry_probe",
		"blender_save_view",
		"blender_render",
		"blender_execute_python",
	],
	"blender-finalizer": [
		...INSPECT,
		"blender_module_run",
		"blender_geometry_probe",
		"blender_execute_python",
		"blender_session_context",
		"blender_build_status",
		"blender_build_advance",
		"blender_export_asset",
	],
	"blender-merger": [
		...INSPECT,
		"blender_module_run",
		"blender_geometry_probe",
		"blender_execute_python",
		"blender_session_context",
		"blender_build_status",
		"blender_build_advance",
	],
	"blender-script-runner": [
		...INSPECT,
		"blender_module_run",
		"blender_branch_run",
		"blender_branch_apply",
		"blender_geometry_probe",
		"blender_module_revert",
			"blender_session_context",
	],
	"blender-diagnostician": [
		...INSPECT,
		...MEASURE,
		"blender_iteration_state",
		"blender_record_iteration_fact",
			"blender_session_context",
	],
	"blender-composition-planner": [...INSPECT, "blender_geometry_probe", "blender_image_probe"],
	"blender-composition-worker": [
		...INSPECT,
		"blender_module_run",
		"blender_montage",
		"blender_image_probe",
		...MEASURE,
	],
	"blender-composition-merger": [
		...INSPECT,
		"blender_module_run",
		"blender_montage",
		...MEASURE,
	],
	"blender-reference-describer": [],
};

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
	return `Agent "${agentName}" cannot call ${toolName}. Its bundle is: ${allowed.join(", ")}. Ask the manager for a role that owns this stage, or report the missing capability instead of working around it.`;
}
