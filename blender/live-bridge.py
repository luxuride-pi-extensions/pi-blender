import contextlib
import io
import json
import math
import os
import shutil
import traceback

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]

# mathutils ships with Blender's Python runtime, so pyright cannot resolve it
# outside a Blender environment — same as the bpy import above.
from mathutils import Matrix, Vector  # pyright: ignore[reportMissingImports]
from mathutils.bvhtree import BVHTree  # pyright: ignore[reportMissingImports]

BRIDGE_DIR = os.environ.get("VIBE_BLENDER_BLENDER_BRIDGE_DIR") or os.environ.get("VIBE_BLENDER_BRIDGE_DIR") or os.path.join(
    os.path.expanduser("~"),
    ".vibe-blender",
    "agent",
    "blender-bridge",
)
REQUESTS_DIR = os.path.join(BRIDGE_DIR, "requests")
RESPONSES_DIR = os.path.join(BRIDGE_DIR, "responses")
# A request is moved here by whichever poller wins the atomic rename, so a
# second Blender polling the same bridge dir can never execute it too.
CLAIMS_DIR = os.path.join(BRIDGE_DIR, "claims")
POLL_INTERVAL_SECONDS = 0.5


def ensure_bridge_dirs():
    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    os.makedirs(REQUESTS_DIR, exist_ok=True)
    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    os.makedirs(RESPONSES_DIR, exist_ok=True)
    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    os.makedirs(CLAIMS_DIR, exist_ok=True)


def recover_orphaned_claims():
    """Return claimed-but-unfinished requests to the queue.

    A Blender that dies between the claim and the response leaves its request
    in CLAIMS_DIR, where no poller would ever look again and the caller would
    sit until its own timeout. Anything still claimed when *this* bridge
    starts therefore belongs to a previous, dead bridge. Restoring is safe even
    if another bridge is running: the atomic claim in process_request_file
    means only one poller can win the restored file.
    """
    try:
        orphaned = sorted(os.listdir(CLAIMS_DIR))
    except OSError:
        return

    for file_name in orphaned:
        if not file_name.endswith(".json"):
            continue
        with contextlib.suppress(OSError):
            os.replace(os.path.join(CLAIMS_DIR, file_name), os.path.join(REQUESTS_DIR, file_name))


def write_response(request_id, payload):
    response_path = os.path.join(RESPONSES_DIR, f"{request_id}.json")
    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    with open(response_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)


def find_viewport_context():
    best = find_optional_viewport_context()
    if best is None:
        raise RuntimeError("No live VIEW_3D viewport is open in Blender.")
    return best


def find_optional_viewport_context():
    best = None

    for window in bpy.context.window_manager.windows:
        screen = window.screen
        if screen is None:
            continue

        for area in screen.areas:
            if area.type != "VIEW_3D":
                continue

            region = next((candidate for candidate in area.regions if candidate.type == "WINDOW"), None)
            space = area.spaces.active if area.spaces.active and area.spaces.active.type == "VIEW_3D" else None
            region_3d = getattr(space, "region_3d", None) if space else None
            if region is None or space is None or region_3d is None:
                continue

            area_size = int(area.width) * int(area.height)
            candidate = {
                "window": window,
                "screen": screen,
                "area": area,
                "region": region,
                "space": space,
                "region_3d": region_3d,
                "scene": window.scene if getattr(window, "scene", None) else bpy.context.scene,
                "area_size": area_size,
            }
            if best is None or candidate["area_size"] > best["area_size"]:
                best = candidate

    return best


def object_ref(obj):
    if obj is None:
        return None
    return {
        "name": obj.name,
        "type": obj.type,
    }


def summarize_viewport(viewport):
    if viewport is None:
        return {
            "hasViewport": False,
            "areaSize": None,
            "viewPerspective": None,
            "shadingType": None,
            "cameraName": None,
            "isCameraView": False,
        }

    region_3d = viewport["region_3d"]
    space = viewport["space"]
    view_camera = getattr(space, "camera", None)
    return {
        "hasViewport": True,
        "areaSize": int(viewport["area_size"]),
        "viewPerspective": region_3d.view_perspective,
        "shadingType": getattr(space.shading, "type", None),
        "cameraName": view_camera.name if view_camera is not None and view_camera.type == "CAMERA" else None,
        "isCameraView": region_3d.view_perspective == "CAMERA",
    }


def ensure_render_camera(scene, camera_name):
    if camera_name:
        camera_object = bpy.data.objects.get(camera_name)
        if camera_object is None:
            raise RuntimeError(f'Camera "{camera_name}" was not found.')
        if camera_object.type != "CAMERA":
            raise RuntimeError(f'Object "{camera_name}" is not a camera.')
        scene.camera = camera_object

    if scene.camera is None:
        fallback = bpy.data.objects.get("Camera")
        if fallback is not None and fallback.type == "CAMERA":
            scene.camera = fallback

    if scene.camera is None:
        raise RuntimeError("No camera available for rendering.")

    return scene.camera


