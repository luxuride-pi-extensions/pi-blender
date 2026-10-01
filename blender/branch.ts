/**
 * Per-module branch blends: run a module headlessly against its own copy of
 * model.blend, then apply the result back under a serialized lock.
 *
 * WHY THIS EXISTS. Every module run used to execute inside the one live Blender
 * session behind a cross-process lock. That made concurrent module runs
 * impossible, which is why `blender-script-runner` had to exist purely to hold
 * the line, and why the manager prompt argued for a hard fan-out cap: the
 * concurrency ceiling was structural, not budgetary.
 *
 * The binding constraint is not "one scene is mutable" but "one FILE is
 * mutable". A headless Blender opens its own process and its own copy of the
 * blend, so N modules CAN run at once — the merge is the only part that must be
 * serialized. That is what this file splits: authoring and execution move off
 * the bridge, and only the apply touches model.blend.
 *
 * THE RULE THAT MATTERS: an apply never auto-merges. Two modules that touched
 * the same object are a genuine authoring conflict — one of them is wrong about
 * what it owns, or the briefs disagreed — and resolving that by picking a
 * winner silently is how a half-built asset gets presented as finished. A
 * conflicted apply is REPORTED AND SKIPPED, naming both modules and the object,
 * and model.blend is left holding whichever branch was applied first.
 */

import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isLiveBridgeAlive } from "../launch.js";
import { requestLiveBlenderReloadBlend } from "./bridge.js";
import type {
	BlenderBranchRunRecord,
	BlenderModuleRunRecord,
	BlenderWorkspaceManifest,
	BranchApplyOptions,
	BranchApplyResult,
	BranchCameraFraming,
	BranchConflict,
	BranchRunOptions,
	BranchRunResult,
} from "./types.js";
import {
	buildModuleScriptPreamble,
	getModuleDir,
	getModuleRunCheckpointName,
	getModuleScriptPath,
	getRunDir,
	MODULE_PREAMBLE_MARKER,
	normalizeModuleName,
	RENDER_FILE,
} from "./module-paths.js";
import { fileExists, delay, formatBlenderFailure, getSavedViewCameraObjectName, nowIso, runBlenderJson } from "./utils.js";
import { loadWorkspaceManifest, releaseReservedIteration, updateManifest } from "./workspace.js";

const BRANCH_FILE = "branch.blend";

/**
 * Default branch-render resolution.
 *
 * Same reasoning and the same 1200x900 as the live module render (module.ts
 * DEFAULT_MODULE_RENDER_RESOLUTION): these renders are the critic's image
 * budget, and a fresh blend carries Blender's 1920x1080 otherwise.
 */
const DEFAULT_BRANCH_RENDER_RESOLUTION = { x: 1200, y: 900 } as const;

/** The module's branch blend: its private copy of model.blend. */
export function getBranchBlendPath(workspacePath: string, moduleName: string): string {
	return join(getModuleDir(workspacePath, moduleName), BRANCH_FILE);
}

/* ------------------------------------------------------------------ *
 * The headless run
 * ------------------------------------------------------------------ */

/**
 * Execute a module in its own headless Blender, against its own branch blend,
 * and report exactly what it changed.
 *
 * The before/after snapshot is taken inside Blender rather than in TypeScript
 * because only Blender can say what a mesh, transform, modifier stack or
 * material actually is. A run that reported only "the script succeeded" would
 * leave the apply with no way to know WHICH datablocks to bring back, and
 * importing the whole branch would silently revert every sibling module's work.
 *
 * Materials are snapshotted alongside objects, not just hashed into them,
 * because a paint module can change a material with no object moving at all.
 * Object-only tracking would report that module as having touched nothing, and
 * its work would be silently dropped at apply time.
 *
 * The globals dict mirrors blender/live-bridge.py handle_execute_python, so a
 * module script that works on the live session works unchanged here.
 */
