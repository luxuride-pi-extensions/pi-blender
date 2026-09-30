import { dirname } from "node:path";
import { NoWatchWindowError, requestLiveBlenderSessionContext } from "./bridge.js";
import { findLiveOwnersOfBlend } from "./ownership.js";
import type {
	BlenderSessionContextCategory,
	SessionContextOptions,
	SessionContextResult,
	SessionContextWarningCode,
} from "./types.js";
import { fileExists, LIVE_BRIDGE_TIMEOUT_MS, normalizeWorkspacePath, runBlenderJson, WARNING_SEVERITY } from "./utils.js";
import { getManifestPath, loadWorkspaceManifest } from "./workspace.js";

/**
 * The same snapshot, read from the .blend by a headless Blender.
 *
 * Answers what is on DISK, which is the part a manager can act on and the part
 * a window cannot change behind its back: which file, which scene, which
 * camera. It deliberately does not invent the live-only sections —
 * selection, mode and viewport are properties of a running session, and a
 * plausible-looking answer for them would be worse than an honest null.
 *
 * The failure mode this guards is worth naming: without it, a session with no
 * window has no way to read its own workspace at all, and a manager asked
 * "what is selected" would be told to open Blender — the one thing it was told
 * it should not do by hand.
 */
const HEADLESS_CONTEXT_SCRIPT = `
import bpy, json, os

scene = bpy.context.scene
active = bpy.context.view_layer.objects.active if bpy.context.view_layer else None
result = {
    "blendPath": bpy.data.filepath if bpy.data.filepath else None,
    "isSaved": bool(bpy.data.filepath),
    # Nothing has run against this process, so the file is by construction
    # exactly what is on disk. Claiming dirty here would be a fabrication that
    # every caller would have to learn to discount.
    "isDirty": False,
    "scene": {
        "name": scene.name if scene else None,
        "availableScenes": [candidate.name for candidate in bpy.data.scenes],
        "frameCurrent": int(scene.frame_current) if scene else None,
        "activeCameraName": scene.camera.name if scene and scene.camera else None,
    },
    "objectCount": len(bpy.data.objects),
}
print("PI_BLENDER_JSON:" + json.dumps(result))
`;

interface HeadlessContext {
	blendPath: string | null;
	isSaved: boolean;
	isDirty: boolean;
	scene: {
		name: string | null;
		availableScenes: string[];
		frameCurrent: number | null;
		activeCameraName: string | null;
	};
	objectCount: number;
}

async function headlessSessionContext(options: SessionContextOptions): Promise<SessionContextResult> {
	const requestedWorkspacePath = options.workspace ? normalizeWorkspacePath(options.cwd, options.workspace) : null;
	let blendPath: string | null = null;
	let workspacePath: string | null = null;
	let matchesWorkspace: boolean | null = null;
	let headless: HeadlessContext | null = null;
	let failure: string | null = null;

	// A workspace is the only way to know WHICH file to read; with no workspace
	// there is nothing to open, which is reported rather than guessed at.
	if (requestedWorkspacePath) {
		const manifest = await loadWorkspaceManifest(options.cwd, options.workspace ?? requestedWorkspacePath);
		blendPath = manifest.blendPath;
		workspacePath = manifest.workspacePath;
		matchesWorkspace = true;
		try {
			headless = await runBlenderJson<HeadlessContext>({
				cwd: options.cwd,
				blendPath: manifest.blendPath,
				scriptSource: HEADLESS_CONTEXT_SCRIPT,
				payload: {},
				timeoutMs: options.timeoutMs,
				signal: options.signal,
			});
		} catch (error) {
			// The file sections are then reported from the manifest, which is the
			// same path the caller asked for, rather than left as a hard failure
			// over a probe that was a bonus.
			failure = error instanceof Error ? error.message : String(error);
		}
	}

	const warningCodes: SessionContextWarningCode[] = [];
	const warnings: string[] = [];
	const warn = (code: SessionContextWarningCode, message: string): void => {
		warningCodes.push(code);
		warnings.push(message);
	};
	warn(
		"no-watch-window",
		"No Blender window is open, so this is a headless read of what is on disk: there is no selection, mode or viewport to report. " +
			"Run /blender-watch for a live view. Edits still go through the headless module path.",
	);
	if (!requestedWorkspacePath) {
		warn(
			"workspace-mismatch",
			"No workspace was named, and with no window there is no open blend to infer one from, so there is no file to read. " +
				"Pass a workspace to read its model.blend.",
		);
	}
	if (failure) {
		warn("headless-probe-failed", `The headless read of ${blendPath ?? "the blend"} failed: ${failure}`);
	}

	return {
		requestedWorkspacePath,
		requestedBlendPath: blendPath,
		workspacePath,
		matchesWorkspace,
		sharedWith: [],
		warningCodes,
		warnings,
		file: shouldInclude(options.include, "file")
			? { blendPath: headless?.blendPath ?? blendPath, isSaved: headless?.isSaved ?? blendPath !== null, isDirty: headless?.isDirty ?? false }
			: null,
		scene: shouldInclude(options.include, "scene")
			? (headless?.scene ?? { name: null, availableScenes: [], frameCurrent: null, activeCameraName: null })
			: null,
		selection: null,
		mode: null,
		viewport: null,
	};
}