def viewport_shading_type(shading_name):
    if shading_name == "wireframe":
        return "WIREFRAME"
    if shading_name == "solid":
        return "SOLID"
    if shading_name == "material-preview":
        return "MATERIAL"
    if shading_name == "rendered":
        return "RENDERED"
    raise RuntimeError(f'Unsupported viewport shading "{shading_name}".')


def ensure_camera(scene, camera_object_name, camera_settings_name):
    camera_object = bpy.data.objects.get(camera_object_name)
    if camera_object is not None and camera_object.type != "CAMERA":
        raise RuntimeError(f'Object "{camera_object_name}" exists but is not a camera.')

    if camera_object is None:
        camera_data = bpy.data.cameras.new(camera_settings_name)
        camera_object = bpy.data.objects.new(camera_object_name, camera_data)
        scene.collection.objects.link(camera_object)
    else:
        camera_data = camera_object.data

    if not camera_object.users_collection:
        scene.collection.objects.link(camera_object)

    if camera_object.data and camera_object.data.name != camera_settings_name:
        camera_object.data.name = camera_settings_name

    return camera_object


def copy_camera_settings(target_camera, source_camera):
    target_data = target_camera.data
    source_data = source_camera.data

    target_data.type = source_data.type
    target_data.lens = float(source_data.lens)
    target_data.sensor_width = float(source_data.sensor_width)
    target_data.sensor_height = float(source_data.sensor_height)
    target_data.clip_start = float(source_data.clip_start)
    target_data.clip_end = float(source_data.clip_end)
    if hasattr(source_data, "ortho_scale"):
        target_data.ortho_scale = float(source_data.ortho_scale)


def align_camera_to_view(viewport, camera_object):
    space = viewport["space"]
    region_3d = viewport["region_3d"]
    scene = viewport["scene"]

    scene.camera = camera_object
    bpy.context.view_layer.objects.active = camera_object

    source_camera = getattr(space, "camera", None)
    if source_camera is not None and source_camera.type == "CAMERA":
        copy_camera_settings(camera_object, source_camera)

    camera_object.matrix_world = region_3d.view_matrix.inverted()

    if region_3d.view_perspective == "ORTHO":
        camera_object.data.type = "ORTHO"
        camera_object.data.ortho_scale = max(0.1, float(region_3d.view_distance) * 2.0)
    else:
        if camera_object.data.type != "PANO":
            camera_object.data.type = "PERSP"
        if source_camera is None and hasattr(space, "lens"):
            camera_object.data.lens = float(space.lens)

    bpy.context.view_layer.update()


def ensure_requested_blend_open(request):
    requested_blend_path = os.path.abspath(request["blendPath"])
    if not os.path.exists(requested_blend_path):
        raise RuntimeError(f'Workspace blend file does not exist: "{requested_blend_path}".')

    current_blend_path = os.path.abspath(bpy.data.filepath) if bpy.data.filepath else ""
    if current_blend_path == requested_blend_path:
        return requested_blend_path

    if bpy.data.is_dirty:
        current_label = current_blend_path or "the current unsaved Blender scene"
        raise RuntimeError(
            f'Blender has unsaved changes in {current_label}. Save or discard them before vibe-blender can switch to "{requested_blend_path}".'
        )

    bpy.ops.wm.open_mainfile(filepath=requested_blend_path)
    loaded_blend_path = os.path.abspath(bpy.data.filepath) if bpy.data.filepath else ""
    if loaded_blend_path != requested_blend_path:
        raise RuntimeError(
            f'Failed to open requested workspace blend "{requested_blend_path}". Blender is still showing "{loaded_blend_path or "an unsaved scene"}".'
        )

    return requested_blend_path


def handle_open_blend(request):
    requested_blend_path = ensure_requested_blend_open(request)
    return {
        "blendPath": requested_blend_path,
    }


def handle_reload_blend(request):
    """
    Reload the requested blend from disk, discarding in-memory changes.

    Used by blender_module_revert after it copies a pre-run checkpoint over
    model.blend: the live session still holds the pre-revert state in memory,
    so a plain "already open this path" check would never pick the checkpoint up.

    Two cases that used to be mishandled:
      * If the session already shows this exact path, the old code re-saved the
        dirty file and then re-opened it — which persisted the very changes a
        revert was trying to discard, and then loaded those same changes back.
        Now a same-path reload re-reads from disk with no save.
      * The unsaved-changes guard belongs to a *switch* to a different file.
        A reload is an explicit request to throw local changes away, so asking
        the user to save first is backwards; only warn, and say what was lost.
    """
    requested_blend_path = os.path.abspath(request["blendPath"])
    if not os.path.exists(requested_blend_path):
        raise RuntimeError(f'Workspace blend file does not exist: "{requested_blend_path}".')

    current_blend_path = os.path.abspath(bpy.data.filepath) if bpy.data.filepath else ""
    same_blend = current_blend_path == requested_blend_path

    discarded_unsaved = bool(bpy.data.is_dirty)
    if discarded_unsaved and not same_blend:
        current_label = current_blend_path or "the current unsaved Blender scene"
        raise RuntimeError(
            f'Blender has unsaved changes in {current_label}. Save or discard them before vibe-blender can switch to "{requested_blend_path}".'
        )

    if discarded_unsaved:
        print(
            f'[vibe-blender] reload-blend: discarding unsaved changes in "{current_blend_path or "unsaved scene"}"'
        )

    bpy.ops.wm.open_mainfile(filepath=requested_blend_path)
    loaded_blend_path = os.path.abspath(bpy.data.filepath) if bpy.data.filepath else ""
    if loaded_blend_path != requested_blend_path:
        raise RuntimeError(
            f'Failed to open requested workspace blend "{requested_blend_path}". Blender is still showing "{loaded_blend_path or "an unsaved scene"}".'
        )

    return {
        "blendPath": requested_blend_path,
        "reloaded": True,
        "discardedUnsavedChanges": discarded_unsaved,
    }


