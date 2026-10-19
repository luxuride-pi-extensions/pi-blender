import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderAssetsDir } from "../config.js";
import type { SceneInfoOptions, SceneInfoResult, SceneInfoSelection } from "./types.js";
import { runBlenderJson } from "./utils.js";
import { getIterationPaths, loadWorkspaceManifest } from "./workspace.js";

function resolveSceneInfoSelection(options: SceneInfoOptions): SceneInfoSelection {
	const categories = options.categories;
	if (categories && categories.length > 0) {
		const selected = new Set(categories);
		return {
			includeObjects: selected.has("objects"),
			includeCollections: selected.has("collections"),
			includeMaterials: selected.has("materials"),
			includeCameras: selected.has("cameras"),
			includeCameraSettings: selected.has("cameraSettings"),
			includeLights: selected.has("lights"),
			includeViews: selected.has("views"),
			includeRenderSettings: selected.has("renderSettings"),
			includeUv: selected.has("uv"),
			includeArmatures: selected.has("armatures"),
			includeTextures: selected.has("textures"),
			includePaintSettings: selected.has("paintSettings"),
			includeMissingFiles: selected.has("missingFiles"),
			includeLinkedLibraries: selected.has("linkedLibraries"),
		};
	}

	// Full payload by default; the new paint/UV/rig/health sections stay opt-in to
	// keep the plain default response compact.
	return {
		includeObjects: true,
		includeCollections: true,
		includeMaterials: true,
		includeCameras: true,
		includeCameraSettings: true,
		includeLights: true,
		includeViews: true,
		includeRenderSettings: true,
		includeUv: false,
		includeArmatures: false,
		includeTextures: false,
		includePaintSettings: false,
		includeMissingFiles: false,
		includeLinkedLibraries: false,
	};
}

