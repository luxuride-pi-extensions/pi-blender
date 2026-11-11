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

import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getBlenderAssetsDir } from "../config.js";
import { isLiveBridgeAlive } from "../launch.js";
import { requestLiveBlenderReloadBlend } from "./bridge.js";
import { mergeCameraPlan } from "./camera-plan.js";
import { collectModuleOwnership } from "./generations.js";
import { mapBackgroundRenderEngine } from "./render.js";
import { parseLockHolderPid, pidIsRunning } from "./liveness.js";
import { reclaimLockIfUnchanged } from "./lock-reclaim.js";
import { DEFAULT_MODULE_TIMEOUT_SECONDS } from "./types.js";
import type {
	BlenderBranchRunRecord,
	BlenderModuleRunRecord,
	BlenderWorkspaceManifest,
	BranchApplyOptions,
	BranchApplyResult,
	BranchCameraFraming,
	BranchConflict,
	ResolvedCameraPlan,
	BranchRunOptions,
	BranchRunResult,
} from "./types.js";
import {
	buildModuleScriptPreamble,
	DEFAULT_CHECKPOINT_RETENTION,
	getModuleDir,
	getModuleRunCheckpointName,
	getModuleScriptPath,
	getRunDir,
	MODULE_PREAMBLE_MARKER,
	normalizeModuleName,
	pruneOldModuleRuns,
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
/** Extra budget a render may take beyond the script's own timeout. */
const RENDER_TIMEOUT_MS = 360_000;
const BRANCH_SAVED_MARKER = "branch-saved";

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
import contextlib
import io
import json
import math
import os
import sys
import traceback

payload = json.loads(sys.argv[sys.argv.index("--") + 1])

# This run script is handed to Blender as a string rather than executed as a
# file beside the bridge, so the shared fingerprint module has to be located by
# the caller and put on the path from here.
_ASSETS_DIR_ON_PATH = payload.get("assetsDir")
if _ASSETS_DIR_ON_PATH and _ASSETS_DIR_ON_PATH not in sys.path:
    sys.path.insert(0, _ASSETS_DIR_ON_PATH)

import bpy  # pyright: ignore[reportMissingImports]

from mathutils import Vector  # pyright: ignore[reportMissingImports]

# One implementation of the fingerprint, shared with the live bridge: two copies
# of this algorithm are two answers to "did anything change", and the apply side
# only trusts a run if both paths agree.
from fingerprint import content_changed, snapshot
from module_state import (
    diff_snapshots,
    owned_after,
    owned_materials_after,
    state_digest as compute_state_digest,
    widen_apply_objects,
)
from render_scene import render_scene

branch_path = payload["branchPath"]
workspace_path = payload["workspacePath"]
iteration_path = payload["iterationPath"]
script_path = payload["scriptPath"]
module_name = payload["moduleName"]
owned_objects = list(payload.get("ownedObjects") or [])
owned_materials = list(payload.get("ownedMaterials") or [])


before = snapshot(bpy)

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

after = snapshot(bpy)
delta = diff_snapshots(before, after)

# The same content fingerprint the live bridge reports, from the same snapshot
# pair. Computed BEFORE framing: the auto-framed camera and its target are
# harness bookkeeping, not the script's work, so including them would report
# every successful framing run as a change and make the flag useless.
changed = content_changed(before, after)

touched_objects = delta["touchedObjects"]
touched_materials = delta["touchedMaterials"]

# The APPLY set is wider than the touched set, because a datablock that travels
# alone is invalid: a parented object without its parent is not a usable object,
# and a parent without its children strands them. The widening happens HERE and
# is reported in the record, rather than being discovered at apply time — a
# widened apply set is exactly what turns into a conflict against a sibling.
#
# A removal is exactly a name that disappeared between the two snapshots. A
# cascade deletion reports every object it took with it, so the apply removes
# them together; a relative that merely MOVED is not a removal, and the apply
# never takes one out because a parent changed.
apply_objects, removed_objects = widen_apply_objects(
    bpy,
    touched_objects,
    delta["removedObjects"],
)
# widen_apply_objects answers with a list (it is shared with the live bridge,
# which reports JSON). Framing below adds to this set, so take a set here.
apply_objects = set(apply_objects)

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


def _frame_subjects(plan):
    """The meshes this plan should frame.

    "module" deliberately does NOT use the widened apply set: a detail parented
    to a body would otherwise be photographed at whole-body scale, and a crop
    that hides the detail is the reason the run existed. The touched set is the
    module's own work for this iteration; an idempotent rebuild touches the
    same names, and an empty touched set falls back to the apply set.
    """
    source = touched_objects if plan.get("frameSubject") == "module" else apply_objects
    subjects = sorted(
        name for name in source
        if not name.endswith(CAMERA_SUFFIX)
        and not name.endswith(CAMERA_SUFFIX + "Target")
        and bpy.data.objects.get(name) is not None
        and bpy.data.objects[name].type == "MESH"
    )
    if not subjects and plan.get("frameSubject") == "module":
        subjects = sorted(
            name for name in apply_objects
            if not name.endswith(CAMERA_SUFFIX)
            and not name.endswith(CAMERA_SUFFIX + "Target")
            and bpy.data.objects.get(name) is not None
            and bpy.data.objects[name].type == "MESH"
        )
    return subjects


def _subject_coverage(camera, subjects):
    """NDC extents of every subject bbox corner, or None if any is behind."""
    from bpy_extras.object_utils import world_to_camera_view  # pyright: ignore[reportMissingImports]

    scene = bpy.context.scene
    bpy.context.view_layer.update()
    values = []
    for name in subjects:
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        for corner in obj.bound_box:
            projected = world_to_camera_view(scene, camera, obj.matrix_world @ Vector(corner))
            if projected.z <= 0:
                return None
            values.append((projected.x, projected.y))
    if not values:
        return None
    return {
        "minX": min(value[0] for value in values),
        "maxX": max(value[0] for value in values),
        "minY": min(value[1] for value in values),
        "maxY": max(value[1] for value in values),
    }


def _frame_module_camera(module, plan):
    """Place <module>Cam according to the resolved plan. Returns a report or None."""
    subjects = _frame_subjects(plan)
    bounds = _mesh_world_bounds(subjects)
    if bounds is None:
        return None

    shot = plan.get("primary") or {}
    direction = Vector(shot.get("direction") or FRAME_DIRECTION).normalized()
    lens = float(shot.get("lensMm") or FRAME_LENS_MM)
    orthographic = bool(shot.get("orthographic"))
    resolution = (payload.get("render") or {}).get("resolution") or {}
    width = max(int(resolution.get("x") or 1200), 1)
    height = max(int(resolution.get("y") or 900), 1)
    aspect = width / height
    # world_to_camera_view projects through camera.view_frame, which reads the
    # SCENE resolution. Setting it here makes the fit and the coverage check use
    # the same frame; render_scene writes the same values again later.
    bpy.context.scene.render.resolution_x = width
    bpy.context.scene.render.resolution_y = height
    bpy.context.scene.render.resolution_percentage = 100

    bounds_min, bounds_max = bounds
    center = (bounds_min + bounds_max) * 0.5
    extent = bounds_max - bounds_min
    radius = max(extent.length * 0.5, 1e-4)

    # Fit the bounding SPHERE, using the NARROWER of the horizontal and vertical
    # half-angles. Fitting only the sensor width crops a tall subject on a
    # landscape frame, which is exactly the bug a fixed lens hid.
    # sensor_fit AUTO fits the 36 mm sensor to the LONGER frame dimension, so a
    # portrait frame has a narrower horizontal half-angle, not a narrower
    # vertical one.
    if aspect >= 1:
        sensor_horizontal, sensor_vertical = FRAME_SENSOR_MM, FRAME_SENSOR_MM / aspect
    else:
        sensor_horizontal, sensor_vertical = FRAME_SENSOR_MM * aspect, FRAME_SENSOR_MM
    half_horizontal = math.atan((sensor_horizontal * 0.5) / lens)
    half_vertical = math.atan((sensor_vertical * 0.5) / lens)
    half_angle = min(half_horizontal, half_vertical)
    distance = radius / math.sin(half_angle) * FRAME_MARGIN if not orthographic else radius * 4.0
    requested_distance = plan.get("distance")
    if requested_distance:
        distance = max(distance, float(requested_distance))
    ortho_scale = radius * 2.0 * FRAME_MARGIN

    camera_name = module + CAMERA_SUFFIX
    camera = bpy.data.objects.get(camera_name)
    created = camera is None
    if created:
        camera = bpy.data.objects.new(camera_name, bpy.data.cameras.new(camera_name))
        bpy.context.scene.collection.objects.link(camera)
    # Older harnesses aimed the camera with a Track To empty. The rotation is
    # baked now, and leaving the empty would keep it in the module's ownership
    # forever; only the exact legacy name is removed, never a user empty.
    legacy_target = bpy.data.objects.get(camera_name + "Target")
    removed_legacy = []
    if legacy_target is not None and legacy_target.type == "EMPTY":
        removed_legacy.append(legacy_target.name)
        bpy.data.objects.remove(legacy_target, do_unlink=True)
    camera.data.type = "ORTHO" if orthographic else "PERSP"
    camera.data.lens = lens
    camera.data.sensor_width = FRAME_SENSOR_MM
    camera.data.sensor_fit = "AUTO"

    # Bake the rotation rather than constrain it to an empty: coverage is
    # evaluated immediately, and a constraint is only resolved after a depsgraph
    # update that would let a crop report a stale matrix. The camera looks down
    # local -Z, so the look direction is -direction.
    camera.rotation_mode = "XYZ"
    camera.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()

    coverage = None
    coverage_ok = False
    for _ in range(10):
        camera.location = center + direction * distance
        camera.data.ortho_scale = ortho_scale
        coverage = _subject_coverage(camera, subjects)
        if coverage is None:
            break
        if coverage["minX"] >= 0.02 and coverage["maxX"] <= 0.98 and coverage["minY"] >= 0.02 and coverage["maxY"] <= 0.98:
            coverage_ok = True
            break
        if orthographic:
            ortho_scale *= 1.15
        else:
            distance *= 1.15

    camera.data.clip_end = max(camera.data.clip_end, distance + radius * 2.0)

    # camera_fit_coords is the independent check: if it asks for more distance
    # than we chose for this direction, the arithmetic fit missed something.
    # It fits along the camera's CURRENT rotation, which is why the rotation is
    # set before this call.
    fit_distance = None
    try:
        depsgraph = bpy.context.evaluated_depsgraph_get()
        coordinates = []
        for name in subjects:
            obj = bpy.data.objects.get(name)
            if obj is not None:
                coordinates.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
        if coordinates:
            fit_location, fit_scale = camera.camera_fit_coords(depsgraph, coordinates)
            fit_distance = (Vector(fit_location) - center).length
            if orthographic:
                ortho_scale = max(ortho_scale, fit_scale * FRAME_MARGIN)
                camera.data.ortho_scale = ortho_scale
    except Exception:
        # Cross-check only: a Blender build without the helper must not fail the
        # run, and the NDC coverage loop above is the authoritative check.
        fit_distance = None

    # Only the primary camera belongs to the module. Planned shots are metadata
    # for the review sheet; creating five cameras per iteration would leave
    # model.blend with a camera zoo and make the apply set contestable.
    apply_objects.add(camera_name)
    removed_objects[:] = [n for n in removed_objects if n not in apply_objects]

    return {
        "module": module,
        "cameraName": camera_name,
        "created": created,
        "center": [center.x, center.y, center.z],
        "extent": [extent.x, extent.y, extent.z],
        "direction": [direction.x, direction.y, direction.z],
        "distance": distance,
        "lensMm": lens,
        "orthographic": orthographic,
        "orthoScale": ortho_scale if orthographic else None,
        "fitDistance": fit_distance,
        "coverage": coverage,
        "coverageOk": coverage_ok,
        "removedLegacy": removed_legacy,
        "shot": shot.get("name") or "hero",
        "subjects": subjects,
    }


camera_plan = payload.get("cameraPlan") or {}
camera_framing = _frame_module_camera(module_name, camera_plan)
cameras = [camera_framing] if camera_framing is not None else []
camera_plan_report = dict(camera_plan)
camera_plan_report["resolved"] = camera_framing
if camera_framing and camera_framing.get("removedLegacy"):
    for legacy_name in camera_framing["removedLegacy"]:
        if legacy_name not in removed_objects:
            removed_objects.append(legacy_name)
if camera_framing and not camera_framing.get("coverageOk") and payload.get("render"):
    camera_plan_report["warnings"] = list(camera_plan_report.get("warnings") or []) + [
        "The camera was not shown to fit the subject; coverage is reported on the framing."
    ]

# A digest of the geometry this run left behind, over the datablocks this
# MODULE owns. It exists to make one question decidable without an image: did
# this iteration change anything at all? An iteration whose digest equals its
# predecessor's produced the same bytes in a different runs/NN directory, and no
# critic reading a re-render of those bytes can return a finding that was not
# already available from the last one. That is the whole case for computing it
# here rather than letting the loop discover it by spending two more critiques.
#
# It is scoped to the module's OWNED objects, NOT to what this run applied, and
# that distinction is load-bearing. The fingerprints above are content-based --
# the name is excluded deliberately, so a rename reads as a remove plus an add --
# and an idempotent rebuild that removes and recreates a part byte-for-byte is
# therefore indistinguishable from a run that did nothing: touched is empty,
# apply_objects is empty, and a digest over the apply set would hash the empty
# string. Every rebuild would read as a change, which is the one false negative
# the loop must not have. Ownership is carried forward from the module's earlier
# runs, so the digest has a stable subject whether or not this run changed it.
#
# Two exclusions, both to keep the number about geometry a critic would notice.
# The camera AND its target are excluded, because framing rewrites that pair on
# every run. The suffix test has to cover both names: filtering on CAMERA_SUFFIX alone
# leaves the target empty in the digest, and because the after-snapshot is taken
# BEFORE framing creates the pair, the first run hashes a datablock that does
# not exist yet as a dash while every later run hashes its real content -- so
# the very first run would always read as a change and every rebuild after it as
# a second one.
bpy.context.view_layer.update()
owned_objects = owned_after(owned_objects, apply_objects, removed_objects)
owned_materials = owned_materials_after(owned_materials, touched_materials)
state_digest = compute_state_digest(after, owned_objects, owned_materials)

# The save happens HERE, after the framing and after the apply set is settled --
# not inside the try above. Saving earlier wrote a branch file without the camera,
# so the render could not find it, and the apply reported the camera as missing
# from its own branch: the framing existed in memory and nowhere else.
if exit_code == 0:
    bpy.ops.wm.save_mainfile()
    # A process-level render failure (crash, OOM, timeout) produces no JSON at
    # all, so the caller cannot tell "nothing was saved" from "the branch is on
    # disk and only the picture failed" without a marker written before the risky
    # stage.
    with open(os.path.join(payload["runDir"], "branch-saved"), "w") as marker:
        marker.write(module_name)

# Framing deliberately does NOT happen again in the apply. This run's render was
# taken on this branch, so the framing that reaches model.blend is the framing of
# the geometry the critic judged; re-solving it against the merged scene would
# silently disagree with that picture.

# Render inside the SAME process that just authored the branch. The branch
# blend is saved above, so this is the file the apply will merge and the image
# the critic will judge; spawning a second Blender only to open the file again
# bought nothing but a cold start.
render_result = None
render_error = None
render_request = payload.get("render")
if exit_code == 0 and render_request:
    if not render_request.get("cameraName") and cameras:
        render_request["cameraName"] = cameras[0]["cameraName"]
    # A render failure must not discard the run: the geometry is already saved in
    # the branch, and the caller can see which stage failed instead of a generic
    # Blender crash.
    try:
        render_result = render_scene(render_request)
    except Exception as exc:
        render_error = str(exc)

print("__PI_BLENDER_JSON_START__")
print(json.dumps({
    "stdout": stdout_buffer.getvalue(),
    "stderr": stderr_buffer.getvalue(),
    "exitCode": exit_code,
    "changed": changed,
    "touchedObjects": touched_objects,
    "touchedMaterials": touched_materials,
    "addedObjects": delta["addedObjects"],
    "removedObjects": removed_objects,
    "applyObjects": sorted(apply_objects),
    "ownedObjects": sorted(owned_objects),
    "ownedMaterials": owned_materials,
    "stateDigest": state_digest,
    "cameras": cameras,
    "cameraPlan": camera_plan_report,
    "render": render_result,
    "renderError": render_error,
}))
print("__PI_BLENDER_JSON_END__")
`;
}

interface BranchRunPayload {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Content fingerprint diff, the same definition the live bridge reports. */
	changed: boolean;
	touchedObjects: string[];
	touchedMaterials: string[];
	addedObjects: string[];
	removedObjects: string[];
	applyObjects: string[];
	/**
	 * Every object this module owns after this run: what it applied, plus what it
	 * owned before, minus what it removed. Carried forward because the
	 * fingerprints are content-based, so an idempotent rebuild applies nothing
	 * and the apply set alone cannot say what the module is responsible for.
	 */
	ownedObjects: string[];
	/** Materials this module owns after this run; carried into the next one. */
	ownedMaterials: string[];
	/**
	 * Content hash over the owned objects and materials, or null when there is no subject.
	 */
	stateDigest: string | null;
	/** Framing solved for this module's camera; empty when it produced no mesh. */
	cameras: BranchCameraFraming[];
	/** The resolved camera plan and the framing it produced. */
	cameraPlan: ResolvedCameraPlan;
	/** The render this run took, or null when rendering was disabled. */
	render: BranchRenderPayload | null;
	/** Why the render failed, when the run itself succeeded. */
	renderError: string | null;
}

interface BranchRenderPayload {
	outputPath: string;
	cameraName: string | null;
	resolvedEngine: string;
	requestedEngine: string | string[] | null;
	resolution: { x: number; y: number; percentage: number };
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
	const capturedAt = new Date();
	await copyFile(manifest.blendPath, branchPath);

	// The revert checkpoint must describe the state this run REPLACES. Copying
	// the branch rather than re-reading model.blend makes it the SAME read: an
	// apply landing between two reads would put a sibling's merged work into the
	// checkpoint, and a revert would then silently keep work this run never saw.
	const checkpointPath = join(runDir, getModuleRunCheckpointName(iteration));
	try {
		await copyFile(branchPath, checkpointPath);
		// The checkpoint's mtime is the revert guard's clock, and copyFile stamps
		// it when the copy FINISHES, after the read it represents. Dating it to
		// the read closes that window: a run that applied while the bytes were
		// being copied is then still seen as later. Erring early can only add
		// refusals, never lose a sibling's work.
		await utimes(checkpointPath, capturedAt, capturedAt);
	} catch (error) {
		await rm(branchPath, { force: true }).catch(() => undefined);
		await rm(checkpointPath, { force: true }).catch(() => undefined);
		await releaseReservedIteration(manifest.manifestPath, iteration).catch(() => undefined);
		throw error;
	}

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

	const renderRequested = options.render !== false;
	// A saved view or a named camera is resolved here, before the run, because it
	// belongs in the render payload. The module's own auto-framed camera is not
	// known until the script has run, so it is chosen inside that same process
	// from `cameras` rather than guessed at here.
	let requestedCameraName: string | undefined;
	const savedView = options.view ? manifest.savedViews[options.view] : undefined;
	if (savedView) {
		requestedCameraName = getSavedViewCameraObjectName(savedView) ?? undefined;
	} else if (options.view && options.view !== "active-camera") {
		// Accept either a named camera object or a saved view; "active-camera"
		// keeps the branch's own camera, same as the live module render.
		requestedCameraName = options.view;
	}

	// The plan is sticky: a later run that omits the contract reuses the last
	// applied plan rather than silently snapping back to "prop from -Y". "Front"
	// moving between iterations makes every comparison a comparison of cameras.
	const previousPlan = [...(manifest.branchRuns ?? [])]
		.filter((run) => run.module === moduleName && run.cameraPlan)
		.sort((a, b) => (b.sequence ?? b.iteration) - (a.sequence ?? a.iteration))[0]?.cameraPlan;
	const cameraPlan = mergeCameraPlan(
		{
			profile: options.cameraProfile,
			frontAxis: options.frontAxis,
			shots: options.cameraShots,
			frameSubject: options.frameSubject,
			distance: options.cameraDistance,
		},
		previousPlan,
	);

	// Ownership is read from the manifest before the run, so the digest subject
	// survives a script that changes nothing this time.
	const priorOwnership = collectModuleOwnership(manifest, moduleName);
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
				runDir,
				scriptPath: effectiveScriptPath,
				moduleName,
				// The generated run script is executed as a string, not as a file
				// in the assets dir, so nothing about sys.path comes for free and
				// the shared fingerprint module has to be pointed at explicitly.
				assetsDir: getBlenderAssetsDir(),
				// Ownership is CARRIED FORWARD from the module's earlier APPLIED
				// generations, not re-derived from the script or from the diff. The
				// fingerprints are content-based, so a script that removes and rebuilds
				// its part byte-for-byte applies nothing and looks identical to a script
				// that did nothing; without a prior record the digest would have an empty
				// subject on exactly the rebuild iterations it exists to measure.
				ownedObjects: priorOwnership.objects,
				ownedMaterials: priorOwnership.materials,
				cameraPlan,
				render: renderRequested
					? {
							outputPath: join(moduleDir, RENDER_FILE),
							cameraName: requestedCameraName,
							resolution: options.resolution ?? DEFAULT_BRANCH_RENDER_RESOLUTION,
							samples: options.samples,
							renderEngine: mapBackgroundRenderEngine(options.renderEngine ?? null),
						}
					: null,
			},
			signal: options.signal,
			timeoutMs: (options.timeoutSeconds ?? DEFAULT_MODULE_TIMEOUT_SECONDS) * 1000 + (renderRequested ? RENDER_TIMEOUT_MS : 0),
		});
	} catch (error) {
		// A launch that never produced JSON leaves the branch in an unknown state
		// UNLESS the run script marked it saved before rendering. Then the build is
		// real, and only the picture failed: keep it so the caller can apply it.
		const branchSaved = existsSync(join(runDir, BRANCH_SAVED_MARKER));
		await rm(join(runDir, BRANCH_SAVED_MARKER), { force: true }).catch(() => undefined);
		if (!branchSaved) {
			await rm(branchPath, { force: true }).catch(() => undefined);
			await rm(checkpointPath, { force: true }).catch(() => undefined);
		}
		await releaseReservedIteration(manifest.manifestPath, iteration).catch(() => undefined);
		if (branchSaved) {
			throw new Error(
				`${(error as Error).message}\nThe branch was saved before the render failed and is intact at ${branchPath}.`,
			);
		}
		throw error;
	}

	if (payload.exitCode !== 0) {
		await rm(branchPath, { force: true }).catch(() => undefined);
		await rm(checkpointPath, { force: true }).catch(() => undefined);
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

	// The render already happened in the run process, against the branch blend
	// this record describes. An explicit view names itself; otherwise the label
	// is the module's own framed camera, which is what the run actually used.
	const renderOutputPath = payload.render?.outputPath ?? null;
	const renderError = payload.renderError ?? undefined;
	if (renderRequested && !renderOutputPath) {
		// The path is stable per module, so a failed render would otherwise leave
		// the PREVIOUS iteration's picture where a critic expects this one.
		await rm(join(moduleDir, RENDER_FILE), { force: true }).catch(() => undefined);
	}
	let viewLabel = options.view ?? "active-camera";
	if (renderRequested && !requestedCameraName) {
		viewLabel = payload.cameras[0]?.cameraName ?? "active-camera";
	}

	await pruneOldModuleRuns(manifest.workspacePath, moduleName, iteration);

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
		ownedObjects: payload.ownedObjects,
		ownedMaterials: payload.ownedMaterials,
		stateDigest: payload.stateDigest ?? undefined,
		status: "staged",
		renderOutputPath,
		cameras: payload.cameras,
		cameraPlan: payload.cameraPlan,
	};

	await updateManifest(
		manifest.manifestPath,
		(current) => {
			current.branchRuns = appendBranchRun(current, record);
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
		sequence,
		runDir,
		checkpointPath,
		exitCode: payload.exitCode,
		changed: payload.changed,
		stdout: payload.stdout.trim(),
		stderr: payload.stderr.trim(),
		touchedObjects: payload.touchedObjects,
		touchedMaterials: payload.touchedMaterials,
		addedObjects: payload.addedObjects,
		removedObjects: payload.removedObjects,
		applyObjects: payload.applyObjects,
		ownedObjects: payload.ownedObjects,
		ownedMaterials: payload.ownedMaterials,
		renderOutputPath,
		renderError,
		resolvedEngine: payload.render?.resolvedEngine,
		cameras: payload.cameras,
		cameraPlan: payload.cameraPlan,
		resolvedCameraName: payload.render?.cameraName ?? requestedCameraName ?? payload.cameras[0]?.cameraName,
		stateDigest: payload.stateDigest ?? undefined,
		status: "staged",
	};
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
branches = payload["branches"]


def probe(branch):
    """What the branch file holds, without loading anything yet.

    A branch that lost a datablock is skipped BEFORE model.blend is touched, so
    one broken branch cannot leave the merge half-applied. The probe opens the
    library with an empty data_to, which loads nothing.
    """
    missing = []
    try:
        with bpy.data.libraries.load(branch["branchPath"], link=False) as (data_from, data_to):
            object_index = {name: index for index, name in enumerate(data_from.objects)}
            material_index = {name: index for index, name in enumerate(data_from.materials)}
            missing.extend(name for name in branch["applyObjects"] if name not in object_index)
            missing.extend(name for name in branch["applyMaterials"] if name not in material_index)
    except Exception as exc:
        # The pre-flight check runs without the apply lock, so a branch can be
        # replaced or truncated between that check and this load. Report it as a
        # skipped branch instead of aborting every other branch in the batch.
        return [f"<unreadable branch blend: {exc}>"]
    return missing


def apply_branch(branch):
    apply_objects = branch["applyObjects"]
    apply_materials = branch["applyMaterials"]
    remove_objects = branch["removeObjects"]

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

    # Membership is tested through an INDEX over the library's name list, not by
    # subscripting data_from.objects: those are plain lists in Blender 5.2.
    with bpy.data.libraries.load(branch["branchPath"], link=False) as (data_from, data_to):
        object_index = {name: index for index, name in enumerate(data_from.objects)}
        material_index = {name: index for index, name in enumerate(data_from.materials)}
        data_to.objects = [data_from.objects[object_index[n]] for n in apply_objects]
        data_to.materials = [data_from.materials[material_index[m]] for m in apply_materials]

    # Link every appended object into the scene. Without this the append is
    # undone by the save below, silently: Blender only writes datablocks that
    # have users.
    scene_collection = bpy.context.scene.collection
    for name in apply_objects:
        obj = bpy.data.objects.get(name)
        if obj is not None and len(obj.users_collection) == 0:
            scene_collection.objects.link(obj)

    return {
        "replaced": replaced,
        "removedExisting": removed_existing,
        "appended": sorted(obj.name for obj in bpy.data.objects if obj.name in set(apply_objects)),
        "appendedMaterials": sorted(m.name for m in bpy.data.materials if m.name in set(apply_materials)),
    }


outcomes = []
saved = False
aborted = False
for branch in branches:
    missing = probe(branch)
    if not missing:
        try:
            result = apply_branch(branch)
        except Exception as exc:
            missing = [f"<branch could not be read: {exc}>"]
            aborted = True
        else:
            outcomes.append({
                "module": branch["module"],
                "applied": True,
                "missing": [],
                **result,
            })
            saved = True
            continue
    if missing:
        outcomes.append({
            "module": branch["module"],
            "applied": False,
            "replaced": [],
            "removedExisting": [],
            "appended": [],
            "appendedMaterials": [],
            "missing": missing,
        })
        continue

# ONE save for the whole apply. A failure before this point leaves model.blend
# exactly as it was, so a hard failure cannot remove one module's objects and
# then leave the file without the branch that was meant to replace them. An
# in-process failure may already have removed datablocks, so it suppresses the
# save entirely and downgrades every outcome: nothing was written.
if aborted:
    reason = next((name for outcome in outcomes for name in outcome["missing"]), "the batch was aborted")
    for outcome in outcomes:
        outcome["applied"] = False
        outcome["missing"] = outcome["missing"] or [reason]
if saved and not aborted:
    bpy.ops.wm.save_mainfile()

print("__PI_BLENDER_JSON_START__")
print(json.dumps({"branches": outcomes}))
print("__PI_BLENDER_JSON_END__")
`;
}