def handle_capture_view(request):
    ensure_requested_blend_open(request)

    viewport = find_viewport_context()
    scene = viewport["scene"]
    camera_object_name = request["cameraObjectName"]
    camera_settings_name = request.get("cameraSettingsName") or f"{camera_object_name}.settings"
    camera_object = ensure_camera(scene, camera_object_name, camera_settings_name)

    with bpy.context.temp_override(
        window=viewport["window"],
        screen=viewport["screen"],
        area=viewport["area"],
        region=viewport["region"],
        space_data=viewport["space"],
        scene=scene,
    ):
        align_camera_to_view(viewport, camera_object)

    scene.camera = camera_object
    bpy.ops.wm.save_mainfile()

    return {
        "viewName": request["viewName"],
        "cameraObjectName": camera_object.name,
        "cameraSettingsName": camera_object.data.name if camera_object.data else None,
        "activeCameraName": scene.camera.name if scene.camera else None,
        "blendPath": bpy.data.filepath,
    }


def handle_execute_python(request):
    requested_blend_path = ensure_requested_blend_open(request)
    save_before_path = request.get("saveBeforePath")
    if save_before_path:
        bpy.ops.wm.save_mainfile()
        # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
        os.makedirs(os.path.dirname(save_before_path), exist_ok=True)
        shutil.copyfile(requested_blend_path, save_before_path)

    globals_dict = {
        "__name__": "__main__",
        "OUTPUT_BLEND_PATH": requested_blend_path,
        "WORKSPACE_PATH": request["workspacePath"],
        "ITERATION_PATH": request["iterationPath"],
    }
    stdout_buffer = io.StringIO()
    stderr_buffer = io.StringIO()
    exit_code = 0

    previous_cwd = os.getcwd()
    workspace_path = request.get("workspacePath")
    if workspace_path:
        os.chdir(workspace_path)

    with contextlib.redirect_stdout(stdout_buffer), contextlib.redirect_stderr(stderr_buffer):
        try:
            with open(request["userScriptPath"], encoding="utf-8") as handle:
                code = handle.read()
            # pi-lens-ignore: ast-grep:no-compile-call, S102, eval-exec
            exec(compile(code, request["userScriptPath"], "exec"), globals_dict)
            if request.get("saveAfter", True):
                bpy.ops.wm.save_mainfile()
        except Exception:
            exit_code = 1
            traceback.print_exc()
        finally:
            os.chdir(previous_cwd)

    return {
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "exitCode": exit_code,
        "changed": exit_code == 0,
    }


def handle_render(request):
    ensure_requested_blend_open(request)

    viewport = find_viewport_context()
    scene = viewport["scene"]
    view_source = request.get("viewSource", "camera")
    viewport_shading = viewport_shading_type(request.get("viewportShading", "material-preview"))
    camera_object = ensure_render_camera(scene, request.get("cameraName")) if view_source == "camera" else None
    resolution = request.get("resolution") or {}

    scene.render.resolution_x = int(resolution.get("x", scene.render.resolution_x))
    scene.render.resolution_y = int(resolution.get("y", scene.render.resolution_y))
    scene.render.resolution_percentage = int(resolution.get("percentage", scene.render.resolution_percentage))

    samples = request.get("samples")
    if samples is not None and hasattr(scene, "cycles"):
        scene.cycles.samples = int(samples)

    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    output_path = request["outputPath"]
    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = output_path

    with bpy.context.temp_override(
        window=viewport["window"],
        screen=viewport["screen"],
        area=viewport["area"],
        region=viewport["region"],
        space_data=viewport["space"],
        scene=scene,
    ):
        space = viewport["space"]
        region_3d = viewport["region_3d"]
        previous_shading_type = space.shading.type
        previous_show_overlays = space.overlay.show_overlays
        previous_perspective = region_3d.view_perspective
        previous_view_camera = getattr(space, "camera", None)
        try:
            space.overlay.show_overlays = False
            space.shading.type = viewport_shading
            if view_source == "camera":
                space.camera = camera_object
                region_3d.view_perspective = "CAMERA"
            bpy.ops.render.opengl(write_still=True, view_context=True)
        finally:
            space.overlay.show_overlays = previous_show_overlays
            space.shading.type = previous_shading_type
            region_3d.view_perspective = previous_perspective
            if previous_view_camera is not None and previous_view_camera.type == "CAMERA":
                space.camera = previous_view_camera

    return {
        "outputPath": output_path,
        "cameraName": scene.camera.name if scene.camera else None,
        "resolution": {
            "x": int(scene.render.resolution_x),
            "y": int(scene.render.resolution_y),
            "percentage": int(scene.render.resolution_percentage),
        },
    }


