import { dirname } from "node:path";
import { requestLiveBlenderSessionContext } from "./bridge.js";
import { findLiveOwnersOfBlend } from "./ownership.js";
import type {
	BlenderSessionContextCategory,
	SessionContextOptions,
	SessionContextResult,
	SessionContextWarningCode,
} from "./types.js";
import { fileExists, LIVE_BRIDGE_TIMEOUT_MS, normalizeWorkspacePath, WARNING_SEVERITY } from "./utils.js";
import { getManifestPath, loadWorkspaceManifest } from "./workspace.js";

function shouldInclude(
	include: BlenderSessionContextCategory[] | undefined,
	category: BlenderSessionContextCategory,
): boolean {
	return !include || include.length === 0 || include.includes(category);
}

export async function blenderSessionContext(options: SessionContextOptions): Promise<SessionContextResult> {
	const bridgeResult = await requestLiveBlenderSessionContext({
		signal: options.signal,
		timeoutMs: options.timeoutMs ?? LIVE_BRIDGE_TIMEOUT_MS,
	});

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
