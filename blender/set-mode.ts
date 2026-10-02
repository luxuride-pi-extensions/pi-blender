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

	// `switched: false` is a real outcome, not a failure: a viewport mode is a
	// statement about a UI, and the default run has no UI. The requested mode
	// is reported back either way, so a caller reading `mode` is never handed
	// undefined, and `switched` is the single field that says which of the two
	// happened.
	if (!result.ok) {
		return {
			workspacePath: manifest.workspacePath,
			blendPath: manifest.blendPath,
			mode: options.mode,
			switched: false,
			blenderMode: null,
			objectName: options.objectName ?? "",
			uvEditorOverlay: false,
			reason: result.reason,
		};
	}

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		mode: options.mode,
		switched: true,
		blenderMode: result.blenderMode,
		objectName: result.objectName,
		uvEditorOverlay: result.uvEditorOverlay,
	};
}