def set_mode_request(request):
    ensure_requested_blend_open(request)

    target_mode = request["mode"]
    object_name = request.get("objectName")

    if object_name:
        target_object = bpy.data.objects.get(object_name)
        if target_object is None:
            raise RuntimeError(f'Object "{object_name}" was not found.')
    else:
        target_object = bpy.context.view_layer.objects.active
        if target_object is None:
            raise RuntimeError("No active object to switch mode for. Pass objectName explicitly.")

    is_uv_mode = target_mode == "UV"
    target_blender_mode = "EDIT_MESH" if is_uv_mode else target_mode

    paint_modes = {"TEXTURE_PAINT", "VERTEX_PAINT", "WEIGHT_PAINT", "FACE_PAINT", "SCULPT", "EDIT_MESH"}
    armature_modes = {"POSE", "EDIT_ARMATURE"}
    if target_blender_mode == "EDIT_MESH" and target_object.type != "MESH":
        raise RuntimeError(f'Object "{target_object.name}" is not a mesh; {target_mode} requires a mesh.')
    if target_mode in paint_modes - {"EDIT_MESH"} and target_object.type != "MESH":
        raise RuntimeError(f'Object "{target_object.name}" is not a mesh; cannot enter {target_mode}.')
    if target_mode in armature_modes and target_object.type != "ARMATURE":
        raise RuntimeError(f'Object "{target_object.name}" is not an armature; cannot enter {target_mode}.')

    viewport = find_viewport_context()
    scene = viewport["scene"]
    uv_editor_shown = False

    with bpy.context.temp_override(
        window=viewport["window"],
        screen=viewport["screen"],
        area=viewport["area"],
        region=viewport["region"],
        space_data=viewport["space"],
        scene=scene,
        object=target_object,
        active_object=target_object,
        selected_objects=[target_object],
    ):
        if bpy.context.mode != target_blender_mode:
            bpy.ops.object.mode_set(mode=target_blender_mode)

    if is_uv_mode:
        overlay = viewport["space"].overlay
        overlay.show_uv_editor = True
        uv_editor_shown = True

    return {
        "mode": target_mode,
        "blenderMode": bpy.context.mode,
        "objectName": target_object.name,
        "uvEditorOverlay": uv_editor_shown,
        "blendPath": bpy.data.filepath,
    }


def handle_get_session_context(_request):
    viewport = find_optional_viewport_context()
    scene = viewport["scene"] if viewport is not None else bpy.context.scene
    active_object = bpy.context.view_layer.objects.active if bpy.context.view_layer else bpy.context.active_object
    selected_objects = [object_ref(obj) for obj in bpy.context.selected_objects]

    return {
        "blendPath": bpy.data.filepath if bpy.data.filepath else None,
        "isSaved": bool(bpy.data.filepath),
        "isDirty": bool(bpy.data.is_dirty),
        "scene": {
            "name": scene.name if scene else None,
            "availableScenes": [candidate.name for candidate in bpy.data.scenes],
            "frameCurrent": int(scene.frame_current) if scene else None,
            "activeCameraName": scene.camera.name if scene and scene.camera else None,
        },
        "selection": {
            "activeObject": object_ref(active_object),
            "selectedObjects": [obj for obj in selected_objects if obj is not None],
            "selectedObjectCount": len(selected_objects),
        },
        "mode": {
            "mode": bpy.context.mode if hasattr(bpy.context, "mode") else None,
            "activeObjectType": active_object.type if active_object is not None else None,
        },
        "viewport": summarize_viewport(viewport),
    }


GEOMETRY_PROBE_CHECKS = (
    "transform",
    "bounds",
    "axis",
    "pair",
    "topology",
)
GEOMETRY_PROBE_VERTEX_SAMPLE_LIMIT = 4000
# Relative slack for the in-contact threshold, so float noise cannot flip the
# verdict for parts that are exactly at the requested tolerance.
PAIR_TOLERANCE_EPSILON = 1e-9


def _round(value, digits=5):
    return round(float(value), digits)


def _round_vector(vector):
    return [_round(component) for component in vector]


def _resolve_probe_objects(names):
    """Resolve probe targets to objects, defaulting to every visible mesh.

    An empty name list means "look at the whole scene", because a misplaced
    handle is usually found by its relationship to the body, and the analyst
    often does not yet know which object is the culprit.
    """
    if names:
        targets = []
        for name in names:
            target = bpy.data.objects.get(name)
            if target is None:
                raise RuntimeError(f'Object "{name}" was not found in the live scene.')
            targets.append(target)
        return targets

    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]


def _world_vertices(obj, limit=GEOMETRY_PROBE_VERTEX_SAMPLE_LIMIT):
    """World-space vertices, evenly subsampled above `limit`.

    Probing every vertex of a subdivided mesh would blow the analyst's
    context; an even stride keeps the spatial distribution of the shape, which
    is what gap/penetration measurements actually depend on.
    """
    total = len(obj.data.vertices)
    stride = max(1, total // limit)
    coords = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices[::stride]]
    if coords and stride > 1:
        coords.append(obj.matrix_world @ obj.data.vertices[-1].co)
    return coords