function buildBranchRunScript(): string {
	return `
import bpy
import contextlib
import hashlib
import io
import json
import math
import os
import sys
import traceback
from mathutils import Vector

payload = json.loads(sys.argv[sys.argv.index("--") + 1])
branch_path = payload["branchPath"]
workspace_path = payload["workspacePath"]
iteration_path = payload["iterationPath"]
script_path = payload["scriptPath"]
module_name = payload["moduleName"]


def _fingerprint_object(obj):
    """A content hash of one object.

    Content, not identity: the NAME is excluded, because a rename shows up as
    a remove plus an add and would otherwise double-count as a modification of
    two objects.
    """
    parts = [obj.type]
    parts.append(obj.parent.name if obj.parent is not None else "")
    parts.append("|".join("%.6f" % value for row in obj.matrix_world for value in row))
    parts.append(",".join(mod.type for mod in obj.modifiers))
    parts.append(str(len(obj.constraints)))
    parts.append(";".join("%.6f" % value for group in obj.vertex_groups for value in (group.index,)))

    data = getattr(obj, "data", None)
    if data is not None and hasattr(data, "vertices"):
        try:
            parts.append("verts=%d" % len(data.vertices))
            parts.append("polys=%d" % len(data.polygons))
            digest = hashlib.md5()
            for vert in data.vertices:
                digest.update(("%.6f,%.6f,%.6f\\n" % (vert.co.x, vert.co.y, vert.co.z)).encode())
            for poly in data.polygons:
                digest.update(("%d/%d\\n" % (poly.loop_start, poly.loop_total)).encode())
            parts.append("mesh=" + digest.hexdigest())
        except (AttributeError, TypeError, RuntimeError):
            pass

    # Material NAMES, not material content: the material itself is a tracked
    # datablock in its own right, and hashing it here as well would make every
    # object that merely references it look touched by a paint module.
    parts.append("slots=" + "|".join(slot.material.name if slot.material else "" for slot in obj.material_slots))
    return hashlib.md5("\\x00".join(parts).encode()).hexdigest()


def _fingerprint_material(material):
    """A content hash of one material's node tree, or its flat settings."""
    if getattr(material, "node_tree", None) is None:
        return hashlib.md5(
            ("%s|%s|%.6f" % (material.name, material.diffuse_color[0], material.diffuse_color[3])).encode()
        ).hexdigest()
    digest = hashlib.md5()
    for node in sorted(material.node_tree.nodes, key=lambda n: n.name):
        digest.update((node.name + "|" + node.type).encode())
        for socket in node.inputs:
            try:
                value = socket.default_value
            except (AttributeError, TypeError):
                continue
            if hasattr(value, "__len__"):
                digest.update(",".join("%.6f" % float(component) for component in value).encode())
            else:
                digest.update(str(value).encode())
    return digest.hexdigest()


def snapshot():
    # The depsgraph update is what makes the fingerprints below truthful. A script
    # that sets obj.location has changed matrix_world only lazily, so reading it
    # without this returns the PREVIOUS transform -- and a moved object then
    # fingerprints identical to a stationary one, which reports as a module that
    # touched nothing and silently drops its work at apply time. This used to be
    # masked by the save that ran before the snapshot; framing moved the save
    # after it, and the masking went with it.
    bpy.context.view_layer.update()
    return {
        "objects": {obj.name: _fingerprint_object(obj) for obj in bpy.data.objects},
        "materials": {mat.name: _fingerprint_material(mat) for mat in bpy.data.materials},
    }


before = snapshot()
before_objects = set(before["objects"])
before_materials = set(before["materials"])

globals_dict = {
    "__name__": "__main__",
    "OUTPUT_BLEND_PATH": branch_path,
    "BLEND_PATH": branch_path,
    "WORKSPACE_PATH": workspace_path,
    "ITERATION_PATH": iteration_path,
    "MODULE_NAME": module_name,
}
stdout_buffer = io.StringIO()
stderr_buffer = io.StringIO()
exit_code = 0
previous_cwd = os.getcwd()
os.chdir(workspace_path)

with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
    try:
        with open(script_path, encoding="utf-8") as handle:
            code = handle.read()
        exec(compile(code, script_path, "exec"), globals_dict)
    except Exception:
        exit_code = 1
        traceback.print_exc()
    finally:
        os.chdir(previous_cwd)

after = snapshot()
after_objects = set(after["objects"])
after_materials = set(after["materials"])

touched_objects = sorted(
    name for name in (before_objects | after_objects) if before["objects"].get(name) != after["objects"].get(name)
)
touched_materials = sorted(
    name for name in (before_materials | after_materials) if before["materials"].get(name) != after["materials"].get(name)
)

# The APPLY set is wider than the touched set, because a datablock that travels
# alone is invalid: a parented object without its parent is not a usable object,
# and a parent without its children strands them. The widening happens HERE and
# is reported in the record, rather than being discovered at apply time — a
# widened apply set is exactly what turns into a conflict against a sibling.
# Objects the module DELETED. These are removals on apply, never appends, and
# the distinction matters: a deleted object is also "touched" in the sense that
# its fingerprint disappeared, so classifying it by touch alone would put it in
# the apply set and the apply would then fail looking for it in a branch that
# correctly no longer contains it.
deleted = before_objects - after_objects

apply_objects = (set(touched_objects) - deleted)
for name in list(apply_objects):
    obj = bpy.data.objects.get(name)
    if obj is None:
        continue
    ancestor = obj.parent
    while ancestor is not None:
        apply_objects.add(ancestor.name)
        ancestor = ancestor.parent
    for descendant in obj.children_recursive:
        apply_objects.add(descendant.name)

# A deleted object that was only a relative of something touched is NOT counted
# as deleted by this module: it never asked for its removal, and dropping a
# sibling because a parent moved would be the module's apply destroying another
# module's work. Only objects the module itself removed are applied as removals.
removed_objects = sorted(deleted - (apply_objects & set(after_objects)))

# ---- auto-framing -----------------------------------------------------------
# The module's camera is framed HERE, from the bounds of the objects this run
# actually produced, rather than by the worker. Two reasons, both about timing:
# the render is taken on this branch, so a camera the worker placed on the
# previous iteration is the picture THIS iteration gets judged on; and framing is
# arithmetic over measured numbers, so a worker doing it produced a good picture
# once and a stale one the moment its part changed, with a report that could not
# tell a fitted camera from one fitted to an older shape.
#
# The subject is this module's OWN applied objects, never the whole scene: a
# camera framed on the build is the same defect as one framed on the origin.
CAMERA_SUFFIX = "Cam"
FRAME_LENS_MM = 50.0
FRAME_SENSOR_MM = 36.0
FRAME_MARGIN = 1.35
FRAME_DIRECTION = (1.0, -1.0, 0.55)


def _mesh_world_bounds(names):
    """World-space AABB over the named MESH objects, or None if there are none.

    The depsgraph update is load-bearing: matrix_world is stale until something
    asks for it, so reading it right after a script set a scale gives the
    UNTRANSFORMED bounds -- a 6x0.2x0.2 arm framing as if it were a unit cube,
    which is a camera cropped to nothing. Verified against real Blender rather
    than assumed: the same object measures [1,1,1] before the update and
    [6, 0.2, 0.2] after it.
    """
    bpy.context.view_layer.update()
    corners = []
    for name in names:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            corners.append(obj.matrix_world @ Vector(corner))
    if not corners:
        return None
    return (
        Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners))),
        Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners))),
    )


def frame_module_camera(module):
    """Point <module>Cam at this module's own extent. Returns a report, or None."""
    camera_name = module + CAMERA_SUFFIX
    subjects = sorted(
        name for name in apply_objects
        if not name.endswith(CAMERA_SUFFIX)
        and bpy.data.objects.get(name) is not None
        and bpy.data.objects[name].type == "MESH"
    )
    bounds = _mesh_world_bounds(subjects)
    if bounds is None:
        return None

    bounds_min, bounds_max = bounds
    center = (bounds_min + bounds_max) * 0.5
    extent = bounds_max - bounds_min
    radius = max(extent.length * 0.5, 1e-4)

    # E ~ 2*d*(s/2)/f inverted for distance, plus margin for headroom. The
    # bounding SPHERE rather than the widest axis is what keeps a long thin part
    # (a rotor arm) from being cropped by a camera sized to its length.
    half_angle = math.atan((FRAME_SENSOR_MM * 0.5) / FRAME_LENS_MM)
    distance = radius / math.sin(half_angle) * FRAME_MARGIN
    location = center + Vector(FRAME_DIRECTION).normalized() * distance

    camera = bpy.data.objects.get(camera_name)
    created = camera is None
    if created:
        camera = bpy.data.objects.new(camera_name, bpy.data.cameras.new(camera_name))
        bpy.context.scene.collection.objects.link(camera)
    camera.data.lens = FRAME_LENS_MM
    camera.location = location

    # A Track To constraint on an empty rather than a baked rotation: re-framing
    # is then a location change, and the aim cannot drift out of sync with it.
    target_name = camera_name + "Target"
    target = bpy.data.objects.get(target_name)
    if target is None:
        target = bpy.data.objects.new(target_name, None)
        bpy.context.scene.collection.objects.link(target)
    target.empty_display_size = max(radius * 0.15, 1e-3)
    target.location = center
    for constraint in list(camera.constraints):
        camera.constraints.remove(constraint)
    track = camera.constraints.new("TRACK_TO")
    track.target = target
    track.track_axis = "TRACK_NEGATIVE_Z"
    track.up_axis = "UP_Y"

    # Both datablocks must join the apply set, or they stay on this branch and
    # model.blend keeps the previous framing for ever.
    apply_objects.add(camera_name)
    apply_objects.add(target_name)
    removed_objects[:] = [n for n in removed_objects if n not in apply_objects]

    return {
        "module": module,
        "cameraName": camera_name,
        "created": created,
        "center": [center.x, center.y, center.z],
        "extent": [extent.x, extent.y, extent.z],
        "distance": distance,
        "lensMm": FRAME_LENS_MM,
        "subjects": subjects,
    }


camera_framing = frame_module_camera(module_name)
cameras = [camera_framing] if camera_framing is not None else []

# The save happens HERE, after the framing and after the apply set is settled --
# not inside the try above. Saving earlier wrote a branch file without the camera,
# so the render could not find it, and the apply reported the camera as missing
# from its own branch: the framing existed in memory and nowhere else.
if exit_code == 0:
    bpy.ops.wm.save_mainfile()

# Framing deliberately does NOT happen again in the apply. This run's render was
# taken on this branch, so the framing that reaches model.blend is the framing of
# the geometry the critic judged; re-solving it against the merged scene would
# silently disagree with that picture.

print("__PI_BLENDER_JSON_START__")
print(json.dumps({
    "stdout": stdout_buffer.getvalue(),
    "stderr": stderr_buffer.getvalue(),
    "exitCode": exit_code,
    "touchedObjects": touched_objects,
    "touchedMaterials": touched_materials,
    "addedObjects": sorted(after_objects - before_objects),
    "removedObjects": removed_objects,
    "applyObjects": sorted(apply_objects),
    "cameras": cameras,
}))
print("__PI_BLENDER_JSON_END__")
`;
}

