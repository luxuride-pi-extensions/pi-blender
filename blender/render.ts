import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NoWatchWindowError, requestLiveBlenderRender } from "./bridge.js";
import { dispatchDeferredJob } from "./jobs.js";
import type {
	BlenderRenderEngine,
	BlenderRenderMethod,
	BlenderRenderViewSource,
	BlenderViewportShading,
	DeferredJobHandle,
	RenderOptions,
	RenderResult,
} from "./types.js";
import { getSavedViewCameraObjectName, normalizeRenderOutputName, runBlenderJson } from "./utils.js";
import { getIterationPaths, loadWorkspaceManifest, updateManifest } from "./workspace.js";

function buildRenderScript(): string {
	return `
import bpy
import json
import os
import sys

payload = json.loads(sys.argv[sys.argv.index("--") + 1])
scene = bpy.context.scene

# The engine enum identifier is version-dependent: "BLENDER_EEVEE" became
# "BLENDER_EEVEE_NEXT" and the naming differs again on newer builds. Probing
# the real enum is the only thing that cannot go stale, and the studio
# template in workspace.ts already probes it this way.
def set_engine(scene, desired):
    if not desired:
        return scene.render.engine
    try:
        scene.render.engine = desired
    except (TypeError, ValueError):
        # Not a member of this build's enum: fall back to the candidates in
        # preference order, and only then give up.
        try:
            available = {
                item.identifier
                for item in scene.render.bl_rna.properties["engine"].enum_items
            }
        except (AttributeError, KeyError, TypeError):
            available = set()
        for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
            if candidate in available:
                scene.render.engine = candidate
                return scene.render.engine
        raise RuntimeError(
            f'No usable render engine for "{desired}"; this build offers: '
            + (", ".join(sorted(available)) or "nothing enumerable")
        )
    return scene.render.engine

resolved_engine = set_engine(scene, payload.get("renderEngine"))

camera_name = payload.get("cameraName")
if camera_name:
    camera_object = bpy.data.objects.get(camera_name)
    if camera_object is None:
        raise RuntimeError(f"Camera not found: {camera_name}")
    scene.camera = camera_object

if scene.camera is None:
    fallback = bpy.data.objects.get("Camera")
    if fallback is not None:
        scene.camera = fallback

if scene.camera is None:
    raise RuntimeError("No camera available for rendering")

resolution = payload.get("resolution") or {}
scene.render.resolution_x = int(resolution.get("x", scene.render.resolution_x))
scene.render.resolution_y = int(resolution.get("y", scene.render.resolution_y))
scene.render.resolution_percentage = int(resolution.get("percentage", scene.render.resolution_percentage))

samples = payload.get("samples")
if samples is not None and hasattr(scene, "cycles"):
    scene.cycles.samples = int(samples)

output_path = payload["outputPath"]
os.makedirs(os.path.dirname(output_path), exist_ok=True)
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = output_path
bpy.ops.render.render(write_still=True)

print("__PI_BLENDER_JSON_START__")
print(json.dumps({
    "outputPath": output_path,
    "cameraName": scene.camera.name if scene.camera else None,
    "resolvedEngine": resolved_engine,
    "requestedEngine": payload.get("renderEngine"),
    "resolution": {
        "x": int(scene.render.resolution_x),
        "y": int(scene.render.resolution_y),
        "percentage": int(scene.render.resolution_percentage),
    },
}))
print("__PI_BLENDER_JSON_END__")
`;
}

interface NormalizedRenderConfig {
	renderMethod: BlenderRenderMethod;
	viewSource: BlenderRenderViewSource;
	viewportShading: BlenderViewportShading | null;
	renderEngine: BlenderRenderEngine | null;
}

function normalizeRenderConfig(options: RenderOptions): NormalizedRenderConfig {
	const renderMethod = options.renderMethod ?? "live";
	const viewSource = options.viewSource ?? "camera";

	if (renderMethod === "live") {
		if (options.renderEngine) {
			throw new Error('renderEngine is only valid when renderMethod is "background".');
		}

		const normalized: NormalizedRenderConfig = {
			renderMethod,
			viewSource,
			viewportShading: options.viewportShading ?? "material-preview",
			renderEngine: null,
		};
		return normalized;
	}

	if (options.viewportShading) {
		throw new Error('viewportShading is only valid when renderMethod is "live".');
	}
	if (viewSource === "current-view") {
		throw new Error('viewSource="current-view" is only supported when renderMethod is "live".');
	}

	const normalized: NormalizedRenderConfig = {
		renderMethod,
		viewSource: "camera",
		viewportShading: null,
		renderEngine: options.renderEngine ?? null,
	};
	return normalized;
}

/**
 * Map a tool-level engine name to this build's enum identifier.
 *
 * The mapping is a PREFERENCE ORDER, not a translation: the identifiers were
 * renamed between Blender releases ("BLENDER_EEVEE" <-> "BLENDER_EEVEE_NEXT"),
 * and a hardcoded single identifier is wrong on one side of every rename —
 * which is why the generated script probes the real enum in `set_engine` and
 * walks this list. Same pattern as the studio template in workspace.ts, which
 * probes the enum for the same reason.
 */
function mapBackgroundRenderEngine(engine: BlenderRenderEngine | null): string[] | undefined {
	switch (engine) {
		case "eevee":
			return ["BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"];
		case "cycles":
			return ["CYCLES"];
		case "workbench":
			return ["BLENDER_WORKBENCH"];
		default:
			return undefined;
	}
}