def _world_bounding_box(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    maximum = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return minimum, maximum


def _covariance_eigen_extremes(points):
    """Return (largest, smallest) principal directions of a point cloud.

    Both extremes matter, and getting the *smallest* one right is the whole
    point: a ring/torus is degenerate in its own in-plane axes while its ring
    axis is the uniquely thin direction, so the smallest principal direction is
    the only measurement that reliably says "this is a ring, and it faces this
    way". That is the measurement behind `thinAxisAngleToExpected`.

    Power iteration finds the LARGEST eigenvector and can never find the
    smallest one — it always converges away from it. An earlier version therefore
    seeded a second power iteration with a space axis to hunt for the thin
    direction, and returned a large, wrong axis for exactly the ring shapes this
    function exists to measure (verified against a rotated torus: it reported
    the ring axis 90 degrees off, with thickness 0.021 instead of 0.0035).

    So the leading direction comes from power iteration, the remaining
    orthonormal pair is built geometrically, and each eigenvalue is read off as
    a Rayleigh quotient. For a symmetric matrix the other two eigenvectors lie
    exactly in the plane perpendicular to the leading one, which makes this
    exact rather than iterative.
    """
    count = len(points)
    if count < 3:
        return None, None, 0.0, 0.0

    center = Vector((sum(p.x for p in points) / count, sum(p.y for p in points) / count, sum(p.z for p in points) / count))
    centered = [p - center for p in points]
    covariance = Matrix(
        [
            [sum(p[i] * p[j] for p in centered) / count for j in range(3)]
            for i in range(3)]
    )

    def rayleigh(axis):
        return (covariance @ axis).dot(axis)

    leading = Vector((1.0, 0.0, 0.0))
    leading.normalize()
    for _ in range(64):
        projected = covariance @ leading
        if projected.length < 1e-12:
            return None, None, 0.0, 0.0
        projected.normalize()
        if (projected - leading).length < 1e-9:
            leading = projected
            break
        leading = projected

    # Complete an orthonormal basis around the leading direction.
    second = None
    for seed in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)):
        candidate = Vector(seed)
        candidate = candidate - leading * candidate.dot(leading)
        if candidate.length > 1e-6:
            second = candidate.normalized()
            break
    if second is None:
        # Every space axis is parallel to `leading`: a line-like cloud with no
        # meaningful thin direction to report.
        return None, None, 0.0, 0.0
    third = leading.cross(second)

    values = (rayleigh(leading), rayleigh(second), rayleigh(third))
    if values[1] <= values[2]:
        smallest, smallest_value = second, values[1]
    else:
        smallest, smallest_value = third, values[2]
    return leading, smallest, values[0], smallest_value


def _angle_degrees_between(first, second):
    dot = max(-1.0, min(1.0, first.normalized().dot(second.normalized())))
    return _round(math.degrees(math.acos(dot)), 2)


RING_ROUNDNESS_BINS = 16


def _ring_roundness(points, axis, center):
    """Separate a ring's TUBE from a ring's WARP.

    A single (max - min) / mean radius cannot tell those apart, and the old
    docstring claiming "0 = perfect circle" was wrong: a solid torus whose tube
    has radius `minor` on a ring of radius `major` spans major-minor to
    major+minor, so a geometrically perfect ring already reads about
    2*minor/major (0.4 for a typical handle). Reading that as deformation would
    have the diagnostician chasing a shape defect that does not exist.

    So radius is binned by angle around the ring axis. Within one bin the
    radius only varies by the tube; between bins it varies by the warp. That
    separates "this ring is a fat tube" (benign, expected) from "this ring is
    squashed or dragged out of plane" (a real shape defect), and gives the
    analyst a number that is actually near zero for a correct handle.
    """
    distances = []
    angles = []
    # Orthonormal frame spanning the plane perpendicular to the ring axis.
    basis_a = None
    for seed in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)):
        candidate = Vector(seed)
        candidate = candidate - axis * candidate.dot(axis)
        if candidate.length > 1e-6:
            basis_a = candidate.normalized()
            break
    if basis_a is None:
        return {"available": False, "reason": "ring axis is degenerate; cannot bin by angle"}
    basis_b = axis.cross(basis_a)

    for point in points:
        offset = point - center
        radial = offset - axis * offset.dot(axis)
        distance = radial.length
        if distance <= 1e-9:
            continue
        angle = math.atan2(radial.dot(basis_b), radial.dot(basis_a))
        distances.append(distance)
        angles.append(angle % (2.0 * math.pi))

    if not distances:
        return {"available": False, "reason": "no radial samples"}

    mean = sum(distances) / len(distances)
    if mean <= 1e-9:
        return {"available": False, "reason": "degenerate ring radius"}

    bins: list[list[float]] = [[] for _ in range(RING_ROUNDNESS_BINS)]
    # strict: both lists are appended in this one loop under the same
    # guard, so a length mismatch would be a logic error, not a truncation.
    for distance, angle in zip(distances, angles, strict=True):
        index = min(RING_ROUNDNESS_BINS - 1, int(angle / (2.0 * math.pi) * RING_ROUNDNESS_BINS))
        bins[index].append(distance)

    bin_means = [sum(b) / len(b) for b in bins if b]
    if len(bin_means) < 2:
        return {"available": False, "reason": "too few populated angular bins to measure warp"}

    # Warp: how much the ring's radius changes as you go AROUND it.
    warp_spread = (max(bin_means) - min(bin_means)) / mean
    # Tube: how much the radius changes WITHIN one angular bin. Benign.
    within = [
        (max(b) - min(b)) / mean
        for b in bins
        if len(b) > 1
    ]
    tube_spread = max(within) if within else 0.0

    return {
        "available": True,
        "radialMean": _round(mean),
        "radialSpread": _round((max(distances) - min(distances)) / mean),
        "bins": len(bin_means),
        "warpRatio": _round(warp_spread, 4),
        "tubeRatio": _round(tube_spread, 4),
        "maxDeviation": _round(max(abs(m - mean) for m in bin_means), 5),
    }