interface BranchRunPayload {
	stdout: string;
	stderr: string;
	exitCode: number;
	touchedObjects: string[];
	touchedMaterials: string[];
	addedObjects: string[];
	removedObjects: string[];
	applyObjects: string[];
	/** Framing solved for this module's camera; empty when it produced no mesh. */
	cameras: BranchCameraFraming[];
}

/**
 * Run a module headlessly against its own copy of model.blend.
 *
 * No bridge lock is taken and no live Blender is required: this is the whole
 * point of the branch, and it is what lets several modules run at once. The
 * headless run budget (blender/concurrency.ts) is the only limit on how many
 * execute simultaneously, and it is enforced inside runBlenderProcess.
 */
export async function blenderBranchRun(options: BranchRunOptions): Promise<BranchRunResult> {
	const moduleName = normalizeModuleName(options.moduleName);
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const scriptPath = getModuleScriptPath(manifest.workspacePath, moduleName);
	if (!(await fileExists(scriptPath))) {
		throw new Error(
			`Module script not found: ${scriptPath}. Write the module's bpy script there first (worker agent), then run it.`,
		);
	}

	const moduleDir = getModuleDir(manifest.workspacePath, moduleName);
	await mkdir(moduleDir, { recursive: true });

	// The iteration is claimed for the same reason as in blenderModuleRun: two
	// overlapping runs must not land on the same runs/NN directory, and the
	// claimed number is the unique sequence that revert ordering depends on.
	const { iteration, sequence } = await updateManifest(
		manifest.manifestPath,
		(current) => {
			const claimed = current.latestIteration + 1;
			current.latestIteration = claimed;
			return { iteration: claimed, sequence: claimed };
		},
		{ signal: options.signal },
	);

	const runDir = getRunDir(manifest.workspacePath, moduleName, iteration);
	await mkdir(runDir, { recursive: true });

	// The branch is a copy taken NOW, not at the last apply. A module authored
	// against the state it was briefed on is correct against that state even if
	// a sibling has been applied since, which is what makes concurrent branches
	// meaningful rather than a race.
	const branchPath = getBranchBlendPath(manifest.workspacePath, moduleName);
	await copyFile(manifest.blendPath, branchPath);

	const rawScript = await readFile(scriptPath, "utf-8");
	let effectiveScriptPath = scriptPath;
	if (!rawScript.includes(MODULE_PREAMBLE_MARKER)) {
		effectiveScriptPath = join(runDir, "script.py");
		await writeFile(
			effectiveScriptPath,
			buildModuleScriptPreamble(manifest.workspacePath, branchPath, moduleName) + rawScript,
			"utf-8",
		);
	}

	let payload: BranchRunPayload;
	try {
		payload = await runBlenderJson<BranchRunPayload>({
			cwd: options.cwd,
			blendPath: branchPath,
			label: `branch run ${moduleName}`,
			scriptSource: buildBranchRunScript(),
			payload: {
				branchPath,
				workspacePath: manifest.workspacePath,
				iterationPath: runDir,
				scriptPath: effectiveScriptPath,
				moduleName,
			},
			signal: options.signal,
			timeoutMs: (options.timeoutSeconds ?? 300) * 1000,
		});
	} catch (error) {
		// A headless launch that never produced JSON leaves the branch in an
		// unknown state, so it is removed rather than left for an apply to find.
		await rm(branchPath, { force: true }).catch(() => undefined);
		await releaseReservedIteration(manifest.manifestPath, iteration).catch(() => undefined);
		throw error;
	}

	if (payload.exitCode !== 0) {
		await rm(branchPath, { force: true }).catch(() => undefined);
		await releaseReservedIteration(manifest.manifestPath, iteration).catch(() => undefined);
		throw new Error(
			formatBlenderFailure({
				streams: { stdout: payload.stdout, stderr: payload.stderr },
				subject:
					`Module "${moduleName}" branch run failed (exit ${payload.exitCode}). model.blend was NOT touched — this ran ` +
					`headlessly against ${branchPath}, which has been removed. Nothing to revert.\n` +
					`Script that ran: ${effectiveScriptPath}\nSource: ${scriptPath}`,
			}),
		);
	}

	let renderOutputPath: string | null = null;
	let viewLabel = options.view ?? "active-camera";
	if (options.render !== false) {
		let cameraName: string | undefined;
		const savedView = options.view ? manifest.savedViews[options.view] : undefined;
		if (savedView) {
			cameraName = getSavedViewCameraObjectName(savedView) ?? undefined;
		} else if (options.view && options.view !== "active-camera") {
			// Accept either a named camera object or a saved view; "active-camera"
			// keeps the branch's own camera, same as the live module render.
			cameraName = options.view;
		} else {
			// No explicit view: render from THIS MODULE'S OWN auto-framed camera.
			// Falling through to scene.camera would render from the studio camera,
			// which is aimed at the world origin and points at nothing once a build
			// has parts — the exact defect the framing exists to remove. Falls back
			// to the scene camera only when the run produced no mesh to frame.
			cameraName = payload.cameras[0]?.cameraName;
			viewLabel = cameraName ?? "active-camera";
		}
		renderOutputPath = await renderBranch({
			cwd: options.cwd,
			workspacePath: manifest.workspacePath,
			branchPath,
			moduleName,
			outputPath: join(moduleDir, RENDER_FILE),
			cameraName,
			resolution: options.resolution ?? DEFAULT_BRANCH_RENDER_RESOLUTION,
			samples: options.samples,
			signal: options.signal,
		});
	}

	// The checkpoint is model.blend as it is NOW, which is the state the apply
	// will replace — so it is taken before the apply, at run time, and is the
	// point blender_module_revert restores.
	const checkpointPath = join(runDir, getModuleRunCheckpointName(iteration));
	await copyFile(manifest.blendPath, checkpointPath);

	const record: BlenderBranchRunRecord = {
		module: moduleName,
		iteration,
		sequence,
		branchPath,
		scriptPath,
		checkpointPath,
		at: nowIso(),
		touchedObjects: payload.touchedObjects,
		touchedMaterials: payload.touchedMaterials,
		addedObjects: payload.addedObjects,
		removedObjects: payload.removedObjects,
		applyObjects: payload.applyObjects,
		status: "staged",
		renderOutputPath,
		cameras: payload.cameras,
	};

	await updateManifest(
		manifest.manifestPath,
		(current) => {
			current.branchRuns = [...(current.branchRuns ?? []), record];
			if (renderOutputPath) {
				current.renderOutputs.push({
					path: renderOutputPath,
					view: viewLabel,
					iteration,
					createdAt: nowIso(),
					module: moduleName,
				});
			}
		},
		{ signal: options.signal },
	);

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		module: moduleName,
		moduleDir,
		scriptPath,
		branchPath,
		iteration,
		runDir,
		checkpointPath,
		exitCode: payload.exitCode,
		stdout: payload.stdout.trim(),
		stderr: payload.stderr.trim(),
		touchedObjects: payload.touchedObjects,
		touchedMaterials: payload.touchedMaterials,
		addedObjects: payload.addedObjects,
		removedObjects: payload.removedObjects,
		applyObjects: payload.applyObjects,
		renderOutputPath,
		cameras: payload.cameras,
		status: "staged",
	};
}