function shouldInclude(
	include: BlenderSessionContextCategory[] | undefined,
	category: BlenderSessionContextCategory,
): boolean {
	return !include || include.length === 0 || include.includes(category);
}

export async function blenderSessionContext(options: SessionContextOptions): Promise<SessionContextResult> {
	let bridgeResult: Awaited<ReturnType<typeof requestLiveBlenderSessionContext>>;
	try {
		bridgeResult = await requestLiveBlenderSessionContext({
			signal: options.signal,
			timeoutMs: options.timeoutMs ?? LIVE_BRIDGE_TIMEOUT_MS,
		});
	} catch (error) {
		// No window is open, which is the normal state of a session that has not
		// run /blender-watch. Selection, mode and viewport are properties of a
		// LIVE session and have no headless equivalent, so those are honestly
		// null; the file and scene are not, and a manager that cannot read what
		// is on disk is blind in the one mode this extension spends most of its
		// time in. So this reads the blend headlessly instead of failing.
		if (!(error instanceof NoWatchWindowError)) throw error;
		return headlessSessionContext(options);
	}

	const warnings: string[] = [];
	const warningCodes: SessionContextWarningCode[] = [];
	const warn = (code: SessionContextWarningCode, message: string): void => {
		warningCodes.push(code);
		warnings.push(message);
	};
	const requestedWorkspacePath = options.workspace ? normalizeWorkspacePath(options.cwd, options.workspace) : null;
	let requestedBlendPath: string | null = null;
	let workspacePath: string | null = null;
	let matchesWorkspace: boolean | null = null;

	if (requestedWorkspacePath) {
		const manifest = await loadWorkspaceManifest(options.cwd, options.workspace ?? requestedWorkspacePath);
		requestedBlendPath = manifest.blendPath;
		matchesWorkspace = bridgeResult.blendPath === manifest.blendPath;
		workspacePath = matchesWorkspace ? manifest.workspacePath : null;
		if (!matchesWorkspace) {
			warn(
				"workspace-mismatch",
				bridgeResult.blendPath
					? `Live Blender is on "${bridgeResult.blendPath}", not the requested workspace blend "${manifest.blendPath}".`
					: `Live Blender is on an unsaved scene, not the requested workspace blend "${manifest.blendPath}".`,
			);
		}
	} else if (bridgeResult.blendPath) {
		const inferredWorkspacePath = dirname(bridgeResult.blendPath);
		if (await fileExists(getManifestPath(inferredWorkspacePath))) {
			const manifest = await loadWorkspaceManifest(options.cwd, inferredWorkspacePath);
			requestedBlendPath = manifest.blendPath;
			matchesWorkspace = manifest.blendPath === bridgeResult.blendPath;
			workspacePath = matchesWorkspace ? manifest.workspacePath : null;
		}
	}

	if (!bridgeResult.isSaved) {
		warn("unsaved-scene", "Live Blender is on an unsaved scene.");
	}

	// A peer holding the same blend. Reported rather than enforced here, because
	// this tool is read-only: it can only tell the session that a second window
	// is watching the file it is about to mutate. The refusal lives in
	// loadWorkspaceManifest, which is the path that would actually open it.
	// The catch is deliberate: peer discovery is a read of other processes'
	// dirs, so any failure there must not cost this session its own snapshot.
	let sharedWith: SessionContextResult["sharedWith"] = [];
	if (bridgeResult.blendPath) {
		const peers = await findLiveOwnersOfBlend(bridgeResult.blendPath).catch(() => []);
		if (peers.length > 0) {
			sharedWith = peers;
			warn(
				"shared-with-peer",
				`Another live pi instance also has this blend open (${peers
					.map((peer) => `instance ${peer.instanceId}${peer.pid ? ` pid ${peer.pid}` : ""}`)
					.join(", ")}). Anything saved here overwrites what that instance has.`,
			);
		}
	}
	if (bridgeResult.isDirty) {
		warn("unsaved-changes", "Live Blender has unsaved changes.");
	}
	if (!bridgeResult.viewport.hasViewport) {
		warn("no-viewport", "No live VIEW_3D viewport is open in Blender.");
	}
	if (bridgeResult.selection.selectedObjectCount > 1) {
		warn(
			"ambiguous-selection",
			`There are ${bridgeResult.selection.selectedObjectCount} selected objects, so ambiguous references like "it" may require clarification.`,
		);
	}

	return {
		requestedWorkspacePath,
		requestedBlendPath,
		workspacePath,
		matchesWorkspace,
		sharedWith,
		warningCodes,
		warnings,
		file: shouldInclude(options.include, "file")
			? {
					blendPath: bridgeResult.blendPath,
					isSaved: bridgeResult.isSaved,
					isDirty: bridgeResult.isDirty,
				}
			: null,
		scene: shouldInclude(options.include, "scene") ? bridgeResult.scene : null,
		selection: shouldInclude(options.include, "selection") ? bridgeResult.selection : null,
		mode: shouldInclude(options.include, "mode") ? bridgeResult.mode : null,
		viewport: shouldInclude(options.include, "viewport") ? bridgeResult.viewport : null,
	};
}