def _signed_distance_to_surface(point, target_bvh):
    """Signed distance from `point` to the target surface (negative = inside).

    Uses the standard BVH nearest-point normal test: the point is inside when
    the vector from the surface back to the point opposes the face normal.
    Cheaper and far more stable than a ray-parity test on arbitrary meshes.
    """
    location, normal, _index, distance = target_bvh.find_nearest(point)
    if location is None:
        return None
    if (point - location).dot(normal) < 0.0:
        return -distance
    return distance


def _probe_pair_geometry(first, second, tolerance):
    """Measure the relationship between two objects.

    This is the measurement that answers the classic structural error: a
    handle that is floating off the body, buried inside it, or touching only
    at one edge. Returns a verdict plus the numbers behind it so the analyst
    reports a measurement, not an impression.
    """
    first_bvh = BVHTree.FromPolygons(
        [first.matrix_world @ v.co for v in first.data.vertices],
        [list(poly.vertices) for poly in first.data.polygons],
        all_triangles=False,
        epsilon=0.0,
    )
    second_bvh = BVHTree.FromPolygons(
        [second.matrix_world @ v.co for v in second.data.vertices],
        [list(poly.vertices) for poly in second.data.polygons],
        all_triangles=False,
        epsilon=0.0,
    )

    first_points = _world_vertices(first)
    second_points = _world_vertices(second)

    first_to_second = [d for d in (_signed_distance_to_surface(p, second_bvh) for p in first_points) if d is not None]
    second_to_first = [d for d in (_signed_distance_to_surface(p, first_bvh) for p in second_points) if d is not None]
    both = first_to_second + second_to_first

    if not both:
        return {"verdict": "unknown", "reason": "no surface distance samples available"}

    first_inside = sum(1 for d in first_to_second if d < 0.0)
    second_inside = sum(1 for d in second_to_first if d < 0.0)
    inside_count = first_inside + second_inside
    deepest = min(both)
    closest = min(d for d in both if d >= 0.0) if any(d >= 0.0 for d in both) else None

    first_min, first_max = _world_bounding_box(first)
    second_min, second_max = _world_bounding_box(second)
    overlap = [
        _round(min(first_max[i], second_max[i]) - max(first_min[i], second_min[i]), 5)
        for i in range(3)
    ]

    if inside_count > 0:
        verdict = "interpenetrating"
    elif closest is not None and closest <= tolerance * (1.0 + PAIR_TOLERANCE_EPSILON) + PAIR_TOLERANCE_EPSILON:
        # Compare with a relative epsilon, not bare `<=`. A gap that measures
        # exactly the tolerance lands at 0.0020000000000000018 against a
        # tolerance of 0.002, so the strict comparison reported "separated"
        # for parts that are touching at the threshold the analyst asked for.
        # The epsilon is far below any tolerance anyone sets, and it biases
        # toward "in-contact" -- the verdict a human acting on the number
        # wants at the boundary, rather than a coin toss.
        verdict = "in-contact"
    else:
        verdict = "separated"

    return {
        "verdict": verdict,
        "tolerance": _round(tolerance),
        "closestSurfaceDistance": _round(closest) if closest is not None else None,
        "deepestPenetration": _round(-deepest) if deepest < 0.0 else 0.0,
        "verticesInsideTarget": {
            first.name: first_inside,
            second.name: second_inside,
        },
        "sampledVertexCount": {
            first.name: len(first_points),
            second.name: len(second_points),
        },
        "boundingBoxOverlap": {"x": overlap[0], "y": overlap[1], "z": overlap[2]},
    }