export async function blenderRender(options: RenderOptions): Promise<RenderResult | DeferredJobHandle> {
	if (options.async) {
		return await dispatchDeferredJob(
			"render",
			() => executeRender({ ...options, async: false }),
			{
				workspace: options.workspace,
				view: options.view,
				outputName: options.outputName,
			},
		);
	}
	return await executeRender(options);
}

async function executeRender(options: RenderOptions): Promise<RenderResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const iteration = manifest.latestIteration > 0 ? manifest.latestIteration : 1;
	const { iterationDir, rendersDir } = getIterationPaths(manifest.workspacePath, iteration);
	await mkdir(iterationDir, { recursive: true });
	await mkdir(rendersDir, { recursive: true });

	const outputName = normalizeRenderOutputName(options.outputName);
	const outputPath = join(rendersDir, outputName);
	const logPath = join(iterationDir, "render.log");
	const normalizedConfig = normalizeRenderConfig(options);
	const view = normalizedConfig.viewSource === "current-view" ? "current-view" : (options.view ?? "active-camera");

	if (normalizedConfig.viewSource === "current-view" && options.view) {
		throw new Error('Do not provide view when viewSource is "current-view".');
	}

	let cameraName: string | undefined;
	if (normalizedConfig.viewSource === "camera") {
		const savedView = manifest.savedViews[view];
		if (savedView) {
			cameraName = getSavedViewCameraObjectName(savedView) ?? undefined;
		} else if (view !== "active-camera") {
			cameraName = view;
		}
	}

	let renderPayload: {
		outputPath: string;
		cameraName: string | null;
		resolvedEngine?: string;
		resolution: { x: number; y: number; percentage: number };
	};
	let effectiveRenderMethod: BlenderRenderMethod = normalizedConfig.renderMethod;
	let fellBackToBackground = false;

	if (normalizedConfig.renderMethod === "live") {
		try {
			renderPayload = await requestLiveBlenderRender({
				blendPath: manifest.blendPath,
				cameraName,
				outputPath,
				resolution: options.resolution,
				samples: options.samples,
				viewSource: normalizedConfig.viewSource,
				viewportShading: normalizedConfig.viewportShading ?? "material-preview",
				signal: options.signal,
				timeoutMs: 360_000,
			});
		} catch (error) {
			// A live render is a VIEWPORT render: it needs a window, and a
			// session without one is the normal state rather than a fault. The
			// background engine renders the same camera to the same file, so the
			// still is produced and the only thing lost is that it is not a
			// screenshot of the viewport. Refusing instead would mean no picture
			// at all for a manager whose whole loop is looking at pictures.
			//
			// Only the ABSENCE of a window falls back. Any other failure is the
			// real one and is propagated, because silently re-rendering after a
			// genuine render error would hide the error behind a plausible image.
			if (!(error instanceof NoWatchWindowError)) throw error;
			effectiveRenderMethod = "background";
			fellBackToBackground = true;
			renderPayload = await runBlenderJson({
				cwd: options.cwd,
				blendPath: manifest.blendPath,
				scriptSource: buildRenderScript(),
				payload: {
					cameraName,
					renderEngine: mapBackgroundRenderEngine(normalizedConfig.renderEngine),
					outputPath,
					resolution: options.resolution,
					samples: options.samples,
				},
				signal: options.signal,
				timeoutMs: 360_000,
			});
		}
	} else {
		renderPayload = await runBlenderJson({
			cwd: options.cwd,
			blendPath: manifest.blendPath,
			scriptSource: buildRenderScript(),
			payload: {
				cameraName,
				renderEngine: mapBackgroundRenderEngine(normalizedConfig.renderEngine),
				outputPath,
				resolution: options.resolution,
				samples: options.samples,
			},
			signal: options.signal,
			timeoutMs: 360_000,
		});
	}

	await writeFile(logPath, JSON.stringify(renderPayload, null, 2), "utf-8");

	// Merge into the manifest on disk rather than writing back this snapshot:
	// a module run or execute-python that finished while this render was
	// rendering must not have its iteration/moduleRuns clobbered.
	await updateManifest(manifest.manifestPath, (current) => {
		current.renderOutputs.push({
			path: renderPayload.outputPath,
			view,
			iteration,
			createdAt: new Date().toISOString(),
		});
	});

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		iteration,
		outputPath: renderPayload.outputPath,
		logPath,
		outputName,
		view,
		cameraName: renderPayload.cameraName,
		// What the build actually used, which can differ from the request when
		// the requested identifier is not in this Blender's enum. Reporting the
		// fallback is the difference between "eevee" and "cycles ran instead".
		resolvedEngine: renderPayload.resolvedEngine ?? null,
		resolution: renderPayload.resolution,
		samples: options.samples ?? null,
		renderMethod: effectiveRenderMethod,
		viewSource: fellBackToBackground ? "camera" : normalizedConfig.viewSource,
		viewportShading: fellBackToBackground ? null : normalizedConfig.viewportShading,
		renderEngine: normalizedConfig.renderEngine,
		// A caller that asked for a live render and got a background one must be
		// able to tell from the result alone, without reading the log: the two
		// images differ in exactly the way that matters for judging them.
		fellBackToBackground,
	};
}
