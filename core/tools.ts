/**
 * Transport-agnostic core Blender capability tools.
 *
 * Imports NO pi symbol: structured so tools can be consumed by pi (in index.ts)
 * or by any MCP client (via core/mcp-server.ts).
 */

import { Type } from "typebox";
import {
	blenderAddReference,
	blenderBranchApply,
	blenderBranchRun,
	blenderBridgeStatus,
	blenderExecutePython,
	blenderGeometryProbe,
	blenderImageProbe,
	blenderLogCritique,
	blenderRankAssets,
	blenderIterationState,
	blenderRecordIterationFact,
	blenderExportAsset,
	blenderModuleRevert,
	blenderModuleRun,
	blenderMontage,
	blenderReadOnlyPython,
	blenderRender,
	blenderSaveView,
	blenderSceneInfo,
	blenderSessionContext,
	blenderSetMode,
	blenderWorkspaceInit,
} from "../blender/runtime.js";
import type { AssetExportOptions } from "../blender/types.js";
import { blenderCompare } from "../blender/compare.js";
import type { CoreToolDefinition, CoreToolContext, CoreToolResult } from "./types.js";

export function formatJsonResult(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

export const blenderWorkspaceInitTool: CoreToolDefinition = {
	name: "blender_workspace_init",
	label: "Blender Workspace Init",
	description:
		"Create or reopen a managed Blender workspace with a persistent model.blend and workspace manifest, and auto-open that blend in the live Blender session when available.",
	parameters: Type.Object({
		workspace: Type.Optional(
			Type.String({
				description: "Explicit workspace path. Relative paths resolve from the current working directory.",
			}),
		),
		sourceBlend: Type.Optional(
			Type.String({
				description: "Optional source .blend file to copy into the workspace as the starting model.blend.",
			}),
		),
		template: Type.Optional(
			Type.Union(
				[
					Type.Literal("studio"),
					Type.Literal("blank"),
				],
				{
					description:
						'Workspace template. "studio" (recommended) starts an empty file with a camera, a three-point light rig, a neutral world and EEVEE at 1200x900, so the first worker can model immediately instead of building a shot first. "blank" saves Blender\'s startup file as-is, with no camera or lights. Ignored when sourceBlend is given, since the source scene brings its own setup.',
					default: "studio",
				},
			),
		),
		continueExisting: Type.Optional(
			Type.Boolean({
				description: "When true, require the workspace to exist already instead of creating a new one.",
				default: false,
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderWorkspaceInit({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			sourceBlend: params.sourceBlend,
			template: params.template,
			continueExisting: params.continueExisting,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderExecutePythonTool: CoreToolDefinition = {
	name: "blender_execute_python",
	label: "Blender Execute Python",
	description:
		"Copy a Blender Python script into a run directory, execute it inside the live bridge-enabled Blender session for the workspace, and persist the updated model.blend so the UI stays in sync. By default the run claims a numbered iteration slot; pass claimIteration=false for throwaway runs so it does not count as progress.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		script_path: Type.String({
			description:
				"Path to the existing Blender Python script to snapshot and execute. Use the workspace root script.py.",
		}),
		saveBefore: Type.Optional(
			Type.Boolean({
				description: "If true, copy the current model.blend into the iteration folder before execution.",
				default: false,
			}),
		),
		saveAfter: Type.Optional(
			Type.Boolean({
				description: "If true, save the updated Blender scene back to model.blend after execution.",
				default: true,
			}),
		),
		claimIteration: Type.Optional(
			Type.Boolean({
				description:
					"If false, run without claiming a numbered iteration_NN slot — the copied script and log still go to a private runs/ad-hoc/<id>/ directory, so nothing clobbers, but the run does not advance latestIteration. Use false for throwaway work such as a camera nudge or a one-off inspection, and true (the default) for a change you would describe as progress. Claiming every ad-hoc run makes the iteration numbers in critique.log stop corresponding to anything readable.",
				default: true,
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: "Execution timeout in seconds.",
				default: 120,
			}),
		),
		label: Type.Optional(
			Type.String({
				description: "Optional label for the iteration step.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderExecutePython({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			script_path: params.script_path,
			saveBefore: params.saveBefore,
			saveAfter: params.saveAfter,
			claimIteration: params.claimIteration,
			timeoutSeconds: params.timeoutSeconds,
			label: params.label,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderSessionContextTool: CoreToolDefinition = {
	name: "blender_session_context",
	label: "Blender Session Context",
	readOnly: true,
	description:
		"Read the LIVE Blender session: the open blend path, active scene, current mode, active object, selected objects, viewport state, unsaved changes, and whether another pi session holds the same blend. This is the only source of truth for present-tense Blender state — for 'what is selected', 'update it', 'render from what I'm looking at', or any claim about what Blender currently shows. `blender_scene_info` is NOT that: it reads the last SAVED blend file, so it never sees a worker's in-flight edits or a change made by hand and not saved. Call it before mutating anything.",
	parameters: Type.Object({
		workspace: Type.Optional(
			Type.String({
				description:
					"Optional workspace path to compare against the live Blender session. Relative paths resolve from the current working directory.",
			}),
		),
		include: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("file"),
					Type.Literal("scene"),
					Type.Literal("selection"),
					Type.Literal("mode"),
					Type.Literal("viewport"),
				]),
				{
					description:
						"Optional live session categories to include. Omit to return the full live Blender session context.",
					uniqueItems: true,
				},
			),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderSessionContext({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			include: params.include,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderSceneInfoTool: CoreToolDefinition = {
	name: "blender_scene_info",
	label: "Blender Scene Info",
	readOnly: true,
	description:
		'Read the workspace blend file as it was last SAVED, and return its structure: objects, collections, materials, cameras, lights, render settings, UVs, armatures, textures and paint settings. Nothing unsaved in the open Blender is visible here — a worker\'s in-flight edits are not on disk yet, and a session that has changed something by hand has not saved it. This is the right tool for the SAVED STATE of a build ("what objects exist", "what materials are assigned"). For what the UI currently shows — the open file, the selection, the mode, the viewport, unsaved changes, or another session holding the same blend — use `blender_session_context`, which reads the live Blender and is the only source of truth for present-tense state. Prefer a narrow `categories` list such as `["objects"]`, `["materials"]`, or `["cameras", "cameraSettings"]` when you only need one or a few sections. Omit `categories` only when you truly need the full scene info payload.',
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		categories: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("objects"),
					Type.Literal("collections"),
					Type.Literal("materials"),
					Type.Literal("cameras"),
					Type.Literal("cameraSettings"),
					Type.Literal("lights"),
					Type.Literal("views"),
					Type.Literal("renderSettings"),
					Type.Literal("uv"),
					Type.Literal("armatures"),
					Type.Literal("textures"),
					Type.Literal("paintSettings"),
				]),
				{
					description:
						"Optional scene info categories to inspect. Pass one category to inspect only that section, or pass a short list for a subset. For paint/UV/rig work add `uv`, `textures`, `armatures`, and `paintSettings`. These all describe the last SAVED blend file, not live UI state. Omit `categories` only when you need all available scene info sections.",
					uniqueItems: true,
				},
			),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderSceneInfo({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			categories: params.categories,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderSaveViewTool: CoreToolDefinition = {
	name: "blender_save_view",
	label: "Blender Save View",
	description:
		"Save a named render view in the workspace manifest. With source=active-camera, capture the current live Blender UI viewport into a dedicated camera object; otherwise bind the view to an existing camera object. source=active-camera photographs what the UI currently shows, including unsaved edits, so with no window open it reports savedView:null with a reason rather than failing — binding the view to a camera name works headlessly and is the right source when there is no window. Nothing is written to the manifest when the capture is skipped, so a later render cannot pick up a view bound to a camera that was never created.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		name: Type.String({
			description: "Saved view name to store in the workspace manifest.",
		}),
		source: Type.String({
			description:
				'Either "active-camera" to capture the current Blender UI view, or a camera object name already present in the scene.',
		}),
		camera_name: Type.Optional(
			Type.String({
				description:
					'Optional dedicated camera object name to use when source is "active-camera". Defaults to the saved view name.',
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderSaveView({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			name: params.name,
			source: params.source,
			camera_name: params.camera_name,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderRenderTool: CoreToolDefinition = {
	name: "blender_render",
	label: "Blender Render",
	description:
		"Render the workspace blend file and write outputs into the current iteration. Use renderMethod=`live` for viewport renders and renderMethod=`background` for normal headless scene renders. Live renders default to camera-based framing with viewportShading=`material-preview`; switch to viewSource=`current-view` only when the user explicitly wants the raw current viewport. Live viewport renders disable overlays automatically so grids, axes, and other viewport clutter are not captured. Background renders are camera-based and use renderEngine overrides such as `eevee`, `cycles`, or `workbench` instead of viewport shading modes.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		view: Type.Optional(
			Type.String({
				description: 'Optional saved view name, camera name, or "active-camera".',
			}),
		),
		resolution: Type.Optional(
			Type.Object({
				x: Type.Number(),
				y: Type.Number(),
				percentage: Type.Optional(Type.Number()),
			}),
		),
		samples: Type.Optional(
			Type.Number({
				description: "Optional Cycles sample count override.",
			}),
		),
		outputName: Type.Optional(
			Type.String({
				description: "Output image file name. Defaults to render.png.",
			}),
		),
		renderMethod: Type.Optional(
			Type.Union([Type.Literal("live"), Type.Literal("background")], {
				description:
					"How to execute the render. `live` uses the open Blender UI viewport. `background` uses a headless scene render. Defaults to `live`.",
				default: "live",
			}),
		),
		viewSource: Type.Optional(
			Type.Union([Type.Literal("camera"), Type.Literal("current-view")], {
				description:
					"How to choose the framing. `camera` uses the saved view, explicit camera, or active camera. `current-view` uses the raw current viewport in the live Blender UI. Defaults to `camera`.",
				default: "camera",
			}),
		),
		viewportShading: Type.Optional(
			Type.Union(
				[
					Type.Literal("wireframe"),
					Type.Literal("solid"),
					Type.Literal("material-preview"),
					Type.Literal("rendered"),
				],
				{
					description:
						"Viewport shading mode for live renders only. Defaults to `material-preview`. `solid` uses Workbench-style viewport shading. `rendered` uses the scene render engine interactively.",
					default: "material-preview",
				},
			),
		),
		renderEngine: Type.Optional(
			Type.Union([Type.Literal("eevee"), Type.Literal("cycles"), Type.Literal("workbench")], {
				description:
					"Optional render engine override for background renders only. Omit to keep the scene's current engine.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderRender({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			view: params.view,
			resolution: params.resolution,
			samples: params.samples,
			outputName: params.outputName,
			renderMethod: params.renderMethod,
			viewSource: params.viewSource,
			viewportShading: params.viewportShading,
			renderEngine: params.renderEngine,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderModuleRunTool: CoreToolDefinition = {
	name: "blender_module_run",
	label: "Blender Module Run",
	description:
		"Run a workspace module: checkpoint model.blend to modules/<name>/runs/NN/pre-NN.blend, execute modules/<name>/script.py, save the result, and optionally capture a render to modules/<name>/render.png for critique. The run is recorded in the workspace manifest (moduleRuns), so blender_module_revert knows exactly which state it restores. Use one module per object or concern in multi-part tasks. With a window open it runs in the live session (executionMode \"live-session\"); with none, it runs HEADLESSLY against a branch copy and merges the result back (executionMode \"headless-apply\"), which is the normal case since /blender no longer opens a window. Prefer blender_branch_run + blender_branch_apply when you want to author several modules against the same state and merge them in one pass. A headless run reports stateDigest — a content hash of the objects this module owns — plus unchangedSinceLastRun, which is true when the previous run of this module produced the same digest. An iteration that changed nothing produces the same render as the last one, so re-rendering and re-critiquing it buys a verdict you already have: read that flag before spending a critic.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		moduleName: Type.String({
			description:
				"Module name (lowercase letters, digits, dashes). Resolves to modules/<name>/script.py.",
		}),
		render: Type.Optional(
			Type.Boolean({
				description: "Capture a live camera render to modules/<name>/render.png after the run.",
				default: true,
			}),
		),
		view: Type.Optional(
			Type.String({
				description:
					'Optional saved view name, camera object name, or "active-camera" to render from. Defaults to the active camera.',
			}),
		),
		viewportShading: Type.Optional(
			Type.Union(
				[
					Type.Literal("wireframe"),
					Type.Literal("solid"),
					Type.Literal("material-preview"),
					Type.Literal("rendered"),
				],
				{
					description: "Viewport shading for the module render. Defaults to material-preview.",
				},
			),
		),
		resolution: Type.Optional(
			Type.Object({
				x: Type.Number({ description: "Render width in pixels." }),
				y: Type.Number({ description: "Render height in pixels." }),
				percentage: Type.Optional(Type.Number({ description: "Resolution percentage (default 100)." })),
			}),
		),
		samples: Type.Optional(
			Type.Number({
				description: "Sample count override for Cycles renders.",
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: "Execution timeout in seconds.",
				default: 120,
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderModuleRun({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
			render: params.render,
			view: params.view,
			viewportShading: params.viewportShading,
			resolution: params.resolution,
			samples: params.samples,
			timeoutSeconds: params.timeoutSeconds,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderBranchRunTool: CoreToolDefinition = {
	name: "blender_branch_run",
	label: "Blender Branch Run",
	description:
		"Run a workspace module HEADLESSLY against its own private copy of model.blend (modules/<name>/branch.blend), then stage the result for a later blender_branch_apply. No live Blender session is touched and no bridge lock is taken, so several modules can run at once — the concurrency ceiling is the headless run budget, not the one live session. Reports exactly which objects and materials the script changed, which is what the apply uses to bring back only this module's work instead of reverting its siblings'. A failed run leaves model.blend untouched and there is nothing to revert.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		moduleName: Type.String({
			description:
				"Module name (lowercase letters, digits, dashes). Resolves to modules/<name>/script.py.",
		}),
		render: Type.Optional(
			Type.Boolean({
				description: "Render the BRANCH (not model.blend) to modules/<name>/render.png for critique. Defaults to true.",
				default: true,
			}),
		),
		view: Type.Optional(
			Type.String({
				description:
					'Optional saved view name, camera object name, or "active-camera" to render from. Defaults to the active camera.',
			}),
		),
		resolution: Type.Optional(
			Type.Object({
				x: Type.Number({ description: "Render width in pixels." }),
				y: Type.Number({ description: "Render height in pixels." }),
				percentage: Type.Optional(Type.Number({ description: "Resolution percentage (default 100)." })),
			}),
		),
		samples: Type.Optional(
			Type.Number({
				description: "Sample count override for Cycles renders.",
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: "Execution timeout in seconds.",
				default: 300,
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderBranchRun({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
			render: params.render,
			view: params.view,
			resolution: params.resolution,
			samples: params.samples,
			timeoutSeconds: params.timeoutSeconds,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderBranchApplyTool: CoreToolDefinition = {
	name: "blender_branch_apply",
	label: "Blender Branch Apply",
	description:
		"Apply staged branch runs into model.blend, one at a time under a lock, so concurrent module runs can be merged in a fixed order. A module whose datablocks are contested by another STAGED branch is REPORTED AND SKIPPED, never auto-merged: its changes stay in its own branch blend and the apply says which modules and which object conflicted, because silently picking a winner is how a half-built asset gets presented as finished. Each successful apply is recorded as a module run, so blender_module_revert can restore the state it replaced.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		modules: Type.Array(Type.String(), {
			description:
				"Module names to apply, in any order — they are applied in the order their branch runs were staged. Every one must have a staged branch run.",
		}),
		timeoutSeconds: Type.Optional(
			Type.Number({
				description: "Per-apply timeout in seconds.",
				default: 300,
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderBranchApply({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			modules: params.modules,
			timeoutSeconds: params.timeoutSeconds,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderModuleRevertTool: CoreToolDefinition = {
	name: "blender_module_revert",
	label: "Blender Module Revert",
	description:
		"Revert model.blend to a module's recorded pre-run checkpoint and reload it in the live Blender session. Uses the manifest's moduleRuns history, so it reverts the exact state before that run. Refuses when later module runs also modified the blend (pass force: true to accept discarding them). The reload DISCARDS any unsaved changes currently open in the live Blender UI, so save unrelated work in the UI before reverting.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		moduleName: Type.String({
			description: "Module name to revert.",
		}),
		iteration: Type.Optional(
			Type.Number({
				description:
					"Revert this specific recorded run instead of the module's latest one.",
			}),
		),
		force: Type.Optional(
			Type.Boolean({
				description:
					"Allow the revert even though later module runs also mutated the blend.",
				default: false,
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderModuleRevert({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
			iteration: params.iteration,
			force: params.force,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderSetModeTool: CoreToolDefinition = {
	name: "blender_set_mode",
	label: "Blender Set Mode",
	description:
		"Switch the live Blender viewport/object mode for a workspace blend, enabling texture paint, vertex/weight/face paint, sculpt, pose, edit-armature, or UV editing. Supported modes: OBJECT, POSE, EDIT_MESH, EDIT_ARMATURE, SCULPT, TEXTURE_PAINT, VERTEX_PAINT, WEIGHT_PAINT, FACE_PAINT, and UV (enters edit mode and turns on the viewport UV editor overlay). Paint modes require a MESH object, POSE/EDIT_ARMATURE require an ARMATURE object. Use this before/after authoring paint or rig changes in script.py so the user sees the correct workspace in the live UI. A viewport mode is a statement about a UI, so with no window open this reports switched:false and a reason instead of failing: the paint is applied as bpy data either way and nothing about the asset depends on this. Authoring does not need a window — blender_module_run and blender_branch_run work headlessly.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		mode: Type.Union(
			[
				Type.Literal("OBJECT"),
				Type.Literal("POSE"),
				Type.Literal("EDIT_MESH"),
				Type.Literal("EDIT_ARMATURE"),
				Type.Literal("SCULPT"),
				Type.Literal("TEXTURE_PAINT"),
				Type.Literal("VERTEX_PAINT"),
				Type.Literal("WEIGHT_PAINT"),
				Type.Literal("FACE_PAINT"),
				Type.Literal("UV"),
			],
			{
				description:
					"Target viewport/object mode. UV enters edit mode with the UV editor overlay enabled.",
			},
		),
		objectName: Type.Optional(
			Type.String({
				description:
					"Optional object to act on. Defaults to the active object. Paint modes need a MESH, POSE/EDIT_ARMATURE need an ARMATURE.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderSetMode({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			mode: params.mode,
			objectName: params.objectName,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderLogCritiqueTool: CoreToolDefinition = {
	name: "blender_log_critique",
	label: "Blender Log Critique",
	description:
		"Append a structured critique entry to the workspace critique.log using the 0-12 Blender iteration rubric: five 0-2 craft axes plus a 0-2 category-validity axis, a 0-2 view adequacy that gates whether the judgement counts at all, and an optional rejectReason. Resolves a verdict (continue / present / reject) and records it, so blender_rank_assets can select across a batch without re-reading prose.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		moduleName: Type.String({
			description:
				"The module this critique judged. Names the part the render shows, and keeps each module's 5-iteration budget its own rather than shared across a fan-out.",
		}),
		iteration: Type.Optional(
			Type.Number({
				description:
					"Optional iteration number, for a run whose number differs from the workspace's latest. Omit it and the latest is used.",
			}),
		),
		accuracy: Type.Number({
			description: "Accuracy score from 0 to 2.",
			minimum: 0,
			maximum: 2,
		}),
		geometry: Type.Number({
			description: "Geometry and proportions score from 0 to 2.",
			minimum: 0,
			maximum: 2,
		}),
		materials: Type.Number({
			description: "Materials and appearance score from 0 to 2.",
			minimum: 0,
			maximum: 2,
		}),
		completeness: Type.Number({
			description: "Completeness score from 0 to 2.",
			minimum: 0,
			maximum: 2,
		}),
		quality: Type.Number({
			description: "Quality score from 0 to 2.",
			minimum: 0,
			maximum: 2,
		}),
		validity: Type.Number({
			description:
				"Is this a valid instance of the CATEGORY at all -- does it read as a mug, not as a well-formed object carrying a brief's worth of mug features? Separate from accuracy, which asks whether it matches its brief. Zero means the category is not satisfied, and no amount of polish recovers that.",
			minimum: 0,
			maximum: 2,
		}),
		viewAdequacy: Type.Number({
			description:
				"Can the asset be judged FROM this render? 2 = the whole subject and its silhouette are visible, 1 = partly occluded or ambiguous, 0 = the render does not show the subject. Scored because it gates the JUDGEMENT, not the asset: an ugly render of a good mesh is still a good sample, but a render that cannot show the object makes every other score meaningless, so an unusable view never presents.",
			minimum: 0,
			maximum: 2,
		}),
		viewNote: Type.String({
			description: "Free text on the framing, coverage, or perspective, kept because the score cannot say why.",
		}),
		issues: Type.Array(
			Type.String({
				description: "Concrete problems found in the current render or scene.",
			}),
		),
		nextAction: Type.String({
			description: 'Either a fix to attempt next, or "present to user" when the result is good enough.',
		}),
		rejectReason: Type.Optional(
			Type.String({
				description:
					"Reject the asset outright, whatever it scored. Use this when the ATTEMPT was wrong -- the category is unsatisfiable from this brief, or the structure is fundamentally not what was asked for -- rather than merely unpolished. Distinct from a low score on purpose: a scored failure is a finished attempt worth keeping the record of, and this says it should never have been made.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderLogCritique({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
			iteration: params.iteration,
			accuracy: params.accuracy,
			geometry: params.geometry,
			materials: params.materials,
			completeness: params.completeness,
			quality: params.quality,
			validity: params.validity,
			viewAdequacy: params.viewAdequacy,
			viewNote: params.viewNote,
			issues: params.issues,
			nextAction: params.nextAction,
			rejectReason: params.rejectReason,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderRankAssetsTool: CoreToolDefinition = {
	name: "blender_rank_assets",
	label: "Blender Rank Assets",
	description:
		"Rank a batch against ITSELF and return the best slice. An absolute threshold can say whether an asset is good enough; it can never say whether it is the best of a thousand, and the gap between the 60th and 95th percentile is invisible to a rubric that only ever sees one asset at a time. Reads critique.log's STRUCTURE (never its prose), keeps each module's latest judgement, ranks only presented assets judged from a usable view, and returns the top fraction best-first plus per-verdict counts and batch-level warnings. Use this before shipping a batch for training or curation: when rejects outnumber presents, the brief is usually wrong rather than the assets.",
	parameters: Type.Object({
		workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
		topFraction: Type.Optional(
			Type.Number({
				description:
					"Fraction of ELIGIBLE assets to keep, 0..1, default 0.1. A batch of 100 with a 0.1 slice returns the best 10. Always at least one asset is kept, so a batch of 3 returns its best rather than nothing.",
			}),
		),
		minScore: Type.Optional(
			Type.Number({
				description:
					"Score an asset must reach before it may be ranked at all, default 0. The verdict already gates on the present threshold; raise this only to keep borderline-but-presented assets out of a slice.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderRankAssets({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			topFraction: params.topFraction,
			minScore: params.minScore,
		});

		const lines = [
			`${result.selected.length} of ${result.eligible} eligible asset(s), top ${Math.round(result.topFraction * 100)}%:`,
			...result.selected.map(
				(asset) => `  ${asset.rank}. ${asset.moduleName} — ${asset.score}/12, validity ${asset.validity}/2 (${Math.round(asset.relativeScore * 100)}% of best)`,
			),
			`Verdicts: ${result.counts.present} present, ${result.counts.reject} reject, ${result.counts.continue} mid-iteration`,
			...result.warnings.map((warning) => `Warning: ${warning}`),
		];

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: result,
		};
	},
};

export const blenderIterationStateTool: CoreToolDefinition = {
	name: "blender_iteration_state",
	label: "Blender Iteration State",
	description:
		"What this module's iteration loop already knows, derived from the manifest and critique.log rather than from anyone's memory. Read it BEFORE spending a run or a fresh critic: it reports the per-module iteration budget, the last run and its content digest, the last verdict and score, whether the last briefed fix actually changed the content, the probe facts already recorded, and a waste guard that names the specific condition under which another render would tell you nothing new. A loop that has lost its budget to a context fold is a loop that runs forever; this is where the budget lives. Read-only.",
	parameters: Type.Object({
		workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
		moduleName: Type.String({
			description:
				"The module to report on. One model's history cannot be summarised for all of them, and the budget, digest and waste guard are all per-module.",
		}),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderIterationState({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
		});

		const lines = [
			`${result.module}: budget ${result.budget.used}/${result.budget.max} (${result.budget.exhausted ? "exhausted" : `${result.budget.remaining} left`}), present at ${result.presentThreshold}/12`,
			result.lastRun
				? `Last run: iteration ${result.lastRun.iteration} (${result.lastRun.executionMode}${result.lastRun.stateDigest ? `, digest ${result.lastRun.stateDigest.slice(0, 8)}` : ", no digest"})`
				: "Last run: none recorded.",
			result.lastVerdict
				? `Last verdict: ${result.lastVerdict.verdict} at ${result.lastVerdict.score}/12${result.lastVerdict.viewUsable ? "" : " (view unusable — the judgement did not gate anything)"}${result.lastVerdict.rejectReason ? ` — ${result.lastVerdict.rejectReason}` : ""}`
				: "Last verdict: never critiqued.",
			`Fix landed: ${result.fixLanded === undefined ? "unknown (no paired digests)" : result.fixLanded ? "yes" : "NO — the content did not move"}`,
			`Waste guard: ${result.wasteGuard.kind} — ${result.wasteGuard.detail}`,
		];
		for (const fact of result.knownFacts) {
			lines.push(`Known: ${fact.statement} (${fact.source}${fact.iteration ? `, iteration ${fact.iteration}` : ""})`);
		}

		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: result,
		};
	},
};

export const blenderRecordIterationFactTool: CoreToolDefinition = {
	name: "blender_record_iteration_fact",
	label: "Blender Record Iteration Fact",
	description:
		"Persist one MEASURED fact about this module so it survives the critic that measured it, a context fold, and a crash. A fact without a record is re-measured by every fresh critic, which is how a loop spends three renders learning that the handle is the wrong thickness. Record what the probe actually returned and the tool that returned it, so the next critic can re-check the number rather than trusting a sentence. Re-recording the same statement updates it rather than duplicating it; the newest 24 facts per module are kept. Read blender_iteration_state to see what is already known before measuring anything.",
	parameters: Type.Object({
		workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
		moduleName: Type.String({ description: "The module the fact is about." }),
		statement: Type.String({
			description:
				'The measured finding itself, as a checkable sentence: "The handle is 12mm across, under the 18mm a hand needs". Not "the handle looks thin" -- that is a judgement, and the critic makes those.',
		}),
		source: Type.String({
			description:
				'Which tool produced it, with the identifying detail: "blender_geometry_probe, Mug vs MugHandle pair distance", "blender_image_probe, modules/mug/render.png". A fact with no source is an assertion.',
		}),
		iteration: Type.Optional(
			Type.Number({ description: "The run the measurement belongs to. Defaults to nothing; supply it when the fact came from a specific run." }),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderRecordIterationFact({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
			statement: params.statement,
			source: params.source,
			iteration: params.iteration,
		});

		return {
			content: [
				{
					type: "text",
					text: [
						`Recorded for ${result.module}: ${result.recorded.statement}`,
						`Source: ${result.recorded.source}${result.recorded.iteration ? ` (iteration ${result.recorded.iteration})` : ""}`,
						`${result.facts.length} fact(s) now known for this module${result.superseded > 0 ? `; ${result.superseded} earlier statement(s) replaced` : ""}.`,
					].join("\n"),
				},
			],
			details: result,
		};
	},
};

export const blenderExportAssetTool: CoreToolDefinition = {
	name: "blender_export_asset",
	label: "Blender Export Asset",
	description:
		"Export the workspace blend to an interchange format: glb or gltf (materials, scene graph, modifiers applied) or obj (geometry, UVs, materials) or stl. This is what makes the asset leave Blender at all -- .blend is not an interchange format and no training pipeline reads it. Works headlessly. Pass `objects` to export a named subset, which is how you keep the studio rig out of a dataset. Read-only with respect to model.blend: the exporter writes a new file and never saves back.",
	parameters: Type.Object({
		workspace: Type.String({ description: "Explicit workspace path for the Blender task." }),
		format: Type.Optional(
			Type.String({
				description: "glb (default, single file), gltf (separate .bin and textures), obj, or stl. USD is not offered because no exporter is guaranteed present in a stock Blender build.",
				enum: ["glb", "gltf", "obj", "stl"],
			}),
		),
		objects: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Names to export, when given. Omit for the whole blend. Naming the asset's own objects is how a studio camera and three lights stay out of the dataset.",
			}),
		),
		outputDir: Type.Optional(
			Type.String({
				description: "Directory for the exported file. Defaults to the blend's own directory.",
			}),
		),
		name: Type.Optional(
			Type.String({
				description: "Base filename, without extension. Defaults to the blend's name. Sanitised, since it usually comes from a prompt.",
			}),
		),
		animations: Type.Optional(
			Type.Boolean({
				description: "Include animation data (glTF only). Default false.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderExportAsset({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			format: params.format as AssetExportOptions["format"],
			objects: params.objects,
			outputDir: params.outputDir,
			name: params.name,
			animations: params.animations,
		});

		return {
			content: [
				{
					type: "text",
					text: `Exported ${result.format} to ${result.exportPath} (${result.bytes} bytes, ${result.meshCount} mesh(es)).`,
				},
			],
			details: result,
		};
	},
};

export const blenderAddReferenceTool: CoreToolDefinition = {
	name: "blender_add_reference",
	label: "Blender Add Reference",
	description:
		"Register a reference image with a workspace. Copies the image into <workspace>/references/ and records it in the manifest so it can be listed, addressed by a stable id in briefs, and handed to a critic that cannot read images. The `caption` is required and is the only description of the image available to the worker and critic, because the manager is blocked from reading image files.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		path: Type.String({
			description:
				"Path to an existing image file on disk. It is COPIED into the workspace references/ directory, so later moves or deletions of the original do not break pending work. Supported: .png .jpg .jpeg .gif .webp .bmp",
		}),
		caption: Type.String({
			description:
				"What this image depicts, in one or two sentences: the subject, the angle it is shot from, and anything a worker or critic would need to judge against it. Required — you cannot read the image yourself, so this text is the only thing that will convey its contents.",
		}),
		id: Type.Optional(
			Type.String({
				description:
					"Stable id to address this reference by in briefs, e.g. 'front' or 'three-quarter'. Defaults to the file's name without its extension. Adding a reference whose id is taken stores it as <id>-2 rather than overwriting, so earlier verdicts stay reproducible.",
			}),
		),
		suggestedView: Type.Optional(
			Type.String({
				description:
					"Optional saved view or camera name you believe this reference should be compared against. The pairing is a hypothesis: a critic will report whether the two images are actually comparable, and name the view it would prefer if not.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderAddReference({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			path: params.path,
			caption: params.caption,
			id: params.id,
			suggestedView: params.suggestedView,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderBridgeStatusTool: CoreToolDefinition = {
	name: "blender_bridge_status",
	label: "Blender Bridge Status",
	description:
		"Check whether the live Blender bridge can serve a request right now: is the UI running, is another request holding the single live-Blender slot, how many requests are pending, how many headless Blender runs may execute concurrently on this machine, and how many are open RIGHT NOW across this session's workers. Use it before a long or mutating batch, or when a bridge call timed out, instead of guessing or burning another timeout. The open count is the one to read mid-fan-out: the budget says what is permitted, not what your workers already spent. A /blender-watch window is reported apart from the runs, because it is not one of them.",
	parameters: Type.Object({
		workspace: Type.Optional(
			Type.String({
				description: "Optional workspace path to report alongside the bridge state.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderBridgeStatus({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderGeometryProbeTool: CoreToolDefinition = {
	name: "blender_geometry_probe",
	label: "Blender Geometry Probe",
	readOnly: true,
	description:
		"Measure mesh/transform relationships in the workspace blend and return numbers: world-space bounds, thin/long principal axes and their angle to an expected axis, pair distance with an interpenetrating/in-contact/separated verdict, a scene-wide sweep for parts that ought to meet and do not — or that share a surface and will z-fight, mesh island counts, and non-manifold/loose/duplicate geometry counts. Read-only — it never mutates or saves, claims no iteration, and is safe to call while a worker has a module mid-flight. Use it instead of reasoning about placement: a floating or buried handle is a measured gap distance, not a guess. Works with no window: it then measures model.blend on disk headlessly. With a window open it measures the live session instead, including unsaved edits, and warns when the two differ.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		objects: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Object names to measure. Omit to probe every visible mesh in the scene — usually the right default, because a misplaced part is found by its relationship to the rest, and the culprit is often not yet known.",
			}),
		),
		pairs: Type.Optional(
			Type.Array(
				Type.Array(Type.String(), {
					minItems: 2,
					maxItems: 2,
				}),
				{
					description:
						'Object-name pairs to measure against each other, e.g. [["Mug", "MugHandle"]]. Each pair yields the closest surface distance, penetration depth, per-object vertex-inside counts, a coincident-surface figure, bounding-box overlap, and a verdict. Omit to auto-pair when exactly two objects are given.',
				},
			),
		),
		specifications: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object({
					width: Type.Optional(Type.Union([Type.Number(), Type.String()])),
					depth: Type.Optional(Type.Union([Type.Number(), Type.String()])),
					height: Type.Optional(Type.Union([Type.Number(), Type.String()])),
					tolerance: Type.Optional(Type.Number()),
				}),
				{
					description:
						"Reference dimensions per object name, compared against what the scene actually measures. A bare integer is MILLIMETRES and a bare decimal is METRES, because a brief says `2400` and `2.4m` for the same ceiling; unitless-as-metres is not an option when a 1000x error renders identically. Naming dimensions implies the `scale` check.",
				},
			),
		),
		checks: Type.Optional(
			Type.Array(
				Type.Union([
					Type.Literal("transform"),
					Type.Literal("bounds"),
					Type.Literal("axis"),
					Type.Literal("pair"),
					Type.Literal("joint"),
					Type.Literal("clearance"),
					Type.Literal("path"),
					Type.Literal("shape"),
					Type.Literal("topology"),
					Type.Literal("scale"),
				]),
				{
					description:
						"Measurement families to run. Omit for all. `transform` catches unapplied/mirror scale; `axis` finds a ring's own axis and how far it is off the expected one; `pair` measures only the pairs you NAME; `joint` sweeps the whole scope for pairs nobody named — bounding boxes that overlap or come within 50mm while the surfaces are further apart than the tolerance — and is the check that finds a riser pipe modelled clear of the pipe it continues; it also reports `coincident-surface`, the two parts sharing a stretch of geometry that renders as z-fighting colour banding, which no verdict can see because a flush-laid panel is in contact and so is a clean one, and `buried`, a part swallowed whole by another, which is a correct render of a wrong model; `clearance` answers whether the room is USABLE — it samples the floor with a person-sized body, dilates every obstruction by that reach, and reports `islandCount` (free floor cut into pieces nobody can walk between) and `unreachableArea` (floor that reaches no edge at all), which is what catches a sofa laid wall to wall; it takes its room from the same `objects` you scope it to, so measure one room rather than the house; `path` asks whether the WALK between two points is longer than the line between them — pass `points` (door centres, the ends of a corridor) and it walks every pair over the same floor raster, walls included, and reports a `detour` ratio: 1.0 is a corridor, one bend is about 1.1–1.3, and a stair-step of several offset doors runs to 1.9 or more, which is the shape a render cannot show because from above it is still a house; `shape` reports self-symmetry, a radius profile along the mesh's own long axis, convexity and open edges — the defects a render cannot show; `topology` is the expensive one (bmesh pass per mesh) and is only needed when the shape itself is suspect, and its island count is what catches a mesh split into drifting pieces; `scale` needs `specifications` and compares each object against the reference dimensions your brief named.",
				},
			),
		),
		tolerance: Type.Optional(
			Type.Number({
				description:
					"Contact distance in Blender units (default 0.002, i.e. 2 mm at default scale). Distances within tolerance report as `in-contact` rather than `separated`.",
			}),
		),
		expectedAxis: Type.Optional(
			Type.Union([Type.Literal("X"), Type.Literal("Y"), Type.Literal("Z")], {
				description:
					"The axis a part's thin direction should align with — `Z` for a mug handle's ring axis, `Z` for a vertical stem. Omit to skip the alignment comparison.",
			}),
		),
		body: Type.Optional(
			Type.Number({
				description:
					"`clearance` and `path` only. Metres a person reaches — a sample is blocked when an obstruction comes within this. Default 0.25, which is what makes a 50 mm gap read as blocked and a 500 mm one as a doorway. Widen it to ask whether a wheelchair gets through, narrow it to ask whether anything does. Any other check ignores it.",
			}),
		),
		points: Type.Optional(
			// Deliberately NOT `Type.Tuple([Type.Number(), Type.Number()])`.
			//
			// A tuple serializes to a POSITIONAL `items` array:
			//   { "items": [ { "type": "number" }, { "type": "number" } ] }
			// That is valid draft-07, but strict providers reject it as a
			// malformed tool schema, which fails the whole request:
			//   Tool 22 function has invalid 'parameters' schema:
			//   [{'type': 'number'}, {'type': 'number'}] is not of type
			//   'object', 'boolean'
			// The bounded inner array below serializes to the OBJECT form
			// (`items: { "type": "number" }` plus minItems/maxItems), which
			// every provider accepts. `Type.Unsafe` supplies the `[number,
			// number]` static type that the plain `Type.Array` loses, so the
			// call site keeps its exact typing without a cast.
			Type.Unsafe<[number, number][]>(
				Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }), {
					description:
						"World `[x, y]` positions in metres a person is meant to travel between — door centres, the ends of a corridor, the foot of a stair. Passing these implies the `path` check. Every PAIR is walked, not just the ones you ordered: a house is short of doors and long of rooms, so the pair a designer forgot is the one that zig-zags. Each point snaps to the nearest free floor within a body's reach, so a door centre given beside its frame still resolves; one that lands on nothing is reported in `unresolved` rather than guessed at.",
				}),
			),
		),
		detour: Type.Optional(
			Type.Number({
				description:
					"`path` only. The detour ratio above which a route counts as a zig-zag, default 1.45. A straight corridor is 1.0 and a single right-angle bend is about 1.1–1.3, which is why the default sits well above 1: real architecture bends, and the defect is the several-turn stair-step. Cannot go below 1.0 — the straight line is a lower bound on any walk.",
			}),
		),
		cell: Type.Optional(
			Type.Number({
				description:
					"`clearance` and `path` only. Metres, the sampling granularity, default 0.05. The effective stride is this widened to cover `body`, because a sample is stamped with a dilated box spanning `2 * body` — so `cell` alone does not set the resolution. Lower it for a fine question, and expect a proportionally larger sample count. The two checks share one raster, so the same scope and the same `cell` report the same `stride`.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description:
					"Bridge timeout override in ms. Defaults to 120000 (4x the 30s round-trip) because a probe scales with scene size — raise it for a `topology` check on a heavy scene, lower it when you are probing a small object list and want a dead bridge to report sooner.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderGeometryProbe({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			objects: params.objects,
			pairs: params.pairs,
			checks: params.checks,
			specifications: params.specifications,
			tolerance: params.tolerance,
			expectedAxis: params.expectedAxis,
			body: params.body,
			cell: params.cell,
			points: params.points,
			detour: params.detour,
			timeoutMs: params.timeoutMs,
			signal: context?.signal,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderImageProbeTool: CoreToolDefinition = {
	name: "blender_image_probe",
	label: "Blender Image Probe",
	readOnly: true,
	description:
		"Measure a rendered PNG numerically instead of judging it by eye: subject pixel bounds and coverage, mean subject colour, an nx-by-ny mean-luma grid, silhouette row occupancy, edge sharpness, and dominant subject colours. Read-only, and it needs no live Blender — the pixels are the whole input, so any read-only role can use it. Use it to check a visual suspicion before asserting it: 'the part is bare' is a colour fraction, 'the arms are hidden behind the body' is a row-occupancy pattern, and 'the render is too dark to judge' is a mean luma.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		path: Type.String({
			description:
				"Path to the PNG to measure, e.g. `modules/<name>/render.png`. Relative paths resolve against the workspace root.",
		}),
		background: Type.Optional(
			Type.Array(Type.Number(), {
				minItems: 3,
				maxItems: 3,
				description:
					"The image's background colour as three 0..1 values (r, g, b). Defaults to black. This is a property of the shot, so read it from the render settings or the world rather than guessing from a corner pixel — a wrong value makes the background read as subject and empties the measurement.",
			}),
		),
		tolerance: Type.Optional(
			Type.Number({
				description:
					"Per-channel 0..1 tolerance for calling a pixel background (default 0). Raise it for a noisy or film-grain background, or for an antialiased edge that should count as subject.",
			}),
		),
		grid: Type.Optional(
			Type.Array(Type.Number(), {
				minItems: 2,
				maxItems: 2,
				description:
					"Luma grid resolution as [nx, ny] (default [8,8], maximum 32 per side). Each cell is the mean luma of the subject pixels inside it, and null where there are none — a null cell means the subject does not reach that part of the frame.",
			}),
		),
		paletteLimit: Type.Optional(
			Type.Number({
				description: "How many dominant subject colours to report (default 6, 0 disables).",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderImageProbe({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			path: params.path,
			background: params.background as [number, number, number] | undefined,
			tolerance: params.tolerance,
			grid: params.grid as [number, number] | undefined,
			paletteLimit: params.paletteLimit,
		});

		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	},
};

export const blenderReadOnlyPythonTool: CoreToolDefinition = {
	name: "blender_read_only_python",
	label: "Blender Read-Only Python",
	description:
		"Run a Python measurement script in the LIVE Blender scene and get its stdout back, with mutating bpy operations refused by the bridge itself — bpy.ops, bpy.data and bpy.data.<collection> removal (including batch_remove and orphans_purge), linking or unlinking in the scene collection, assigning to an object or its vectors, and saving. It never mutates, saves, or claims an iteration. This exists because a question like 'is the tights the visible surface' is one raycast, and answering it any other way means eyeballing a render. A refusal comes back as `refused: true` naming the operation, which is an answer, not a failure: rewrite the script to ask a question that does not need the change. Print what you measured; the return value is whatever you printed. Two honest limits: this guards bpy, NOT the filesystem, so a read-only script may still read and write files with `os` and `open` — do not use it on anything you would mind losing. And it is a denylist of named entry points rather than a sandbox, so a bpy API this tool does not know about is not refused; if a measurement needs to change the scene, use blender_execute_python or blender_module_run. Works with no window: the script then runs headlessly against model.blend. With a window open it runs against the live session instead, so it can see unsaved edits.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		script: Type.String({
			description:
				"The Python to run, as text. Inline rather than a path on purpose: a read-only role has no `write` tool, so a path-only API would make the tool unusable for exactly the role that needs it, and would push it toward asking a worker to author its own evidence.",
		}),
		timeoutMs: Type.Optional(
			Type.Number({
				description: "Bridge timeout override in ms for the script itself.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderReadOnlyPython({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			script: params.script,
			timeoutMs: params.timeoutMs,
			signal: context?.signal,
		});

		return {
			content: [
				{
					type: "text",
					text: result.refused
						? `REFUSED: the script asked for an operation that would change the scene.\n${result.stdout.trim()}`
						: result.stdout.trim() || "(the script printed nothing)",
				},
			],
			details: result,
		};
	},
};

export const blenderMontageTool: CoreToolDefinition = {
	name: "blender_montage",
	label: "Blender Montage",
	description:
		"Render several preset views of one subject and tile them into a single labelled sheet, plus the individual panels at full size. Two families of preset, chosen per view name. ORBIT presets (front, three-quarter, …) frame the subject's bounding sphere at one fixed distance, so every panel frames identically and a difference between panels is the geometry rather than the camera. INTERIOR presets (interior-corner, interior-doorway, …) stand inside the subject at eye height — a room has no silhouette to orbit, and a 6x4x2.8m room has a bounding-sphere radius of 3.9m, so every orbit panel of it photographs the outside of a wall. Use it when one angle cannot answer the question — a silhouette that might be hiding a limb, a shape that reads as symmetric from the front and wrong from three-quarter, a room that reads as cluttered from one corner and open from another, a critic that keeps calling something vague. Name the views; do not ask for views. Read-only with respect to the file it photographs: resolution, filepath, scene camera and viewport are restored, and the temporary cameras are removed. Works with no window: it then renders each panel headlessly from model.blend.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		moduleName: Type.String({
			description: "Module the sheet belongs to. Written to modules/<name>/montage.png, with panel-N-<view>.png beside it.",
		}),
		views: Type.Array(Type.String(), {
			minItems: 1,
			maxItems: 4,
			description:
				"Preset view names. Orbit: front, back, left, right, top, bottom, three-quarter, three-quarter-left, three-quarter-high, profile-left, profile-right, front-high. Interior: interior-corner, interior-corner-left, interior-corner-right, interior-elevated, interior-doorway, interior-low. An unknown name is refused with the list rather than approximated. Two to four views make a useful sheet; one view is a render with extra steps.",
		}),
		subject: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Objects to frame. Defaults to every visible mesh, which frames the whole build. Pass names when one module is the subject and the rest of the scene is context.",
			}),
		),
		columns: Type.Optional(
			Type.Number({
				description:
					"Sheet columns. Default 1 for up to two views, otherwise 2. A 2x2 sheet of four panels is the most a critic can resolve before the panels get downsampled.",
			}),
		),
		panelResolution: Type.Optional(
			Type.Object({
				x: Type.Number({ description: "Panel width in pixels (default 900)." }),
				y: Type.Number({ description: "Panel height in pixels (default 700)." }),
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description:
					"Bridge timeout override in ms. Defaults to four times the single-render budget, because this is one render per panel.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderMontage({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
			views: params.views,
			subject: params.subject,
			columns: params.columns,
			panelResolution: params.panelResolution,
			timeoutMs: params.timeoutMs,
			signal: context?.signal,
		});

		return {
			content: [
				{
					type: "text",
					text: [
						`Montage: ${result.montagePath}`,
						`Panels: ${result.panelPaths.join(", ")}`,
						`Views: ${result.views.join(", ")} (${result.layout.columns}x${result.layout.rows} of ${result.layout.panelWidth}x${result.layout.panelHeight})`,
						`Framed: ${result.subject.join(", ")}`,
						result.note,
					].join("\n"),
				},
			],
			details: result,
		};
	},
};

export const blenderCompareTool: CoreToolDefinition = {
	name: "blender_compare",
	label: "Blender Compare",
	description:
		"Render the PREVIOUS generation of a subject beside the current one on a single labelled sheet, so a regression is visible. Each panel is labelled with which ITERATION it is (the baseline is the run before this module's latest, the current one is the latest; pass baselineLabel/currentLabel to say otherwise), and the two panels of one view sit side by side, which is what makes the sheet a comparison rather than a pair of pictures. Both generations are framed from the UNION of their extents, so the camera is identical in every panel and a difference between two panels of the same view is geometry — framing each generation on its own extent would make a part that grew read as a camera change. The baseline is rendered again from the checkpoint the earlier run started from (a checkpoint IS that generation's state, so no kept render is needed); pass baselineBlendPath to compare against a named earlier iteration instead. Two runs is the minimum: with only one there is no previous generation, and a sheet of identical pairs would read as proof of stability. Views are the same preset names as blender_montage. The baseline is a file on disk, never the session's own state: it is opened, rendered, and the workspace blend put back, so a comparison never replaces what you are looking at. A baseline missing subjects you named is reported as missingSubjects rather than rendered as an absence. Works with no window: both generations then render headlessly.",
	parameters: Type.Object({
		workspace: Type.String({
			description: "Explicit workspace path for the Blender task.",
		}),
		moduleName: Type.String({
			description:
				"Module whose two generations are compared. Defaults the baseline from this module's run history, and writes modules/<name>/compare.png.",
		}),
		baselineBlendPath: Type.Optional(
			Type.String({
				description:
					"The generation to compare against — normally a checkpoint under modules/<name>/runs/NN/. Defaults to the run immediately before this module's latest one. Refused outright when there is none, because a sheet of one generation wearing a comparison's labels invites reading the build as an improvement over nothing.",
			}),
		),
		baselineLabel: Type.Optional(
			Type.String({
				description:
					"What to call the baseline in every panel label. Default its iteration number when the baseline came from run history, and BEFORE when you named the path yourself.",
			}),
		),
		currentLabel: Type.Optional(
			Type.String({
				description: "What to call the current generation. Default AFTER.",
			}),
		),
		views: Type.Array(Type.String(), {
			minItems: 1,
			maxItems: 4,
			description:
				"Preset view names, same as blender_montage. Two to four make a readable sheet; with columns 2 each view's two generations sit adjacent, so the reading order IS the comparison.",
		}),
		subject: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Objects to frame and compare. Defaults to every visible mesh. Pass names when one module is the subject and the rest of the scene is context.",
			}),
		),
		columns: Type.Optional(
			Type.Number({
				description: "Sheet columns. Default 2, so a view's two generations sit side by side.",
			}),
		),
		panelResolution: Type.Optional(
			Type.Object({
				x: Type.Number({ description: "Panel width in pixels (default 900)." }),
				y: Type.Number({ description: "Panel height in pixels (default 700)." }),
			}),
		),
		timeoutMs: Type.Optional(
			Type.Number({
				description:
					"Bridge timeout override in ms. Defaults to eight times the single-render budget: this renders every panel twice and opens a second blend.",
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderCompare({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			moduleName: params.moduleName,
			baselineBlendPath: params.baselineBlendPath,
			baselineLabel: params.baselineLabel,
			currentLabel: params.currentLabel,
			views: params.views,
			subject: params.subject,
			columns: params.columns,
			panelResolution: params.panelResolution,
			timeoutMs: params.timeoutMs,
			signal: context?.signal,
		});

		const missing = result.baseline.missingSubjects;
		return {
			content: [
				{
					type: "text",
					text: [
						`Comparison: ${result.montagePath}`,
						`Baseline: ${result.labels.baseline} = ${result.baseline.blendPath}`,
						`Current: ${result.labels.current}`,
						`Views: ${result.views.join(", ")} (${result.layout.columns}x${result.layout.rows} of ${result.layout.panelWidth}x${result.layout.panelHeight})`,
						`Framed: ${result.subject.join(", ")}`,
						missing.length > 0
							? `Baseline is missing ${missing.join(", ")} — it predates those objects, so their absence in the ${result.labels.baseline} panels is not a render fault.`
							: undefined,
						result.note,
					]
						.filter((line): line is string => line !== undefined)
						.join("\n"),
				},
			],
			details: result,
		};
	},
};

export const BLENDER_TOOLS: CoreToolDefinition[] = [
	blenderWorkspaceInitTool,
	blenderExecutePythonTool,
	blenderSessionContextTool,
	blenderSceneInfoTool,
	blenderSaveViewTool,
	blenderRenderTool,
	blenderModuleRunTool,
	blenderBranchRunTool,
	blenderBranchApplyTool,
	blenderModuleRevertTool,
	blenderSetModeTool,
	blenderLogCritiqueTool,
	blenderRankAssetsTool,
	blenderIterationStateTool,
	blenderRecordIterationFactTool,
	blenderExportAssetTool,
	blenderAddReferenceTool,
	blenderBridgeStatusTool,
	blenderGeometryProbeTool,
	blenderImageProbeTool,
	blenderReadOnlyPythonTool,
	blenderMontageTool,
	blenderCompareTool,
];

export const BLENDER_TOOL_NAMES = BLENDER_TOOLS.map((t) => t.name);

export const READ_ONLY_TOOL_NAMES = [
	"blender_session_context",
	"blender_scene_info",
	"blender_geometry_probe",
	"blender_image_probe",
] as const;

export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];

export const READ_ONLY_TOOLS = BLENDER_TOOLS.filter((tool) =>
	(READ_ONLY_TOOL_NAMES as readonly string[]).includes(tool.name),
);

export function getTool(name: string): CoreToolDefinition | undefined {
	return BLENDER_TOOLS.find((t) => t.name === name);
}