def _probe_topology(obj):
    """Non-manifold / loose / duplicate geometry counts for one mesh.

    Counts only: the analyst needs to know a defect exists and how bad it is,
    and full mesh data would swamp its context. A duplicate-face or
    non-manifold-edge count is the reliable signal that a shape is not the
    solid the analyst thinks it is.
    """
    try:
        # pi-lens-ignore: ast-grep:unresolved-import-python
        import bmesh  # pyright: ignore[reportMissingImports]
    except ImportError:
        return {"available": False, "reason": "bmesh unavailable in this Blender build"}

    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.verts.ensure_lookup_table()
    bm.edges.ensure_lookup_table()
    bm.faces.ensure_lookup_table()

    non_manifold = sum(1 for edge in bm.edges if len(edge.link_faces) != 2)
    boundary = sum(1 for edge in bm.edges if len(edge.link_faces) == 1)
    loose_verts = sum(1 for vert in bm.verts if not vert.link_edges)
    loose_edges = sum(1 for edge in bm.edges if not edge.link_faces)
    degenerate = sum(1 for face in bm.faces if face.calc_area() < 1e-12)

    seen = set()
    duplicates = 0
    for vert in bm.verts:
        key = tuple(_round(component, 5) for component in vert.co)
        if key in seen:
            duplicates += 1
        else:
            seen.add(key)

    bm.free()
    return {
        "available": True,
        "vertices": len(mesh.vertices),
        "edges": len(mesh.edges),
        "faces": len(mesh.polygons),
        "nonManifoldEdges": non_manifold,
        "boundaryEdges": boundary,
        "looseVertices": loose_verts,
        "looseEdges": loose_edges,
        "degenerateFaces": degenerate,
        "duplicateVertices": duplicates,
    }


def handle_geometry_probe(request):
    """Measure mesh/transform relationships in the LIVE scene.

    Read-only by construction: it builds BVHs and reads vertex coordinates,
    and never mutates or saves. That is what makes it safe for a diagnostician
    to call while the manager has a worker mid-iteration.
    """
    requested = request.get("checks") or list(GEOMETRY_PROBE_CHECKS)
    unknown = [check for check in requested if check not in GEOMETRY_PROBE_CHECKS]
    if unknown:
        raise RuntimeError(
            f"Unknown geometry probe check(s): {', '.join(unknown)}. "
            f"Available: {', '.join(GEOMETRY_PROBE_CHECKS)}"
        )

    tolerance = float(request.get("tolerance") or 0.002)
    expected_axis = request.get("expectedAxis") or "Z"
    axis_vector = Vector(
        {
            "X": (1.0, 0.0, 0.0),
            "Y": (0.0, 1.0, 0.0),
            "Z": (0.0, 0.0, 1.0),
        }[str(expected_axis).upper()]
    )

    targets = _resolve_probe_objects(request.get("objects") or [])
    if not targets:
        raise RuntimeError("No mesh objects to probe. Pass `objects` explicitly if the scene is empty or filtered.")

    measurements = {}
    for obj in targets:
        entry = {"type": obj.type, "name": obj.name}
        if obj.type != "MESH":
            measurements[obj.name] = entry
            continue

        minimum, maximum = _world_bounding_box(obj)
        entry["bounds"] = {
            "min": _round_vector(minimum),
            "max": _round_vector(maximum),
            "size": _round_vector(maximum - minimum),
            "center": _round_vector((minimum + maximum) * 0.5),
        }

        if "transform" in requested:
            matrix = obj.matrix_world
            # matrix_world.to_scale() is NOT the object's scale: for a rotation
            # applied after a single-axis mirror it returns all three components
            # negative, and for a 180-degree rotation it returns all three
            # negative too. Measured: scale (1,-1,1) with no rotation reported
            # (-1,-1,-1), which would blame the wrong two axes. The 3x3's column
            # lengths are the actual per-axis scale; the determinant's sign is
            # what carries the mirror, so recover it there instead.
            basis = matrix.to_3x3()
            column_scale = [basis.col[i].length for i in range(3)]
            determinant = basis.determinant()
            mirrored = determinant < 0.0
            if mirrored:
                # One axis is flipped; to_scale() cannot say which, so report
                # the mirror as a boolean and keep the column lengths as the
                # per-axis magnitudes.
                column_scale = [abs(component) for component in column_scale]
            entry["transform"] = {
                "location": _round_vector(matrix.translation),
                "rotationEulerDegrees": _round_vector([_round(math.degrees(angle), 2) for angle in matrix.to_euler()]),
                "scale": _round_vector(column_scale),
                "parent": obj.parent.name if obj.parent is not None else None,
                "unappliedScale": any(abs(component - 1.0) > 1e-4 for component in column_scale),
                "mirrorScale": mirrored,
                "minZ": _round(minimum.z),
            }

        if "axis" in requested:
            points = _world_vertices(obj)
            largest, smallest, largest_value, smallest_value = _covariance_eigen_extremes(points)
            if smallest is None:
                entry["axis"] = {"available": False, "reason": "fewer than 3 sampled vertices"}
            else:
                center = Vector((sum(p.x for p in points) / len(points), sum(p.y for p in points) / len(points), sum(p.z for p in points) / len(points)))
                entry["axis"] = {
                    "available": True,
                    "thinAxis": _round_vector(smallest),
                    "thinAxisAngleToExpected": _angle_degrees_between(smallest, axis_vector),
                    "longAxis": _round_vector(largest),
                    "longAxisAngleToExpected": _angle_degrees_between(largest, axis_vector),
                    "expectedAxis": str(expected_axis).upper(),
                    # Rayleigh quotient, so it is the RMS radius perpendicular to
                    # the thin axis. A torus cross-section is a disc of radius
                    # `minor`, whose variance is minor^2/2, so this reads
                    # minor/sqrt(2) -- NOT the 2*minor full width, and not
                    # minor/sqrt(3) (that is a uniform-radius sphere).
                    "thickness": _round(smallest_value ** 0.5),
                    "thicknessNote": "RMS radius perpendicular to thinAxis (minor/sqrt(2) for a torus), not the full width.",
                    "radius": _round(largest_value ** 0.5),
                    "axisRatio": _round(smallest_value / largest_value, 5) if largest_value > 0 else None,
                    "isRingLike": largest_value > 0 and smallest_value / largest_value < 0.05,
                    "ringRoundness": _ring_roundness(points, smallest, center),
                    "center": _round_vector(center),
                }

        if "topology" in requested:
            entry["topology"] = _probe_topology(obj)

        measurements[obj.name] = entry

    pairs = {}
    if "pair" in requested:
        pair_names = request.get("pairs")
        if pair_names:
            for pair in pair_names:
                first_name, second_name = pair[0], pair[1]
                first = bpy.data.objects.get(first_name)
                second = bpy.data.objects.get(second_name)
                if first is None or second is None:
                    raise RuntimeError(f'Pair references a missing object: "{first_name}", "{second_name}".')
                if first.type != "MESH" or second.type != "MESH":
                    raise RuntimeError(f'Pair references a non-mesh object: "{first_name}", "{second_name}".')
                pairs[f"{first_name}|{second_name}"] = _probe_pair_geometry(first, second, tolerance)
        elif len(targets) == 2:
            pairs[f"{targets[0].name}|{targets[1].name}"] = _probe_pair_geometry(targets[0], targets[1], tolerance)

    return {
        "blendPath": bpy.data.filepath if bpy.data.filepath else None,
        "isDirty": bool(bpy.data.is_dirty),
        "checks": requested,
        "tolerance": _round(tolerance),
        "unitNote": "Blender units; 1.0 = 1 m by default.",
        "objects": measurements,
        "pairs": pairs,
    }


