import { requestLiveBlenderFocusView, requestLiveBlenderSwitchWorkspace } from "./bridge.js";
import type {
	FocusViewOptions,
	FocusViewResult,
	SwitchWorkspaceOptions,
	SwitchWorkspaceResult,
} from "./types.js";
import { loadWorkspaceManifest } from "./workspace.js";

export type {
	FocusViewOptions,
	FocusViewResult,
	SwitchWorkspaceOptions,
	SwitchWorkspaceResult,
};

export async function blenderSwitchWorkspace(
	options: SwitchWorkspaceOptions,
): Promise<SwitchWorkspaceResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const result = await requestLiveBlenderSwitchWorkspace({
		blendPath: manifest.blendPath,
		workspaceName: options.workspaceName,
		spaceType: options.spaceType,
		signal: options.signal,
	});

	if (!result.ok) {
		return {
			workspacePath: manifest.workspacePath,
			blendPath: manifest.blendPath,
			switched: false,
			moved: false,
			workspaceName: null,
			reason: result.reason,
		};
	}

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		switched: true,
		moved: true,
		workspaceName: result.workspaceName,
		activeSpaces: result.activeSpaces,
	};
}

export async function blenderFocusView(
	options: FocusViewOptions,
): Promise<FocusViewResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const result = await requestLiveBlenderFocusView({
		blendPath: manifest.blendPath,
		objectName: options.objectName,
		signal: options.signal,
	});

	if (!result.ok) {
		return {
			workspacePath: manifest.workspacePath,
			blendPath: manifest.blendPath,
			moved: false,
			focused: false,
			objectName: options.objectName,
			reason: result.reason,
		};
	}

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		moved: true,
		focused: true,
		objectName: result.objectName,
	};
}
