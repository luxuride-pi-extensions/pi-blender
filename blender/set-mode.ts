import { requestLiveBlenderSetMode } from "./bridge.js";
import type { BlenderViewportMode, SetModeOptions, SetModeResult } from "./types.js";
import { loadWorkspaceManifest } from "./workspace.js";

export type { BlenderViewportMode, SetModeOptions, SetModeResult };

export async function blenderSetMode(options: SetModeOptions): Promise<SetModeResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const result = await requestLiveBlenderSetMode({
		blendPath: manifest.blendPath,
		mode: options.mode,
		objectName: options.objectName,
		signal: options.signal,
	});

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		mode: options.mode,
		blenderMode: result.blenderMode,
		objectName: result.objectName,
		uvEditorOverlay: result.uvEditorOverlay,
	};
}