interface BranchApplyOutcome {
	module: string;
	applied: boolean;
	replaced: string[];
	removedExisting: string[];
	appended: string[];
	appendedMaterials: string[];
	missing: string[];
}

interface BranchApplyPayload {
	branches: BranchApplyOutcome[];
}

const APPLY_LOCK_FILE = ".branch-apply.lock";
/**
 * Enough to outlive a slow apply, because a holder that is reclaimed early
 * would let a second apply write model.blend while the first still has it
 * open -- and reclaiming late only costs a stuck workspace the operator can
 * clear.
 *
 * The window is the FALLBACK path, not the rule: a lock whose holder pid is
 * gone is reclaimed immediately whatever its age. A lock with a readable pid is
 * NEVER reclaimed on age, because an apply is deliberately held across a
 * headless Blender run whose duration nobody bounded -- a time-based steal
 * would hand model.blend to a second apply mid-merge, and the first apply's
 * save would win with the second one's objects missing. Age reclaims only a
 * pre-pid lock, which is also the operator's escape hatch for a workspace
 * wedged by a holder this process cannot see.
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
			// A dead holder is reclaimed at any age. A live one never is, however
			// long it has been running: this lock is held across the merge itself.
			let reclaimable = false;
			let observed = "";
			try {
				const stats = await stat(lockPath);
				observed = await readFile(lockPath, "utf-8");
				const holderPid = parseLockHolderPid(observed);
				reclaimable =
					holderPid === null ? Date.now() - stats.mtimeMs > APPLY_LOCK_STALE_MS : !pidIsRunning(holderPid);
			} catch {
				continue;
			}
			if (reclaimable) {
				// Conditional on the lock still being the judged one. A reclaim
				// that unlinks by path can delete a lock a third waiter created
				// after the holder released, and two applies against one
				// model.blend is precisely what this lock exists to stop.
				await reclaimLockIfUnchanged(lockPath, observed);
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
 * Apply staged branches into model.blend in ONE pass, reporting and skipping
 * any that conflict with another staged branch.
 *
 * The whole batch is pre-flighted before model.blend is opened, then merged by
 * one Blender process holding the apply lock for the whole merge and saving
 * once. A conflict or a vanished branch is decided from the records, so it
 * never reaches that process; a branch whose blend disagrees with its record is
 * skipped inside the process before it mutates anything. A hard failure before
 * the single save leaves model.blend exactly as it was, and the caller can
 * retry the batch.
 *
 * A conflicted module is NOT applied and NOT merged: its changes stay in its
 * branch blend, so nothing is lost and the operator can decide which side was
 * wrong. `skipped` names every conflicted module and the datablock that stopped
 * it, because "one module did not apply" with no reason is indistinguishable
 * from a bug.
 */
