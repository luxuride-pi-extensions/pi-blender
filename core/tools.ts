/**
 * Transport-agnostic core Blender capability tools.
 *
 * Imports NO pi symbol: structured so tools can be consumed by pi (in index.ts)
 * or by any MCP client (via core/mcp-server.ts).
 */

import { Type } from "typebox";
import { DEFAULT_MODULE_TIMEOUT_SECONDS } from "../blender/types.js";
import type { AssetExportOptions, CameraFrontAxis, CameraProfile, CameraShotKind, ImportFormat } from "../blender/types.js";
import { searchReferenceSources, type ReferenceSource } from "../blender/reference-sources.js";
import { formatTimings } from "../blender/timings.js";
import type { CoreToolDefinition, CoreToolContext, CoreToolResult } from "./types.js";
import {
	blenderAddReference,
	blenderBranchApply,
	blenderBranchRun,
	blenderBuildAdvance,
	blenderBuildStatus,
	blenderBridgeStatus,
	blenderExecutePython,
	blenderExportAsset,
	blenderFocusView,
	blenderGeometryProbe,
	blenderGetPythonApiDocs,
	blenderImageProbe,
	blenderImportAsset,
	blenderIterationState,
	blenderJobStatus,
	cancelJob,
	blenderLogCritique,
	blenderModuleRevert,
	blenderModuleRun,
	blenderMontage,
	blenderObjectDetail,
	blenderRankAssets,
	blenderReadOnlyPython,
	blenderRecordIterationFact,
	blenderRender,
	blenderSaveView,
	blenderSceneInfo,
	blenderSearchApiDocs,
	blenderSearchManualDocs,
	blenderSessionContext,
	blenderSetMode,
	blenderSwitchWorkspace,
	blenderUsageGuess,
	blenderWindowLayout,
	blenderWorkspaceInit,
	blenderWorkspacePrune,
} from "../blender/runtime.js";
import { blenderCompare } from "../blender/compare.js";


export function formatJsonResult(value: unknown): string {
	return JSON.stringify(value, null, 2);
}