/**
 * Render a branch blend with a headless Blender.
 *
 * Deliberately the same engine the live render uses (blender/render.ts
 * buildRenderScript), including the enum-probing fallback, so a branch render and
 * a live render of the same scene agree: a critic comparing two images is
 * looking at the geometry, not at two different renderers.
 */
async function renderBranch(options: {
	cwd: string;
	workspacePath: string;
	branchPath: string;
	/** Named on the run lease, so an open run says which module it renders. */
	moduleName?: string;
	outputPath: string;
	cameraName: string | undefined;
	resolution: { x: number; y: number; percentage?: number };
	samples?: number;
	signal?: AbortSignal;
}): Promise<string> {
	const script = `
import bpy
import json
import os
import sys

payload = json.loads(sys.argv[sys.argv.index("--") + 1])
scene = bpy.context.scene

camera_name = payload.get("cameraName")
if camera_name:
    camera_object = bpy.data.objects.get(camera_name)
    if camera_object is None:
        raise RuntimeError("Camera not found: %s" % camera_name)
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
print(json.dumps({"outputPath": output_path, "cameraName": scene.camera.name if scene.camera else None}))
print("__PI_BLENDER_JSON_END__")
`;

	return await runBlenderJson<{ outputPath: string }>({
		cwd: options.cwd,
		blendPath: options.branchPath,
		label: `branch render ${options.moduleName ?? ""}`.trim(),
		scriptSource: script,
		payload: {
			cameraName: options.cameraName,
			outputPath: options.outputPath,
			resolution: options.resolution,
			samples: options.samples,
		},
		signal: options.signal,
		timeoutMs: 360_000,
	}).then((result) => result.outputPath);
}