def handle_request(request):
    request_type = request.get("type")
    if request_type == "get-session-context":
        return handle_get_session_context(request)
    if request_type == "geometry-probe":
        return handle_geometry_probe(request)
    if request_type == "open-blend":
        return handle_open_blend(request)
    if request_type == "reload-blend":
        return handle_reload_blend(request)
    if request_type == "capture-view":
        return handle_capture_view(request)
    if request_type == "execute-python":
        return handle_execute_python(request)
    if request_type == "render":
        return handle_render(request)
    if request_type == "set-mode":
        return set_mode_request(request)
    raise RuntimeError(f"Unsupported Blender bridge request type: {request_type}")


def process_request_file(request_path):
    request_id = os.path.splitext(os.path.basename(request_path))[0]

    # Claim the request atomically before reading it. os.replace is atomic
    # within one filesystem, so exactly one poller succeeds and every other
    # poller gets FileNotFoundError here and moves on. Without this, two
    # Blenders sharing a bridge dir both open the file, both exec, and both
    # write a response - so the scene is mutated twice and which UI answers is
    # a race.
    claim_path = os.path.join(CLAIMS_DIR, f"{request_id}.json")
    try:
        os.replace(request_path, claim_path)
    except OSError:
        # Already claimed by another poller, or removed by the writer.
        return

    try:
        with open(claim_path, encoding="utf-8") as handle:
            request = json.load(handle)
        result = handle_request(request)
        write_response(request_id, {"ok": True, "result": result})
    except Exception as error:
        write_response(
            request_id,
            {
                "ok": False,
                "error": str(error),
                "traceback": traceback.format_exc(),
            },
        )
    finally:
        with contextlib.suppress(OSError):
            os.remove(claim_path)


def touch_heartbeat():
    # The TS launch guard treats a stale/missing heartbeat as "the UI is
    # gone" and re-spawns Blender, so this must be refreshed every poll
    # cycle.
    path = os.path.join(BRIDGE_DIR, "heartbeat")
    try:
        os.utime(path)
    except OSError:
        # First poll of a fresh bridge dir: create the file, then touch it.
        try:
            with open(path, "w", encoding="utf-8"):
                pass
            os.utime(path)
        except OSError:
            pass


def poll_requests():
    ensure_bridge_dirs()
    touch_heartbeat()

    try:
        request_files = sorted(os.listdir(REQUESTS_DIR))
    except OSError:
        request_files = []

    for file_name in request_files:
        if not file_name.endswith(".json"):
            continue
        process_request_file(os.path.join(REQUESTS_DIR, file_name))

    return POLL_INTERVAL_SECONDS


ensure_bridge_dirs()
recover_orphaned_claims()
if not bpy.app.timers.is_registered(poll_requests):
    bpy.app.timers.register(poll_requests, first_interval=POLL_INTERVAL_SECONDS, persistent=True)