export const blenderWorkspaceInitTool: CoreToolDefinition = {
	name: "blender_workspace_init",
	label: "Blender Workspace Init",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	description:
	'Create or reopen a managed Blender workspace with a persistent model.blend and workspace manifest. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.Optional(
		Type.String({
			description: 'Explicit workspace path.',
		}),
	),
	sourceBlend: Type.Optional(
		Type.String({
			description:
				'Optional source .blend file.',
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
					'Workspace template.',
				default: "studio",
			},
		),
	),
	continueExisting: Type.Optional(
		Type.Boolean({
			description: 'When true, require.',
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Copy a Blender Python script into a run directory, execute it inside. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	script_path: Type.String({
		description:
			'Path.',
	}),
	saveBefore: Type.Optional(
		Type.Boolean({
			description: 'If true, copy.',
			default: false,
		}),
	),
	saveAfter: Type.Optional(
		Type.Boolean({
			description: 'If true, save.',
			default: true,
		}),
	),
	claimIteration: Type.Optional(
		Type.Boolean({
			description:
				'If false, run without claiming.',
			default: true,
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: 'Execution timeout in seconds.',
			default: 120,
		}),
	),
	label: Type.Optional(
		Type.String({
			description: 'Optional label for the iteration step.',
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
	readOnly: true,
	label: "Blender Session Context",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	description:
	'Read the LIVE Blender session: the open blend path, active scene, current mode, active object, selected. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.Optional(
		Type.String({
			description:
				'Optional workspace path.',
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
					'Optional live session categories to include.',
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

export const blenderWindowLayoutTool: CoreToolDefinition = {
	name: "blender_window_layout",
	label: "Blender Window Layout",
	annotations: {
	// Not read-only: screenshot mode writes a PNG to a caller-supplied
	// output_path (blender/live-bridge.py:836). Claiming read-only here
	// would let pi skip the confirmation prompt for a filesystem write.
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: false,
	openWorldHint: true,
},
	description:
	'Read the live Blender UI layout and selection as JSON, or capture a byte-capped screenshot. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.Optional(
		Type.String({
			description:
				'Optional workspace path for the Blender task.',
		}),
	),
	format: Type.Optional(
		Type.Union([Type.Literal("json"), Type.Literal("image")], {
			description:
				'Output format: \'json\' for zero-cost layout, or \'image\' to return a PNG.',
		}),
	),
	screenshot: Type.Optional(
		Type.Boolean({
			description:
				'Whether to capture a screenshot. Defaults to false.',
		}),
	),
	as_image: Type.Optional(
		Type.Boolean({
			description: 'Alias for screenshot: true.',
		}),
	),
	as_json: Type.Optional(
		Type.Boolean({
			description:
				'Return layout and selection as JSON only.',
		}),
	),
	area_type: Type.Optional(
		Type.String({
			description:
				'Optional area type to screenshot.',
		}),
	),
	max_bytes: Type.Optional(
		Type.Number({
			description:
				'Maximum screenshot file size in bytes.',
		}),
	),
	output_path: Type.Optional(
		Type.String({
			description: 'Optional screenshot output path.',
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderWindowLayout({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		format: params.format,
		screenshot: params.screenshot,
		as_image: params.as_image,
		as_json: params.as_json,
		area_type: params.area_type,
		max_bytes: params.max_bytes,
		output_path: params.output_path,
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
	readOnly: true,
	label: "Blender Scene Info",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
'Read the workspace blend file as it was last SAVED, and return its structure: scene content (objects. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
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
				Type.Literal("object_detail"),
				Type.Literal("missingFiles"),
				Type.Literal("linkedLibraries"),
				Type.Literal("scene_stats"),
				Type.Literal("usage_guess"),
				Type.Literal("usageGuess"),
			]),
			{
				description:
					'Optional scene info categories to inspect.',
				uniqueItems: true,
			},
		),
	),
	targetObject: Type.Optional(
		Type.String({
			description:
				'Optional target object name when.',
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderSceneInfo({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		categories: params.categories,
		targetObject: params.targetObject,
		signal: context?.signal,
	});

	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderUsageGuessTool: CoreToolDefinition = {
	name: "blender_usage_guess",
	label: "Blender Usage Guess",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Inspect a saved .blend file headlessly (no live UI bridge lock needed) and guess what it is for. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.Optional(
		Type.String({
			description:
				'Optional workspace path containing.',
		}),
	),
	blendPath: Type.Optional(
		Type.String({
			description:
				'Optional direct path.',
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderUsageGuess({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		blendPath: params.blendPath,
		signal: context?.signal,
	});

	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderObjectDetailTool: CoreToolDefinition = {
	name: "blender_object_detail",
	label: "Blender Object Detail",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Read the workspace blend file as it was last SAVED. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	objectName: Type.Optional(
		Type.String({
			description:
				'Name.',
		}),
	),
	targetObject: Type.Optional(
		Type.String({
			description:
				'Alias for objectName.',
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				'Alias for objectName.',
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const objectName = params.objectName ?? params.targetObject ?? params.name;
	if (!objectName) {
		throw new Error("objectName (or targetObject, name) is required for blender_object_detail.");
	}
	const result = await blenderObjectDetail({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		objectName,
		targetObject: params.targetObject,
		name: params.name,
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	description:
	'Save a named render view in the workspace manifest. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	name: Type.String({
		description: 'Saved view name.',
	}),
	source: Type.String({
		description:
			'Either "active-camera".',
	}),
	camera_name: Type.Optional(
		Type.String({
			description:
				'Optional dedicated camera object name.',
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Render the workspace blend file and write outputs into the current iteration. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	view: Type.Optional(
		Type.String({
			description: 'Optional saved view name, camera name.',
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
			description: 'Optional Cycles sample count override.',
		}),
	),
	outputName: Type.Optional(
		Type.String({
			description: 'Output image file name.',
		}),
	),
	renderMethod: Type.Optional(
		Type.Union([Type.Literal("live"), Type.Literal("background")], {
			description:
				'How to execute the render.',
			default: "live",
		}),
	),
	viewSource: Type.Optional(
		Type.Union([Type.Literal("camera"), Type.Literal("current-view")], {
			description:
				'How to choose the framing.',
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
					'Viewport shading mode for live renders only.',
				default: "material-preview",
			},
		),
	),
	renderEngine: Type.Optional(
		Type.Union([Type.Literal("eevee"), Type.Literal("cycles"), Type.Literal("workbench")], {
			description:
				'Optional render engine override.',
		}),
	),
	async: Type.Optional(
		Type.Boolean({
			description:
				'If true, dispatch.',
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
		async: params.async,
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Run a workspace module: checkpoint model.blend, execute the script, and stage the branch for apply. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	moduleName: Type.String({
		description:
			'Module name (lowercase letters, digits, and underscores).',
	}),
	render: Type.Optional(
		Type.Boolean({
			description: 'Capture.',
			default: true,
		}),
	),
	view: Type.Optional(
		Type.String({
			description:
			'Optional saved view name, camera object.',
		}),
	),
	cameraProfile: Type.Optional(
		Type.String({
			description:
				'Headless path only: use-case profile.',
			enum: ["prop", "character", "hard_surface", "interior", "print", "paint", "asset_pack"],
		}),
	),
	frontAxis: Type.Optional(
		Type.String({
			description:
				'Headless path only.',
			enum: ["-Y", "+Y", "-X", "+X"],
		}),
	),
	cameraShots: Type.Optional(
		Type.Array(
			Type.String({
				enum: [
					"hero",
					"front",
					"back",
					"left",
					"right",
					"top",
					"ortho_front",
					"ortho_side",
					"ortho_top",
					"interior_hero",
					"interior_front",
					"lineup_front",
				],
			}),
			{ description: 'Headless path only.' },
		),
	),
	frameSubject: Type.Optional(
		Type.String({
			description:
				'Headless path only.',
			enum: ["module", "apply"],
		}),
	),
	cameraDistance: Type.Optional(
		Type.Number({
			description: 'Headless path only.',
			minimum: 0,
		}),
	),
	reviewSheet: Type.Optional(
		Type.Boolean({
			description:
				'Also render the plan\'s other shots into.',
			default: false,
		}),
	),
	direct: Type.Optional(
		Type.Boolean({
			description:
				'Headless path only.',
			default: false,
		}),
	),
	forceRender: Type.Optional(
		Type.Boolean({
			description:
				'Headless path only.',
			default: false,
		}),
	),
	forcePreflight: Type.Optional(
		Type.Boolean({
			description:
				'Override block.',
			default: false,
		}),
	),
	referenceId: Type.Optional(
		Type.String({
			description:
				'Reference id whose image.',
		}),
	),
	resolution: Type.Optional(
		Type.Object({
			x: Type.Number({ description: 'Render width in pixels.' }),
			y: Type.Number({ description: 'Render height in pixels.' }),
			percentage: Type.Optional(Type.Number({ description: 'Resolution percentage (default 100).' })),
		}),
	),
	samples: Type.Optional(
		Type.Number({
			description: 'Sample count override for Cycles renders.',
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: 'Execution timeout in seconds.',
			default: DEFAULT_MODULE_TIMEOUT_SECONDS,
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
		cameraProfile: params.cameraProfile as CameraProfile | undefined,
		frontAxis: params.frontAxis as CameraFrontAxis | undefined,
		cameraShots: params.cameraShots as CameraShotKind[] | undefined,
		frameSubject: params.frameSubject as "module" | "apply" | undefined,
		cameraDistance: params.cameraDistance,
		reviewSheet: params.reviewSheet,
		direct: params.direct,
		forceRender: params.forceRender,
		forcePreflight: params.forcePreflight,
		referenceId: params.referenceId,
		resolution: params.resolution,
		samples: params.samples,
		timeoutSeconds: params.timeoutSeconds,
		signal: context?.signal,
	});

	const timing = formatTimings(result.timings);
	return {
		content: [{ type: "text", text: timing ? `${timing}\n${formatJsonResult(result)}` : formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderBranchRunTool: CoreToolDefinition = {
	name: "blender_branch_run",
	label: "Blender Branch Run",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	description:
	'Run a workspace module HEADLESSLY against its own private copy of model.blend. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	moduleName: Type.String({
		description:
			'Module name (lowercase letters, digits, and underscores).',
	}),
	render: Type.Optional(
		Type.Boolean({
			description: 'Render.',
			default: true,
		}),
	),
	view: Type.Optional(
		Type.String({
			description:
				'Optional saved view name, camera object.',
		}),
	),
	cameraProfile: Type.Optional(
		Type.String({
			description:
				'Headless path only: use-case profile.',
			enum: ["prop", "character", "hard_surface", "interior", "print", "paint", "asset_pack"],
		}),
	),
	frontAxis: Type.Optional(
		Type.String({
			description:
				'Headless path only.',
			enum: ["-Y", "+Y", "-X", "+X"],
		}),
	),
	cameraShots: Type.Optional(
		Type.Array(
			Type.String({
				enum: [
					"hero",
					"front",
					"back",
					"left",
					"right",
					"top",
					"ortho_front",
					"ortho_side",
					"ortho_top",
					"interior_hero",
					"interior_front",
					"lineup_front",
				],
			}),
			{ description: 'Headless path only.' },
		),
	),
	frameSubject: Type.Optional(
		Type.String({
			description:
				'Headless path only.',
			enum: ["module", "apply"],
		}),
	),
	cameraDistance: Type.Optional(
		Type.Number({
			description: 'Headless path only.',
			minimum: 0,
		}),
	),
	reviewSheet: Type.Optional(
		Type.Boolean({
			description:
				'Also render the plan\'s other shots into.',
			default: false,
		}),
	),
	forceRender: Type.Optional(
		Type.Boolean({
			description:
				'Headless path only.',
			default: false,
		}),
	),
	forcePreflight: Type.Optional(
		Type.Boolean({
			description:
				'Override block.',
			default: false,
		}),
	),
	referenceId: Type.Optional(
		Type.String({
			description:
				'Reference id whose image.',
		}),
	),
	resolution: Type.Optional(
		Type.Object({
			x: Type.Number({ description: 'Render width in pixels.' }),
			y: Type.Number({ description: 'Render height in pixels.' }),
			percentage: Type.Optional(Type.Number({ description: 'Resolution percentage (default 100).' })),
		}),
	),
	samples: Type.Optional(
		Type.Number({
			description: 'Sample count override for Cycles renders.',
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: 'Execution timeout in seconds.',
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
		cameraProfile: params.cameraProfile as CameraProfile | undefined,
		frontAxis: params.frontAxis as CameraFrontAxis | undefined,
		cameraShots: params.cameraShots as CameraShotKind[] | undefined,
		frameSubject: params.frameSubject as "module" | "apply" | undefined,
		cameraDistance: params.cameraDistance,
		reviewSheet: params.reviewSheet,
		forceRender: params.forceRender,
		forcePreflight: params.forcePreflight,
		referenceId: params.referenceId,
		resolution: params.resolution,
		samples: params.samples,
		timeoutSeconds: params.timeoutSeconds,
		signal: context?.signal,
	});

	const timing = formatTimings(result.timings);
	return {
		content: [{ type: "text", text: timing ? `${timing}\n${formatJsonResult(result)}` : formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderBranchApplyTool: CoreToolDefinition = {
	name: "blender_branch_apply",
	label: "Blender Branch Apply",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Apply staged branch runs into model.blend in one locked pass, in the order their branch runs were staged. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	modules: Type.Array(Type.String(), {
		description:
			'Module names to apply.',
	}),
	forcePreflight: Type.Optional(
		Type.Boolean({
			description: 'Override block.',
			default: false,
		}),
	),
	timeoutSeconds: Type.Optional(
		Type.Number({
			description: 'Timeout for the whole apply batch in seconds.',
			default: 300,
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderBranchApply({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		modules: params.modules,
		forcePreflight: params.forcePreflight,
		timeoutSeconds: params.timeoutSeconds,
		signal: context?.signal,
	});

	const timing = formatTimings(result.timings);
	return {
		content: [{ type: "text", text: timing ? `${timing}\n${formatJsonResult(result)}` : formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderModuleRevertTool: CoreToolDefinition = {
	name: "blender_module_revert",
	label: "Blender Module Revert",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Revert model.blend to a module\'s recorded pre-run checkpoint and reload it in the live Blender session. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	moduleName: Type.String({
		description: 'Module name to revert.',
	}),
	iteration: Type.Optional(
		Type.Number({
			description:
				'Revert.',
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description:
				'Allow.',
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	description:
	'Switch the live Blender viewport/object mode for a workspace blend, enabling texture paint. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
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
				'Target viewport/object mode.',
		},
	),
	objectName: Type.Optional(
		Type.String({
			description:
					'Optional object to act on.',
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

export const blenderSwitchWorkspaceTool: CoreToolDefinition = {
	name: "blender_switch_workspace",
	label: "Blender Switch Workspace",
	annotations: {
	// Changes what the live UI is showing, but writes no files and
	// touches no blend data: the scene itself is unmodified.
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
},
	description:
	'Switch the active workspace tab in the live Blender window by workspace name. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	workspaceName: Type.Optional(
		Type.String({
			description:
				'Workspace tab name to switch to, e.g. Modeling.',
		}),
	),
	spaceType: Type.Optional(
		Type.String({
			description:
				'Editor space type to switch to, e.g. VIEW_3D.',
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderSwitchWorkspace({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		workspaceName: params.workspaceName,
		spaceType: params.spaceType,
		signal: context?.signal,
	});

	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderFocusViewTool: CoreToolDefinition = {
	name: "blender_focus_view",
	label: "Blender Focus View",
	annotations: {
	// Changes what the live UI is showing, but writes no files and
	// touches no blend data: the scene itself is unmodified.
	readOnlyHint: false,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: true,
},
	description:
	'Center and frame the 3D viewport on a named object in the live Blender window. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	objectName: Type.String({
		description: 'Name.',
	}),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderFocusView({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	description:
	'Append a structured critique entry to the workspace critique.log using the 0-12 Blender iteration rubric. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	moduleName: Type.String({
		description:
			'The module this critique judged.',
	}),
	iteration: Type.Optional(
		Type.Number({
			description:
				'Optional iteration number.',
		}),
	),
	accuracy: Type.Number({
		description: 'Accuracy score from 0 to 2.',
		minimum: 0,
		maximum: 2,
	}),
	geometry: Type.Number({
		description: 'Geometry and proportions score from 0 to 2.',
		minimum: 0,
		maximum: 2,
	}),
	materials: Type.Number({
		description: 'Materials and appearance score from 0 to 2.',
		minimum: 0,
		maximum: 2,
	}),
	completeness: Type.Number({
		description: 'Completeness score from 0 to 2.',
		minimum: 0,
		maximum: 2,
	}),
	quality: Type.Number({
		description: 'Quality score from 0 to 2.',
		minimum: 0,
		maximum: 2,
	}),
	validity: Type.Number({
		description:
			'Is.',
		minimum: 0,
		maximum: 2,
	}),
	viewAdequacy: Type.Number({
		description:
			'Can the asset be judged FROM this render?',
		minimum: 0,
		maximum: 2,
	}),
	viewNote: Type.String({
		description: 'Free text on the framing, coverage.',
	}),
	issues: Type.Array(
		Type.String({
				description: 'Concrete problems found.',
		}),
	),
	nextAction: Type.String({
		description: 'Either a fix to attempt next.',
	}),
	rejectReason: Type.Optional(
		Type.String({
			description:
				'Reject the asset outright, whatever it.',
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
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Rank a batch against ITSELF and return the best slice. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.String({ description: 'Explicit workspace path for the Blender task.' }),
	topFraction: Type.Optional(
		Type.Number({
			description:
				'Fraction of ELIGIBLE assets to keep, 0..1.',
		}),
	),
	minScore: Type.Optional(
		Type.Number({
			description:
				'Score.',
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
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'What this module\'s iteration loop already knows, derived. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.String({ description: 'Explicit workspace path for the Blender task.' }),
	moduleName: Type.String({
		description:
			'The module to report on.',
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
		...(result.lastVerdict
			? [
					`Axes: ${Object.entries(result.lastVerdict.axes).map(([label, score]) => `${label} ${score}/2`).join(", ") || "not logged"}`,
					`Blocking axes: ${result.lastVerdict.blockingAxes === undefined ? "not logged" : result.lastVerdict.blockingAxes.join(", ") || "none"}`,
					`Issues: ${result.lastVerdict.issues === undefined ? "not logged" : result.lastVerdict.issues.join("; ") || "none"}`,
					...(result.lastVerdict.nextAction ? [`Next action: ${result.lastVerdict.nextAction}`] : []),
				]
			: []),
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Persist one MEASURED fact about this module so it survives the critic that measured it, a context fold. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	workspace: Type.String({ description: 'Explicit workspace path for the Blender task.' }),
	moduleName: Type.String({ description: 'The module the fact is about.' }),
	statement: Type.String({
		description:
			'The measured finding itself.',
	}),
	source: Type.String({
		description:
			'Which tool produced it.',
	}),
	iteration: Type.Optional(
		Type.Number({ description: 'The run the measurement belongs to.' }),
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	description:
	'Export the workspace blend to glb, gltf, obj, or stl with materials and scene graph. Full rules: skill `blender-create`.',
	parameters: Type.Object({
	workspace: Type.String({ description: 'Explicit workspace path for the Blender task.' }),
	format: Type.Optional(
		Type.String({
			description: 'glb (default), gltf, obj, or stl (geometry only).',
			enum: ["glb", "gltf", "obj", "stl"],
		}),
	),
	objects: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Names to export, when given.',
		}),
	),
	outputDir: Type.Optional(
		Type.String({
			description: 'Directory for the exported file.',
		}),
	),
	name: Type.Optional(
		Type.String({
			description: 'Base filename, without extension.',
		}),
	),
	animations: Type.Optional(
		Type.Boolean({
			description: 'Include animation data (glTF only).',
		}),
	),
	allowUnfinalized: Type.Optional(
		Type.Boolean({
			description:
				'Export.',
		}),
	),
	validationProfile: Type.Optional(
		Type.String({
			description:
				'Validation to run on the written file.',
			enum: ["gltf", "print", "engine", "none"],
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
		allowUnfinalized: params.allowUnfinalized,
		validationProfile: params.validationProfile as AssetExportOptions["validationProfile"],
	});

	const validationLines: string[] = [];
	if (result.validation) {
		const verdict = result.validation.ok ? "pass" : "FAILED";
		validationLines.push(`Validation (${result.validation.profile}): ${verdict}.`);
		for (const check of result.validation.checks) {
			if (check.status !== "pass") {
				validationLines.push(`  ${check.status}: ${check.name} — ${check.detail}`);
			}
		}
	}

	return {
		content: [
			{
				type: "text",
				text: [
					`Exported ${result.format} to ${result.exportPath} (${result.bytes} bytes, ${result.meshCount} mesh(es)).`,
					...validationLines,
					...(result.warnings ?? []).map((warning) => `Warning: ${warning}`),
				].join("\n"),
			},
		],
		details: result,
	};
	},
};

export const blenderImportAssetTool: CoreToolDefinition = {
	name: "blender_import_asset",
	label: "Blender Import Asset",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: false,
	},
	description:
	'Import an external 3D asset (obj, stl, gltf/glb, fbx) into the workspace blend. Full rules: skill `blender-create`.',
	parameters: Type.Object({
	workspace: Type.String({ description: 'Explicit workspace path for the Blender task.' }),
	path: Type.String({ description: 'Path to the 3D asset file to import (obj, stl, gltf, glb, or fbx).' }),
	format: Type.Optional(
		Type.String({
			description: 'Format of the asset: obj, stl, gltf, glb.',
			enum: ["obj", "stl", "gltf", "glb", "fbx"],
		}),
	),
	name: Type.Optional(
		Type.String({
			description: 'Optional asset name or object name prefix.',
		}),
	),
	allowedPaths: Type.Optional(
		Type.Array(Type.String(), {
			description: 'Allowed directories.',
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderImportAsset({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		path: params.path,
		format: params.format as ImportFormat | undefined,
		name: params.name,
		allowedPaths: params.allowedPaths,
	});

	if (!result.success) {
		return {
			content: [
				{
					type: "text",
					text: `Import failed: ${result.error}`,
				},
			],
			details: result,
		};
	}

	return {
		content: [
			{
				type: "text",
				text: `Imported ${result.format} asset "${result.assetName}" (${result.importedObjects.length} object(s): ${result.importedObjects.join(", ")}). Pre-import checkpoint saved to ${result.checkpointPath}.${result.report?.hasNonUniformScale ? " Warning: non-uniform scale detected." : ""}`,
			},
		],
		details: result,
	};
	},
};

export const blenderAddReferenceTool: CoreToolDefinition = {
	name: "blender_add_reference",
	label: "Blender Add Reference",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Register a reference image with a workspace. Full rules: skill `blender-create`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	path: Type.Optional(
		Type.String({
			description:
				'Path to an existing image file on disk.',
		}),
	),
	url: Type.Optional(
		Type.String({
			description:
				'HTTPS image URL.',
		}),
	),
	license: Type.Optional(
		Type.String({ description: 'Licence stated by the source.' }),
	),
	credit: Type.Optional(
		Type.String({ description: 'Credit line required.' }),
	),
	caption: Type.String({
		description:
			'What this image depicts.',
	}),
	id: Type.Optional(
		Type.String({
			description:
				'Stable id.',
		}),
	),
	suggestedView: Type.Optional(
		Type.String({
			description:
				'Optional saved view.',
		}),
	),
}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderAddReference({
		cwd: context?.cwd ?? process.cwd(),
		workspace: params.workspace,
		path: params.path,
		url: params.url,
		license: params.license,
		credit: params.credit,
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

export const blenderReferenceSearchTool: CoreToolDefinition = {
	name: "blender_reference_search",
	label: "Blender Reference Search",
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	description:
		'Search CC0 reference catalogues (Poly Haven models/textures/HDRI, ambientCG materials) and return metadata. Full rules: skill `blender-create`.',
	parameters: Type.Object({
		query: Type.String({ description: 'Words to match against the asset name, id.' }),
		source: Type.Optional(
			Type.String({ enum: ["polyhaven", "ambientcg"], description: 'Catalogue to search.' }),
		),
		kind: Type.Optional(
			Type.String({ enum: ["model", "texture", "hdri"], description: 'Poly Haven asset type.' }),
		),
		limit: Type.Optional(Type.Number({ description: 'Maximum candidates (1–24, default 8).', minimum: 1, maximum: 24 })),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const candidates = await searchReferenceSources({
			query: params.query,
			source: params.source as ReferenceSource | undefined,
			kind: params.kind as "model" | "texture" | "hdri" | undefined,
			limit: params.limit,
			signal: context?.signal,
		});
		return { content: [{ type: "text", text: formatJsonResult({ candidates }) }], details: { candidates } };
	},
};

export const blenderBridgeStatusTool: CoreToolDefinition = {
	name: "blender_bridge_status",
	label: "Blender Bridge Status",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	description:
	'Check whether the live Blender bridge can serve a request right now: is the UI running. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.Optional(
		Type.String({
			description: 'Optional workspace path.',
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
	readOnly: true,
	label: "Blender Geometry Probe",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	description:
	'Measure mesh/transform relationships in the workspace blend and return numbers: world-space bounds. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	objects: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Object names to measure.',
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
					'Object-name pairs.',
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
					'Reference dimensions per object name.',
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
				Type.Literal("sculpt"),
			]),
			{
				description:
					'Measurement families to run.',
			},
		),
	),
	symmetryAxis: Type.Optional(
		Type.Union([Type.Literal("x"), Type.Literal("y"), Type.Literal("z")], {
			description:
				'Axis.',
		}),
	),
	densityCap: Type.Optional(
		Type.Number({
			description:
				'Face ceiling for the `sculpt` check\'s density budget.',
		}),
	),
	tolerance: Type.Optional(
		Type.Number({
			description:
				'Contact distance.',
		}),
	),
	expectedAxis: Type.Optional(
		Type.Union([Type.Literal("X"), Type.Literal("Y"), Type.Literal("Z")], {
			description:
				'The axis a part\'s thin direction should.',
		}),
	),
	body: Type.Optional(
		Type.Number({
			description:
				'`clearance` and `path` only.',
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
					'World `[x, y]` positions.',
			}),
		),
	),
	detour: Type.Optional(
		Type.Number({
			description:
				'`path` only.',
		}),
	),
	cell: Type.Optional(
		Type.Number({
			description:
				'`clearance` and `path` only.',
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				'Bridge timeout override in ms.',
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
		symmetryAxis: params.symmetryAxis,
		body: params.body,
		cell: params.cell,
		points: params.points,
		detour: params.detour,
		densityCap: params.densityCap,
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
	readOnly: true,
	label: "Blender Image Probe",
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Measure a rendered PNG numerically instead of judging it by eye: subject pixel bounds and coverage, mean. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	path: Type.String({
		description:
			'Path to the PNG to measure.',
	}),
	background: Type.Optional(
		Type.Array(Type.Number(), {
			minItems: 3,
			maxItems: 3,
			description:
				'The image\'s background colour.',
		}),
	),
	tolerance: Type.Optional(
		Type.Number({
			description:
				'Per-channel 0..1 tolerance.',
		}),
	),
	grid: Type.Optional(
		Type.Array(Type.Number(), {
			minItems: 2,
			maxItems: 2,
			description:
				'Luma grid resolution as [nx, ny]. Defaults to [8, 8].',
		}),
	),
	paletteLimit: Type.Optional(
		Type.Number({
			description: 'How many dominant subject colours.',
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Run a Python measurement script in the LIVE scene and get its stdout; mutating bpy operations are refused. Full rules: skill `blender-live-state`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	script: Type.String({
		description:
			'The Python to run, as text.',
	}),
	timeoutMs: Type.Optional(
		Type.Number({
			description: 'Bridge timeout override.',
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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Render several preset views of one subject and tile them into a single labelled sheet, plus. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	moduleName: Type.String({
		description: 'Module the sheet belongs to.',
	}),
	views: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 4,
		description:
			'Preset view names.',
	}),
	subject: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Objects to frame.',
		}),
	),
	columns: Type.Optional(
		Type.Number({
			description:
				'Sheet columns.',
		}),
	),
	panelResolution: Type.Optional(
		Type.Object({
			x: Type.Number({ description: 'Panel width in pixels (default 900).' }),
			y: Type.Number({ description: 'Panel height in pixels (default 700).' }),
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				'Bridge timeout override in ms.',
		}),
	),
	async: Type.Optional(
		Type.Boolean({
			description:
				'If true, dispatch.',
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
		async: params.async,
		signal: context?.signal,
	});

	if ("jobId" in result) {
		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	}

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
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: true,
	},
	description:
	'Render the PREVIOUS generation of a subject beside the current one on a single labelled sheet, so. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	workspace: Type.String({
		description: 'Explicit workspace path for the Blender task.',
	}),
	moduleName: Type.String({
		description:
			'Module whose two generations are compared.',
	}),
	baselineBlendPath: Type.Optional(
		Type.String({
			description:
				'The generation.',
		}),
	),
	baselineLabel: Type.Optional(
		Type.String({
			description:
				'What.',
		}),
	),
	currentLabel: Type.Optional(
		Type.String({
			description: 'What to call the current generation.',
		}),
	),
	views: Type.Array(Type.String(), {
		minItems: 1,
		maxItems: 4,
		description:
			'Preset view names, same as blender_montage.',
	}),
	subject: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'Objects to frame and compare.',
		}),
	),
	columns: Type.Optional(
		Type.Number({
			description: 'Sheet columns.',
		}),
	),
	panelResolution: Type.Optional(
		Type.Object({
			x: Type.Number({ description: 'Panel width in pixels (default 900).' }),
			y: Type.Number({ description: 'Panel height in pixels (default 700).' }),
		}),
	),
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				'Bridge timeout override in ms.',
		}),
	),
	async: Type.Optional(
		Type.Boolean({
			description:
				'If true, dispatch.',
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
		async: params.async,
		signal: context?.signal,
	});

	if ("jobId" in result) {
		return {
			content: [{ type: "text", text: formatJsonResult(result) }],
			details: result,
		};
	}

	const missing = result.baseline.missingSubjects;
	return {
		content: [
			{
				type: "text",
				text: [
					`Comparison: ${result.montagePath}`,
					result.baseline.blendPath
						? `Baseline: ${result.labels.baseline} = ${result.baseline.blendPath}`
						: `Baseline: ${result.labels.baseline}`,
					`Current: ${result.labels.current}`,
					`Views: ${result.views.join(", ")} (${result.layout.columns}x${result.layout.rows} of ${result.layout.panelWidth}x${result.layout.panelHeight})`,
					result.subject.length > 0 ? `Framed: ${result.subject.join(", ")}` : undefined,
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

export const blenderGetPythonApiDocsTool: CoreToolDefinition = {
	name: "blender_get_python_api_docs",
	label: "Blender Get Python API Docs",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Look up a bpy identifier in the Blender 4.2 LTS Python API reference. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	identifier: Type.String({
		description:
			'The bpy identifier to look up.',
	}),
}),
	execute: async (params, _context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderGetPythonApiDocs({
		identifier: params.identifier,
	});

	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderSearchApiDocsTool: CoreToolDefinition = {
	name: "blender_search_api_docs",
	label: "Blender Search API Docs",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Perform full-text search across the curated Blender 4.2 LTS Python API reference corpus. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	query: Type.String({
		description:
			'Search query string.',
	}),
	limit: Type.Optional(
		Type.Number({
			description: 'Maximum number.',
		}),
	),
}),
	execute: async (params, _context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderSearchApiDocs({
		query: params.query,
		limit: params.limit,
	});

	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderSearchManualDocsTool: CoreToolDefinition = {
	name: "blender_search_manual_docs",
	label: "Blender Search Manual Docs",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Perform full-text search across curated Blender 4.2 LTS user manual excerpts. Full rules: skill `blender-analyze`.',
	parameters: Type.Object({
	query: Type.String({
		description:
			'Search query string.',
	}),
	limit: Type.Optional(
		Type.Number({
			description: 'Maximum number.',
		}),
	),
}),
	execute: async (params, _context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderSearchManualDocs({
		query: params.query,
		limit: params.limit,
	});

	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderJobStatusTool: CoreToolDefinition = {
	name: "blender_job_status",
	label: "Blender Job Status",
	annotations: {
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Check the state, execution progress. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	jobId: Type.String({
		description: 'The unique job identifier returned when.',
	}),
}),
	execute: async (params, _context?: CoreToolContext): Promise<CoreToolResult> => {
	const result = await blenderJobStatus({ jobId: params.jobId });
	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};

export const blenderWorkspacePruneTool: CoreToolDefinition = {
	name: "blender_workspace_prune",
	label: "Blender Workspace Prune",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Report or remove old iteration renders that no module\'s newest render and no current critique depends on. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
		workspace: Type.String({ description: 'Explicit workspace path.' }),
		dryRun: Type.Optional(
			Type.Boolean({
				description: 'Report what would be removed without.',
			}),
		),
		keepIterations: Type.Optional(
			Type.Number({
				description: 'How many of the newest iterations to keep.',
			}),
		),
		includeCheckpoints: Type.Optional(
			Type.Boolean({
				description: 'Also plan old run checkpoints over.',
			}),
		),
		includeBranches: Type.Optional(
			Type.Boolean({
				description: 'Also plan applied branch copies whose.',
			}),
		),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderWorkspacePrune({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			dryRun: params.dryRun,
			keepIterations: params.keepIterations,
			includeCheckpoints: params.includeCheckpoints,
			includeBranches: params.includeBranches,
		});
		return {
			content: [{ type: "text", text: result.note }],
			details: result,
		};
	},
};

export const blenderJobCancelTool: CoreToolDefinition = {
	name: "blender_job_cancel",
	label: "Blender Job Cancel",
	annotations: {
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	},
	description:
	'Cancel a deferred Blender job that is still running (render, montage or compare dispatched with async: true). Full rules: skill `blender-modules`.',
	parameters: Type.Object({
	jobId: Type.String({
		description: 'The unique job identifier returned when.',
	}),
	reason: Type.Optional(
		Type.String({
			description: 'Why the job is being cancelled, stored.',
		}),
	),
}),
	execute: async (params): Promise<CoreToolResult> => {
	const result = await cancelJob(params.jobId, params.reason);
	return {
		content: [{ type: "text", text: formatJsonResult(result) }],
		details: result,
	};
	},
};


export const blenderBuildStatusTool: CoreToolDefinition = {
	name: "blender_build_status",
	label: "Blender Build Status",
	annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		'Read the build contract\'s current stage and history. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
		workspace: Type.String({ description: 'Explicit workspace path for the Blender task.' }),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderBuildStatus({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			signal: context?.signal,
		});
		return { content: [{ type: "text", text: formatJsonResult(result) }], details: result };
	},
};

export const blenderBuildAdvanceTool: CoreToolDefinition = {
	name: "blender_build_advance",
	label: "Blender Build Advance",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
	description:
		'Advance the build contract to a stage the extension cannot observe by itself, with evidence. Full rules: skill `blender-modules`.',
	parameters: Type.Object({
		workspace: Type.String({ description: 'Explicit workspace path for the Blender task.' }),
		stage: Type.String({
			enum: ["intake", "planned", "finalized"],
			description: 'Stage to record.',
		}),
		evidence: Type.String({ description: 'What was checked or produced for this stage.' }),
		actor: Type.Optional(Type.String({ description: 'Who performed it.' })),
	}),
	execute: async (params, context?: CoreToolContext): Promise<CoreToolResult> => {
		const result = await blenderBuildAdvance({
			cwd: context?.cwd ?? process.cwd(),
			workspace: params.workspace,
			stage: params.stage as any,
			evidence: params.evidence,
			actor: params.actor,
			signal: context?.signal,
		});
		return { content: [{ type: "text", text: formatJsonResult(result) }], details: result };
	},
};

export const BLENDER_TOOLS: CoreToolDefinition[] = [
	blenderWorkspaceInitTool,
	blenderWorkspacePruneTool,
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
	blenderReferenceSearchTool,
	blenderBridgeStatusTool,
	blenderGeometryProbeTool,
	blenderImageProbeTool,
	blenderReadOnlyPythonTool,
	blenderMontageTool,
	blenderCompareTool,
	blenderObjectDetailTool,
	blenderImportAssetTool,
	blenderGetPythonApiDocsTool,
	blenderSearchApiDocsTool,
	blenderSearchManualDocsTool,
	blenderWindowLayoutTool,
	blenderSwitchWorkspaceTool,
	blenderFocusViewTool,
	blenderJobStatusTool,
	blenderJobCancelTool,
	blenderUsageGuessTool,
	blenderBuildStatusTool,
	blenderBuildAdvanceTool,
];

export const BLENDER_TOOL_NAMES = BLENDER_TOOLS.map((t) => t.name);

export const READ_ONLY_TOOL_NAMES = [
	"blender_session_context",
	"blender_scene_info",
	"blender_geometry_probe",
	"blender_image_probe",
] as const;

export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];

/**
 * The inspection subset the MCP façade exposes.
 *
 * Deliberately NOT derived from `annotations.readOnlyHint`: that hint answers
 * "will a client-visible side effect occur", while this list answers "is this a
 * pure inspection endpoint worth exposing over MCP". `blender_scene_info`,
 * `blender_geometry_probe` and `blender_image_probe` carry readOnlyHint: false
 * because they write measurement files, yet they are still the three tools a
 * reviewer wants; conflating the two would silently shrink the façade.
 */
export const READ_ONLY_TOOLS = BLENDER_TOOLS.filter((tool) =>
	(READ_ONLY_TOOL_NAMES as readonly string[]).includes(tool.name),
);

export function getTool(name: string): CoreToolDefinition | undefined {
	return BLENDER_TOOLS.find((t) => t.name === name);
}