/* ------------------------------------------------------------------ *
 * Conflicts
 * ------------------------------------------------------------------ */

/**
 * Every object or material contested by two or more of these branches.
 *
 * The rule is deliberately symmetric and deliberately dumb: two STAGED branches
 * touching the same datablock conflict, full stop. It does not try to decide
 * which one is "more recent" or "more correct" — that judgement is exactly what
 * the no-auto-merge rule exists to prevent, and the loser cannot be identified
 * from the data anyway.
 *
 * A datablock listed twice by ONE module is not a conflict: a parent and its
 * own child both claiming the parent is one module being internally consistent.
 *
 * Pure and exported, so the rule is testable without a Blender to run. Same
 * reason applySuccessfulRun is a standalone function in module.ts.
 */
export function computeBranchConflicts(pending: BlenderBranchRunRecord[]): Map<string, string[]> {
	const byDatablock = new Map<string, string[]>();
	for (const record of pending) {
		for (const name of recordOwnedDatablocks(record)) {
			const owners = byDatablock.get(name) ?? [];
			if (!owners.includes(record.module)) {
				owners.push(record.module);
			}
			byDatablock.set(name, owners);
		}
	}
	const conflicts = new Map<string, string[]>();
	for (const [name, modules] of byDatablock) {
		if (modules.length > 1) {
			conflicts.set(name, modules);
		}
	}
	return conflicts;
}

