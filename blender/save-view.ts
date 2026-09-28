import { requestLiveBlenderCapture } from "./bridge.js";
import { getSceneInfoFromManifest } from "./scene-info.js";
import type { BlenderSavedView, SaveViewOptions, SaveViewResult } from "./types.js";
import { getStringRecordValue, nowIso } from "./utils.js";
import { loadWorkspaceManifest, updateManifest } from "./workspace.js";

export async function blenderSaveView(options: SaveViewOptions): Promise<SaveViewResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	let cameraObjectName: string | null = null;
	let cameraSettingsName: string | null = null;

	if (options.source === "active-camera") {
		const captureCameraName = options.camera_name?.trim() || options.name;
		const captureResult = await requestLiveBlenderCapture({
			blendPath: manifest.blendPath,
			viewName: options.name,
			cameraObjectName: captureCameraName,
			signal: options.signal,
		});
		cameraObjectName = captureResult.cameraObjectName;
		cameraSettingsName = captureResult.cameraSettingsName;
	} else {
		const sceneInfo = await getSceneInfoFromManifest(options.cwd, manifest, {
			categories: ["cameras"],
			signal: options.signal,
		});
		for (const camera of sceneInfo.cameras) {
			const candidate = getStringRecordValue(camera, "name");
			if (candidate && candidate === options.source) {
				cameraObjectName = candidate;
				cameraSettingsName = getStringRecordValue(camera, "cameraSettingsName");
				break;
			}
		}
	}

	if (!cameraObjectName) {
		throw new Error(`Unable to resolve view source "${options.source}" to a camera in ${manifest.blendPath}`);
	}

	const savedView: BlenderSavedView = {
		name: options.name,
		cameraObjectName,
		cameraSettingsName: cameraSettingsName ?? undefined,
		source: options.source,
		savedAt: nowIso(),
	};
	// Merge into the manifest on disk rather than writing back this snapshot:
	// resolving a camera can take a background scene read, and a module run
	// that finished in the meantime must not be clobbered.
	await updateManifest(manifest.manifestPath, (current) => {
		current.savedViews[options.name] = savedView;
	});

	return {
		workspacePath: manifest.workspacePath,
		manifestPath: manifest.manifestPath,
		savedView,
	};
}