export async function blenderBranchApply(options: BranchApplyOptions): Promise<BranchApplyResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);

	const staged = options.modules
		.map((raw) => {
			const name = normalizeModuleName(raw);
			const record = latestStagedBranch(manifest, name);
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
	const allStaged = contestableStagedRuns(manifest);

	const applied: BranchApplyResult["applied"] = [];
	const skipped: BranchApplyResult["skipped"] = [];
	const missing: string[] = [];
	const contested: Array<{ record: BlenderBranchRunRecord; conflicts: BranchConflict[] }> = [];
	const absent: BlenderBranchRunRecord[] = [];
	const eligible: BlenderBranchRunRecord[] = [];

	// Pre-flight the whole batch BEFORE a Blender process starts: a conflict or
	// a vanished branch is a reason not to open model.blend at all, and finding
	// it after the save would report work that did land as if it had not.
	for (const record of staged) {
		const conflicts = findRecordConflicts(record, allStaged.filter((run) => run !== record));
		if (conflicts.length > 0) {
			contested.push({ record, conflicts });
			skipped.push({ module: record.module, conflicts });
			continue;
		}
		if (!(await fileExists(record.branchPath))) {
			absent.push(record);
			missing.push(record.module);
			continue;
		}
		eligible.push(record);
	}

	let outcomes: BranchApplyOutcome[] = [];
	if (eligible.length > 0) {
		// ONE lock, ONE process, ONE save for the whole batch. The lock used to be
		// per record, which let a second apply interleave between two records of
		// this one and observe a fan-out that was only half merged.
		const release = await acquireApplyLock(manifest.manifestPath, { signal: options.signal });
		try {
			const payload = await runBlenderJson<BranchApplyPayload>({
				cwd: options.cwd,
				blendPath: manifest.blendPath,
				label: `branch apply ${eligible.map((record) => record.module).join(", ")}`,
				scriptSource: buildBranchApplyScript(),
				payload: {
					branches: eligible.map((record) => ({
						module: record.module,
						branchPath: record.branchPath,
						applyObjects: record.applyObjects,
						applyMaterials: record.touchedMaterials,
						removeObjects: record.removedObjects,
					})),
				},
				signal: options.signal,
				timeoutMs: (options.timeoutSeconds ?? DEFAULT_MODULE_TIMEOUT_SECONDS) * 1000,
			});
			outcomes = payload.branches;
		} finally {
			await release();
		}
	}

	const outcomeByModule = new Map<string, BranchApplyOutcome>();
	outcomes.forEach((outcome) => {
		outcomeByModule.set(outcome.module, outcome);
	});
	const outcomeFor = (record: BlenderBranchRunRecord) =>
		outcomeByModule.get(record.module) ?? outcomeBySequenceFallback(record, outcomes);

	// Records whose branch the process could not read are identified by module;
	// index is only a fallback for a payload that lost its module name.
	function outcomeBySequenceFallback(record: BlenderBranchRunRecord, all: BranchApplyOutcome[]) {
		const index = eligible.findIndex((entry) => entry.sequence === record.sequence);
		return index >= 0 ? all[index] : undefined;
	}

	// A branch the process skipped because its blend disagreed with its record is
	// reported with the datablocks that were missing; it did not touch model.blend.
	const short = eligible.flatMap((record) => {
		const outcome = outcomeFor(record);
		return outcome && !outcome.applied ? [{ record, outcome }] : [];
	});
	for (const { record, outcome } of short) {
		skipped.push({
			module: record.module,
			conflicts: outcome.missing.map((name) => ({
				objectName: name,
				modules: ["missing from its branch"],
			})),
		});
	}

	await updateManifest(manifest.manifestPath, (current) => {
		const mark = (sequence: number, status: BlenderBranchRunRecord["status"], conflicts?: BranchConflict[]): BlenderBranchRunRecord | undefined => {
			const target = current.branchRuns?.find((run) => run.sequence === sequence);
			if (target) {
				target.status = status;
				if (conflicts) target.conflicts = conflicts;
			}
			return target;
		};

		for (const { record, conflicts } of contested) mark(record.sequence, "conflict", conflicts);
		for (const record of absent) {
			mark(record.sequence, "failed", [
				{ objectName: record.branchPath, modules: ["the branch blend is missing from disk"] },
			]);
		}
		for (const { record, outcome } of short) {
			mark(record.sequence, "conflict", outcome.missing.map((name) => ({
				objectName: name,
				modules: ["missing from its branch"],
			})));
		}

		const batchAt = nowIso();
		for (const record of eligible) {
			const outcome = outcomeFor(record);
			if (!outcome?.applied) continue;
			mark(record.sequence, "applied");
			const target = current.branchRuns?.find((run) => run.sequence === record.sequence);
			if (target) target.appliedAt = batchAt;
			applied.push({
				module: record.module,
				iteration: record.iteration,
				appended: outcome.appended,
				removed: outcome.removedExisting,
				cameras: record.cameras ?? [],
			});
			// An apply is a module run as far as revert is concerned: it changed
			// model.blend, so it needs a run record with a checkpoint the revert
			// can restore. Recorded HERE rather than at run time, because the
			// checkpoint is the state the run replaced, taken when the branch was
			// copied — an apply may land later, or a sibling may land first, so it
			// can predate this apply.
			const moduleRuns = (current.moduleRuns ?? []) as BlenderModuleRunRecord[];
			current.moduleRuns = [
				...moduleRuns,
				{
					name: record.module,
					iteration: record.iteration,
					checkpointPath: record.checkpointPath,
					at: batchAt,
					sequence: record.sequence,
					exitCode: 0,
					status: "ok",
					viaBranchApply: record.branchPath,
				},
			];
		}
	}, { signal: options.signal });

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

/**
 * The staged records that may still contest a datablock.
 *
 * Only the NEWEST run of a module can contest: a re-run (staged, applied, or
 * live) supersedes the branch it replaces, and a record whose branch was
 * abandoned must not block that module's objects forever. Superseded records
 * stay in the manifest -- the deliberate checkpoint history -- but they are dead
 * as live claims, which is the distinction the retention rule did not make.
 */
export function contestableStagedRuns(
	manifest: Pick<BlenderWorkspaceManifest, "branchRuns" | "moduleRuns">,
): BlenderBranchRunRecord[] {
	const newest = new Map<string, number>();
	for (const run of manifest.branchRuns ?? []) {
		// A failed or conflicted attempt proved nothing about the module's state,
		// so it does not supersede a branch that is still waiting to be applied.
		if (run.status !== "staged" && run.status !== "applied") continue;
		newest.set(run.module, Math.max(newest.get(run.module) ?? 0, run.sequence));
	}
	for (const run of manifest.moduleRuns ?? []) {
		if (run.status !== "ok") continue;
		newest.set(run.name, Math.max(newest.get(run.name) ?? 0, run.sequence));
	}
	return (manifest.branchRuns ?? []).filter(
		(run) => run.status === "staged" && run.sequence >= (newest.get(run.module) ?? run.sequence),
	);
}

/** Append a finished run and apply the per-module retention window. */
export function appendBranchRun(
	current: Pick<BlenderWorkspaceManifest, "branchRuns">,
	record: BlenderBranchRunRecord,
): BlenderBranchRunRecord[] {
	return pruneBranchRunHistory([...(current.branchRuns ?? []), record]);
}

/**
 * The staged record an apply should use for a module.
 *
 * Newest by SEQUENCE, not by array order: a late finisher appends later with a
 * lower sequence, and a superseded record must never be the one applied.
 */
export function latestStagedBranch(
	manifest: Pick<BlenderWorkspaceManifest, "branchRuns" | "moduleRuns">,
	moduleName: string,
): BlenderBranchRunRecord | undefined {
	return contestableStagedRuns(manifest)
		.filter((run) => run.module === moduleName)
		.sort((a, b) => b.sequence - a.sequence)[0];
}

/**
 * Keep the branch history that can still be used.
 *
 * A finish record costs a checkpoint path, a script path and a handful of name
 * arrays, and nothing used to remove it: a long multi-module build grew the
 * manifest without limit. The window is per MODULE and counted in records, not
 * in global iterations: claims are globally unique, so a 40-module round
 * advances the iteration clock by 40 and an iteration-keyed window would erase
 * every module's history each round -- including the ownedObjects carry-forward
 * and the digest a rebuild compares against.
 *
 * The newest staged record for a module is always inside the window, because it
 * has that module's highest sequence; a staged record superseded by a later run
 * is dropped normally.
 */
export function pruneBranchRunHistory(
	runs: BlenderBranchRunRecord[],
	keep = DEFAULT_CHECKPOINT_RETENTION,
): BlenderBranchRunRecord[] {
	const window = Math.max(1, Math.trunc(keep));
	const byModule = new Map<string, BlenderBranchRunRecord[]>();
	for (const run of runs) {
		const list = byModule.get(run.module);
		if (list) list.push(run);
		else byModule.set(run.module, [run]);
	}
	const kept: BlenderBranchRunRecord[] = [];
	for (const list of byModule.values()) {
		list.sort((a, b) => b.sequence - a.sequence);
		kept.push(...list.slice(0, window));
	}
	return kept;
}