/** Every datablock name a branch run would bring into or remove from model.blend. */
export function recordOwnedDatablocks(record: BlenderBranchRunRecord): string[] {
	return [
		...new Set([...record.applyObjects, ...record.touchedMaterials, ...record.removedObjects]),
	];
}

/**
 * The datablocks this one record would touch that another staged branch also
 * touches — i.e. why this record cannot be applied.
 *
 * The `modules` list names THIS record's module FIRST, then the others in the
 * order they were staged, so a report reads as "you are blocked by these" rather
 * than leaving the reader to work out which of the listed names is the module
 * they just asked to apply.
 */
export function findRecordConflicts(
	record: BlenderBranchRunRecord,
	others: BlenderBranchRunRecord[],
): BranchConflict[] {
	const all = computeBranchConflicts([...others, record]);
	const mine = new Set(recordOwnedDatablocks(record));
	return [...all.entries()]
		.filter(([name]) => mine.has(name))
		.map(([objectName, modules]) => ({
			objectName,
			modules: [
				record.module,
				...modules.filter((module) => module !== record.module),
			],
		}));
}

/* ------------------------------------------------------------------ *
 * The apply
 * ------------------------------------------------------------------ */

/**
 * Copy a branch's datablocks back into model.blend.
 *
 * Objects come across by name from the branch file, AFTER the same-named objects
 * already in model.blend have been removed. Remove-then-append is required
 * rather than an in-place update: Blender has no supported way to replace an
 * object's datablocks from another file, and append alone would leave both
 * copies present with the branch one renamed to `.001` — so a second apply of
 * the same branch would silently duplicate rather than update.
 *
 * Materials are appended alongside the objects, because an appended object
 * brings its material references with it and a name collision would otherwise
 * leave it pointing at model.blend's older copy — the classic silent-no-op where
 * a paint module applies cleanly and changes nothing.
 *
 * Membership is tested by BUILDING AN INDEX over the library's name list and
 * looking names up in that, not by subscripting `data_from.objects` directly.
 * Those are plain lists in Blender 5.2, so a direct subscript raises
 * "TypeError: list indices must be integers" — and because `--python` swallows
 * a top-level exception and still exits 0, that surfaced to the caller as a bare
 * "failed to parse JSON output" with the traceback discarded.
 *
 * Every appended object is explicitly LINKED into the scene collection. This is
 * not decoration: `libraries.load` brings an object into `bpy.data.objects` but
 * does not put it in any collection, and Blender only writes datablocks that
 * have users, so an unlinked append is silently dropped by the very next
 * `save_mainfile` — the apply reports success, the file reopens empty, and
 * nothing anywhere says why. The link is what makes the append survive.
 */