function buildSceneInfoScript(): string {
	return `
import bpy
import json
import os
import sys

payload = json.loads(sys.argv[sys.argv.index("--") + 1])

_assets_dir = payload.get("assetsDir")
if _assets_dir and _assets_dir not in sys.path:
    sys.path.insert(0, _assets_dir)

try:
    from scene_info import extract_missing_files, extract_linked_libraries
except ImportError:
    extract_missing_files = None
    extract_linked_libraries = None

def maybe_vector(value):
    if value is None:
        return None
    return [float(component) for component in value]

scene = bpy.context.scene

result = {
    "activeCameraName": scene.camera.name if scene.camera else None,
    "objects": [],
    "collections": [],
    "materials": [],
    "cameras": [],
    "cameraSettings": [],
    "lights": [],
    "renderSettings": None,
    "units": None,
    "uv": [],
    "armatures": [],
    "textures": [],
    "paintSettings": None,
    "missingFiles": None,
    "linkedLibraries": None,
}

if payload.get("includeUv", False):
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        layers = []
        for uv in obj.data.uv_layers:
            layers.append({
                "name": uv.name,
                "active": bool(uv.active),
                "sync": bool(getattr(uv, "use_sync", False)),
                "hasData": bool(uv.data),
            })
        if layers:
            result["uv"].append({
                "objectName": obj.name,
                "layers": layers,
                "vertexGroups": [vg.name for vg in obj.vertex_groups],
                "colorAttributes": [
                    {"name": ca.name, "domain": getattr(ca, "domain", None)}
                    for ca in obj.data.color_attributes
                ],
            })

if payload.get("includeArmatures", False):
    for obj in bpy.data.objects:
        if obj.type != "ARMATURE":
            continue
        armature = obj.data
        bones = []
        for bone in armature.bones:
            bones.append({
                "name": bone.name,
                "parentName": bone.parent.name if bone.parent else None,
                "head": [float(v) for v in bone.head_local],
                "tail": [float(v) for v in bone.tail_local],
                "useDeform": bool(bone.use_deform),
            })
        result["armatures"].append({
            "objectName": obj.name,
            "boneCount": len(armature.bones),
            "bones": bones,
        })

if payload.get("includeTextures", False):
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type != "IMAGE":
                continue
            img = node.image
            if img is None:
                continue
            result["textures"].append({
                "materialName": mat.name,
                "nodeName": node.name,
                "imageName": img.name,
                "filePath": img.filepath or None,
                "width": int(img.size[0]) if img.size[0] > 0 else None,
                "height": int(img.size[1]) if img.size[1] > 0 else None,
                "hasData": bool(img.pixels) and int(img.size[0]) > 0 and int(img.size[1]) > 0,
            })

if payload.get("includePaintSettings", False):
    active_obj = bpy.context.view_layer.objects.active
    paint = None
    if active_obj is not None:
        mat = active_obj.active_material if hasattr(active_obj, "active_material") else None
        paint = {
            "objectName": active_obj.name,
            "objectType": active_obj.type,
            "mode": bpy.context.mode if hasattr(bpy.context, "mode") else None,
            "activeMaterial": mat.name if mat else None,
            "imageTextureNodes": [],
        }
        if mat is not None and mat.use_nodes:
            for node in mat.node_tree.nodes:
                if node.type == "IMAGE" and node.image is not None:
                    paint["imageTextureNodes"].append(node.name)
        # vertex color layers on active mesh
        if active_obj.type == "MESH":
            paint["colorAttributes"] = [
                {"name": ca.name, "domain": getattr(ca, "domain", None)}
                for ca in active_obj.data.color_attributes
            ]
    result["paintSettings"] = paint

if payload.get("includeObjects", True):
    for obj in bpy.data.objects:
        result["objects"].append({
            "name": obj.name,
            "type": obj.type,
            "location": maybe_vector(obj.location),
            "rotationEuler": maybe_vector(obj.rotation_euler),
            "scale": maybe_vector(obj.scale),
            "materialSlots": [slot.material.name for slot in obj.material_slots if slot.material],
        })

if payload.get("includeCollections", True):
    for collection in bpy.data.collections:
        result["collections"].append({
            "name": collection.name,
            "objectNames": [obj.name for obj in collection.objects],
        })

if payload.get("includeMaterials", True):
    for material in bpy.data.materials:
        result["materials"].append({
            "name": material.name,
            "useNodes": bool(material.use_nodes),
        })

if payload.get("includeCameras", True):
    for obj in bpy.data.objects:
        if obj.type != "CAMERA":
            continue
        result["cameras"].append({
            "name": obj.name,
            "cameraSettingsName": obj.data.name if obj.data else None,
            "location": maybe_vector(obj.location),
            "rotationEuler": maybe_vector(obj.rotation_euler),
            "scale": maybe_vector(obj.scale),
            "isSceneCamera": bool(scene.camera and scene.camera.name == obj.name),
        })

if payload.get("includeCameraSettings", True):
    for camera in bpy.data.cameras:
        result["cameraSettings"].append({
            "name": camera.name,
            "type": camera.type,
            "lens": float(camera.lens),
            "sensorWidth": float(camera.sensor_width),
            "sensorHeight": float(camera.sensor_height),
            "clipStart": float(camera.clip_start),
            "clipEnd": float(camera.clip_end),
            "orthoScale": float(getattr(camera, "ortho_scale", 0.0)),
        })

if payload.get("includeLights", True):
    for light in bpy.data.lights:
        result["lights"].append({
            "name": light.name,
            "type": light.type,
            "energy": float(light.energy),
        })

if payload.get("includeUnits", True):
    unit_settings = scene.unit_settings
    scale_length = float(unit_settings.scale_length)
    result["units"] = {
        "system": str(unit_settings.system),
        "scaleLength": scale_length,
        "lengthUnit": str(unit_settings.length_unit),
        "massUnit": str(getattr(unit_settings, "mass_unit", "NONE")),
        # What one Blender unit actually measures. With system "NONE" this is
        # still meaningful: it is the scale factor relative to a metre, and
        # system "NONE" just means the user has not declared a unit.
        "oneUnitInMeters": 1.0 / scale_length if scale_length else None,
    }

if payload.get("includeRenderSettings", True):
    result["renderSettings"] = {
        "engine": scene.render.engine,
        "resolutionX": int(scene.render.resolution_x),
        "resolutionY": int(scene.render.resolution_y),
        "resolutionPercentage": int(scene.render.resolution_percentage),
        "samples": int(getattr(scene.cycles, "samples", 0)),
        "camera": scene.camera.name if scene.camera else None,
    }

if payload.get("includeMissingFiles", False):
    blend_path = payload.get("blendPath")
    if extract_missing_files is not None:
        result["missingFiles"] = extract_missing_files(blend_path)
    else:
        result["missingFiles"] = {
            "images": [],
            "libraries": [],
            "fonts": [],
            "sounds": [],
            "movieClips": [],
            "caches": [],
            "sequences": [],
            "totalCount": 0,
        }

if payload.get("includeLinkedLibraries", False):
    blend_path = payload.get("blendPath")
    if extract_linked_libraries is not None:
        result["linkedLibraries"] = extract_linked_libraries(blend_path)
    else:
        result["linkedLibraries"] = {
            "tree": [],
            "list": [],
            "totalCount": 0,
            "hasIndirect": False,
        }

print("__PI_BLENDER_JSON_START__")
print(json.dumps(result))
print("__PI_BLENDER_JSON_END__")
`;
}