function formatSelectedObjects(result: SessionContextResult): string | null {
	const selection = result.selection;
	if (!selection || selection.selectedObjectCount === 0) {
		return null;
	}

	const names = selection.selectedObjects.slice(0, 3).map((obj) => `\`${obj.name}\``);
	const suffix = selection.selectedObjectCount > 3 ? `, +${selection.selectedObjectCount - 3} more` : "";
	return `${names.join(", ")}${suffix}`;
}

export function formatCompactSessionContextPrompt(result: SessionContextResult): string | null {
	const lines: string[] = [];
	const blendPath = result.file?.blendPath;

	if (blendPath) {
		lines.push(`- Blend: \`${blendPath}\`${result.file?.isDirty ? " (unsaved changes)" : ""}`);
	} else if (result.file && !result.file.isSaved) {
		lines.push(`- Blend: unsaved scene${result.file.isDirty ? " (dirty)" : ""}`);
	}

	if (result.workspacePath) {
		lines.push(`- Workspace: \`${result.workspacePath}\``);
	}

	if (result.scene?.name || result.scene?.activeCameraName) {
		const sceneSummary = [result.scene?.name ? `\`${result.scene.name}\`` : "unknown scene"];
		if (result.scene?.activeCameraName) {
			sceneSummary.push(`camera \`${result.scene.activeCameraName}\``);
		}
		lines.push(`- Scene: ${sceneSummary.join(", ")}`);
	}

	if (result.mode?.mode || result.selection?.activeObject) {
		const targetSummary: string[] = [];
		if (result.mode?.mode) {
			targetSummary.push(`mode \`${result.mode.mode}\``);
		}
		if (result.selection?.activeObject) {
			targetSummary.push(`active object \`${result.selection.activeObject.name}\``);
		}
		lines.push(`- Target: ${targetSummary.join(", ")}`);
	}

	const selected = formatSelectedObjects(result);
	if (selected) {
		lines.push(`- Selected: ${selected}`);
	}

	if (result.viewport?.hasViewport) {
		const viewportSummary: string[] = [];
		if (result.viewport.viewPerspective) {
			viewportSummary.push(`\`${result.viewport.viewPerspective}\``);
		}
		if (result.viewport.shadingType) {
			viewportSummary.push(`\`${result.viewport.shadingType}\``);
		}
		if (result.viewport.cameraName) {
			viewportSummary.push(`view camera \`${result.viewport.cameraName}\``);
		}
		lines.push(`- Viewport: ${viewportSummary.join(", ")}`);
	}

	// Filter and rank by CODE, not by matching English prose. The old
	// substring filter meant that rewording "Another live pi instance" would
	// silently drop the peer warning from every manager turn, and that the
	// "not the requested workspace" key was unreachable here anyway (this path
	// passes no workspace, so that warning can never fire). Only the single most
	// severe line fits, and a peer overwriting the file outranks a vague
	// selection.
	let worstIndex = -1;
	let worstSeverity = 0;
	result.warningCodes.forEach((code, index) => {
		const severity = WARNING_SEVERITY[code];
		if (severity > worstSeverity) {
			worstSeverity = severity;
			worstIndex = index;
		}
	});
	if (worstIndex >= 0) {
		lines.push(`- Warning: ${result.warnings[worstIndex]}`);
	}

	if (lines.length === 0) {
		return null;
	}

	return [
		"Authoritative live Blender state for this turn only.",
		"Use this as the current source of truth for present-tense Blender UI questions such as:",
		'- "what is selected for now"',
		'- "update it"',
		'- "render from what I\'m looking at"',
		'- "change the selected object"',
		'- "make the active object metallic"',
		'- "fix this from the current angle"',
		"This block supersedes earlier live Blender context summaries, prior selections mentioned in message history, and prior assistant inferences about the current Blender UI state.",
		"If Blender changes during this turn and you need a fresher snapshot, call `blender_session_context` again.",
		"Current live Blender state:",
		...lines,
	].join("\n");
}