function buildBranchApplyScript(): string {
	return `
import bpy
import json
import sys

payload = json.loads(sys.argv[sys.argv.index("--") + 1])
branch_path = payload["branchPath"]
apply_objects = payload["applyObjects"]
apply_materials = payload["applyMaterials"]
remove_objects = payload["removeObjects"]

# Materials first: an object removed below may be the last user of a material
# we are about to replace, and a material with users cannot be overwritten.
for name in apply_materials:
    existing = bpy.data.materials.get(name)
    if existing is not None and existing.users == 0:
        bpy.data.materials.remove(existing)

replaced = []
removed_existing = []
for name in list(apply_objects) + list(remove_objects):
    obj = bpy.data.objects.get(name)
    if obj is None:
        continue
    if name in apply_objects:
        replaced.append(name)
    else:
        removed_existing.append(name)
    bpy.data.objects.remove(obj, do_unlink=True)

missing = []
appended_objects = []
with bpy.data.libraries.load(branch_path, link=False) as (data_from, data_to):
    object_index = {name: index for index, name in enumerate(data_from.objects)}
    present_objects = [n for n in apply_objects if n in object_index]
    missing.extend(n for n in apply_objects if n not in object_index)
    data_to.objects = [data_from.objects[object_index[n]] for n in present_objects]

    material_index = {name: index for index, name in enumerate(data_from.materials)}
    present_materials = [m for m in apply_materials if m in material_index]
    missing.extend(m for m in apply_materials if m not in material_index)
    data_to.materials = [data_from.materials[material_index[m]] for m in present_materials]

# Link every appended object into the scene. Without this the append is undone
# by the save below, silently -- see the note on libraries.load in the header.
scene_collection = bpy.context.scene.collection
for name in apply_objects:
    obj = bpy.data.objects.get(name)
    if obj is not None and len(obj.users_collection) == 0:
        scene_collection.objects.link(obj)

appended_objects = sorted(obj.name for obj in bpy.data.objects if obj.name in set(apply_objects))
appended_materials = sorted(m.name for m in bpy.data.materials if m.name in set(apply_materials))

# A datablock the branch said it had but which is not in the branch file means
# the two disagree, so the apply is reported as incomplete rather than saved: a
# partial merge leaves model.blend describing neither generation.
if missing:
    print("__PI_BLENDER_JSON_START__")
    print(json.dumps({
        "replaced": replaced,
        "removedExisting": removed_existing,
        "appended": [],
        "appendedMaterials": [],
        "missing": missing,
    }))
    print("__PI_BLENDER_JSON_END__")
    raise SystemExit(0)

bpy.ops.wm.save_mainfile()

print("__PI_BLENDER_JSON_START__")
print(json.dumps({
    "replaced": replaced,
    "removedExisting": removed_existing,
    "appended": appended_objects,
    "appendedMaterials": appended_materials,
    "missing": missing,
}))
print("__PI_BLENDER_JSON_END__")
`;
}

interface BranchApplyPayload {
	replaced: string[];
	removedExisting: string[];
	appended: string[];
	appendedMaterials: string[];
	missing: string[];
}

const APPLY_LOCK_FILE = ".branch-apply.lock";
/**
 * Generous enough to outlive a slow apply, because a holder that is reclaimed
 * early would let a second apply write model.blend while the first still has it
 * open — and reclaiming late only costs a stuck workspace the operator can clear.
 */
const APPLY_LOCK_STALE_MS = 15 * 60_000;
const APPLY_LOCK_POLL_MS = 50;

/**
 * Hold the apply lock for the WHOLE apply, including the headless Blender run.
 *
 * Unlike the manifest lock this is deliberately held across work, because the
 * resource it protects is model.blend itself: two applies at once would each
 * open the same file, each append, and each save, and the second save wins with
 * the first apply's objects missing.
 *
 * The signal is accepted and not passed to `delay`. An apply already holding the
 * lock is holding it because it is mid-merge; abandoning the merge half way
 * because the caller went away is the one outcome worse than waiting, and the
 * lock's stale window already handles the case where a holder dies outright.
 */