/**
 * Run the background scene-info read for an already-resolved selection.
 *
 * Split out so a caller that needs the selection itself (blenderSceneInfo uses
 * it to trim the response payload) resolves it once and reuses it, instead of
 * each layer resolving the same options independently.
 */
async function getSceneInfoForSelection(
	cwd: string,
	manifest: {
		workspacePath: string;
		blendPath: string;
	},
	selection: SceneInfoSelection,
	signal: SceneInfoOptions["signal"],
): Promise<SceneInfoResult> {
	return await runBlenderJson<SceneInfoResult>({
		cwd,
		blendPath: manifest.blendPath,
		scriptSource: buildSceneInfoScript(),
		payload: {
			assetsDir: getBlenderAssetsDir(),
			blendPath: manifest.blendPath,
			includeObjects: selection.includeObjects,
			includeCollections: selection.includeCollections,
			includeMaterials: selection.includeMaterials,
			includeCameras: selection.includeCameras,
			includeCameraSettings: selection.includeCameraSettings,
			includeLights: selection.includeLights,
			includeRenderSettings: selection.includeRenderSettings,
			includeUnits: true,
			includeUv: selection.includeUv,
			includeArmatures: selection.includeArmatures,
			includeTextures: selection.includeTextures,
			includePaintSettings: selection.includePaintSettings,
			includeMissingFiles: selection.includeMissingFiles,
			includeLinkedLibraries: selection.includeLinkedLibraries,
		},
		signal,
		timeoutMs: 60_000,
	});
}

export async function getSceneInfoFromManifest(
	cwd: string,
	manifest: {
		workspacePath: string;
		blendPath: string;
	},
	options: Omit<SceneInfoOptions, "cwd" | "workspace">,
): Promise<SceneInfoResult> {
	const selection = resolveSceneInfoSelection({
		cwd,
		workspace: manifest.workspacePath,
		...options,
	});

	return await getSceneInfoForSelection(cwd, manifest, selection, options.signal);
}

export async function blenderSceneInfo(options: SceneInfoOptions): Promise<SceneInfoResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const iteration = manifest.latestIteration > 0 ? manifest.latestIteration : 1;
	const { iterationDir } = getIterationPaths(manifest.workspacePath, iteration);
	await mkdir(iterationDir, { recursive: true });
	// Resolve the selection once and drive both the background read and the
	// response payload from it; resolving it in getSceneInfoFromManifest as well
	// was a second, redundant derivation of the same options.
	const selection = resolveSceneInfoSelection(options);
	const result = await getSceneInfoForSelection(options.cwd, manifest, selection, options.signal);
	const sceneInfoResult: SceneInfoResult = {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		iteration,
		sceneInfoPath: join(iterationDir, "scene-info.json"),
		activeCameraName: result.activeCameraName,
		objects: result.objects,
		collections: result.collections,
		materials: result.materials,
		cameras: result.cameras,
		cameraSettings: result.cameraSettings,
		lights: result.lights,
		views: selection.includeViews ? Object.values(manifest.savedViews) : [],
		renderSettings: result.renderSettings,
		units: result.units,
		uv: selection.includeUv ? result.uv : [],
		armatures: selection.includeArmatures ? result.armatures : [],
		textures: selection.includeTextures ? result.textures : [],
		paintSettings: selection.includePaintSettings ? result.paintSettings : null,
		missingFiles: selection.includeMissingFiles ? result.missingFiles ?? null : null,
		linkedLibraries: selection.includeLinkedLibraries ? result.linkedLibraries ?? null : null,
	};
	await writeFile(sceneInfoResult.sceneInfoPath, JSON.stringify(sceneInfoResult, null, 2), "utf-8");
	return sceneInfoResult;
}