async function acquireApplyLock(manifestPath: string, _options?: { signal?: AbortSignal }): Promise<() => Promise<void>> {
	const lockPath = join(dirname(manifestPath), APPLY_LOCK_FILE);
	const deadline = Date.now() + APPLY_LOCK_STALE_MS;
	while (true) {
		try {
			const handle = await open(lockPath, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: nowIso() }), "utf-8");
			await handle.close();
			return async () => {
				await rm(lockPath, { force: true }).catch(() => undefined);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			try {
				const stats = await stat(lockPath);
				if (Date.now() - stats.mtimeMs > APPLY_LOCK_STALE_MS) {
					await rm(lockPath, { force: true });
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for the branch apply lock (${lockPath}). Another apply is holding model.blend, or a holder died mid-apply. If no Blender work is running, delete that file and retry.`,
				);
			}
			await delay(APPLY_LOCK_POLL_MS);
		}
	}
}

/**
 * Apply staged branches into model.blend, reporting and skipping any that
 * conflict with another staged branch.
 *
 * A conflicted module is NOT applied and NOT merged: its changes stay in its
 * branch blend, so nothing is lost and the operator can decide which side was
 * wrong. `skipped` names every conflicted module and the datablock that stopped
 * it, because "one module did not apply" with no reason is indistinguishable
 * from a bug.
 */
export async function blenderBranchApply(options: BranchApplyOptions): Promise<BranchApplyResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const branchRuns = manifest.branchRuns ?? [];

	const staged = options.modules
		.map((raw) => {
			const name = normalizeModuleName(raw);
			const record = [...branchRuns].reverse().find((run) => run.module === name && run.status === "staged");
			if (!record) {
				throw new Error(
					`No staged branch run for module "${name}". A module is applyable only after a branch run has staged it. Re-run the module to stage a fresh branch.`,
				);
			}
			return record;
		})
		.sort((a, b) => a.sequence - b.sequence);

	// The conflict set spans EVERY staged branch, including the other modules in
	// THIS call. Excluding the ones named here is the mistake that made two
	// contested modules apply cleanly when they were passed together, while the
	// very same pair was correctly refused when applied one call at a time -- the
	// rule would have depended on how the caller happened to batch the apply.
	// A caller that wants a contested pair applied must resolve it first (re-run
	// one module so only one of them is staged).
	//
	// A module applied in an EARLIER call is no longer staged, so a later module
	// that contests it does not conflict: that earlier apply is the serialized
	// winner the rule leaves holding model.blend, and this is the one case where
	// last-writer behaviour is not auto-merging, because the earlier apply is
	// already on disk and this decision cannot undo it.
	const allStaged = branchRuns.filter((run) => run.status === "staged");

	const applied: BranchApplyResult["applied"] = [];
	const skipped: BranchApplyResult["skipped"] = [];
	const missing: string[] = [];

	for (const record of staged) {
		const markStatus = async (status: BlenderBranchRunRecord["status"], conflicts?: BranchConflict[]): Promise<void> => {
			await updateManifest(manifest.manifestPath, (current) => {
				const target = current.branchRuns?.find((run) => run.sequence === record.sequence);
				if (target) {
					target.status = status;
					if (conflicts) target.conflicts = conflicts;
				}
			}, { signal: options.signal });
		};

		const conflicts = findRecordConflicts(record, allStaged.filter((run) => run !== record));
		if (conflicts.length > 0) {
			skipped.push({ module: record.module, conflicts });
			await markStatus("conflict", conflicts);
			continue;
		}

		if (!(await fileExists(record.branchPath))) {
			missing.push(record.module);
			await markStatus("failed", [
				{ objectName: record.branchPath, modules: ["the branch blend is missing from disk"] },
			]);
			continue;
		}

		const release = await acquireApplyLock(manifest.manifestPath, { signal: options.signal });
		let payload: BranchApplyPayload;
		try {
			payload = await runBlenderJson<BranchApplyPayload>({
				cwd: options.cwd,
				blendPath: manifest.blendPath,
				label: `branch apply ${record.module}`,
				scriptSource: buildBranchApplyScript(),
				payload: {
					branchPath: record.branchPath,
					applyObjects: record.applyObjects,
					applyMaterials: record.touchedMaterials,
					removeObjects: record.removedObjects,
				},
				signal: options.signal,
				timeoutMs: (options.timeoutSeconds ?? 300) * 1000,
			});
		} finally {
			await release();
		}

		if (payload.missing.length > 0) {
			skipped.push({
				module: record.module,
				conflicts: payload.missing.map((objectName) => ({ objectName, modules: ["missing from its branch"] })),
			});
			await markStatus("conflict");
			continue;
		}

		applied.push({
			module: record.module,
			iteration: record.iteration,
			appended: payload.appended,
			removed: payload.removedExisting,
			cameras: record.cameras ?? [],
		});

		await updateManifest(manifest.manifestPath, (current) => {
			const target = current.branchRuns?.find((run) => run.sequence === record.sequence);
			if (target) {
				target.status = "applied";
				target.appliedAt = nowIso();
			}
			// An apply is a module run as far as revert is concerned: it changed
			// model.blend, so it needs a run record with a checkpoint the revert
			// can restore. Recorded HERE rather than at run time, because the
			// checkpoint is the state the apply replaced and is written by the run.
			const moduleRuns = (current.moduleRuns ?? []) as BlenderModuleRunRecord[];
			current.moduleRuns = [
				...moduleRuns,
				{
					name: record.module,
					iteration: record.iteration,
					checkpointPath: record.checkpointPath,
					at: nowIso(),
					sequence: record.sequence,
					exitCode: 0,
					status: "ok",
					viaBranchApply: record.branchPath,
				},
			];
		}, { signal: options.signal });
	}

	// The live session is reloaded only when one is actually up. A headless-only
	// workspace has nothing to reload, and a failed reload must not fail an
	// apply that already landed on disk.
	let liveBlenderMessage = "model.blend updated. No live Blender session is running, so nothing was reloaded.";
	if (applied.length > 0 && isLiveBridgeAlive()) {
		try {
			await requestLiveBlenderReloadBlend({ blendPath: manifest.blendPath, signal: options.signal });
			liveBlenderMessage = "model.blend updated and reloaded in the live Blender session.";
		} catch (error) {
			liveBlenderMessage = `model.blend was updated, but the live Blender session did not reload it automatically: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	return { workspacePath: manifest.workspacePath, blendPath: manifest.blendPath, applied, skipped, missing, liveBlenderMessage };
}

/** Staged branch runs, for a caller that wants to plan an apply. */
export function stagedBranchRuns(manifest: BlenderWorkspaceManifest): BlenderBranchRunRecord[] {
	return (manifest.branchRuns ?? []).filter((run) => run.status === "staged");
}
