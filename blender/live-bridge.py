import contextlib
import io
import json
import math
import os
import shutil
import sys
import time
import traceback

# --python does not put the script's own directory on sys.path in every Blender
# build, and the read-only guard sits beside this file.
_BRIDGE_DIR_ON_PATH = os.path.dirname(os.path.abspath(__file__))
if _BRIDGE_DIR_ON_PATH not in sys.path:
    sys.path.insert(0, _BRIDGE_DIR_ON_PATH)

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]

# mathutils ships with Blender's Python runtime, so pyright cannot resolve it
# outside a Blender environment — same as the bpy import above.
from mathutils import Matrix, Vector  # pyright: ignore[reportMissingImports]
from mathutils.bvhtree import BVHTree  # pyright: ignore[reportMissingImports]

from fingerprint import content_changed, snapshot

# Sits beside this file so a read-only run is refused in the bridge rather than
# in the prompt that asked for it.
# pi-lens-ignore: ast-grep:unresolved-import-python
from readonly_guard import ReadOnlyViolation, read_only_run  # pyright: ignore[reportMissingImports]

# The orbit angles and the tiling, so a sheet can be composed without either
# being rebuilt per caller.
# pi-lens-ignore: ast-grep:unresolved-import-python
import montage  # pyright: ignore[reportMissingImports]

# The interchange exporters. Separate for the same reason as montage: the format
# table and the sanitising are separable from request plumbing.
# pi-lens-ignore: ast-grep:unresolved-import-python
import export_asset  # pyright: ignore[reportMissingImports]

BRIDGE_DIR = os.environ.get("PI_BLENDER_BRIDGE_DIR") or os.path.join(
    # Same XDG convention config.ts uses for its own default. This is only
    # reached when Blender was started BY HAND with --python live-bridge.py and
    # with neither bridge var set, because launch.ts always passes
    # PI_BLENDER_BRIDGE_DIR explicitly. That case is a footgun worth naming:
    # the pi side would keep reading
    # $XDG_CACHE_HOME/pi-blender/bridge/<instance-id>, so a UI beating here
    # is invisible to it and every tool call reports a plain 30s timeout rather
    # than "no UI is running". Hence the warning below.
    os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache"),
    "pi-blender",
    "bridge",
)
# The per-instance scratch blank that blank-bootstrap.py opens this session on.
# launch.ts passes it in the environment (PI_BLENDER_BLANK_BLEND_PATH), and
# config.ts derives the identical default, so this is the same path Node side
# means by getBlankBlendPath(). It is a THROWAWAY file by construction:
# blank-bootstrap.py deletes every object in it and re-saves it unconditionally
# on each launch, so nothing in it is ever worth keeping. The script needs to
# know that, because it otherwise applies the same precious-work guard to the
# blank as to a user's model.blend — see ensure_requested_blend_open.
#
# Compared as normalised absolute paths, because this arrives as a string from
# the environment and may be relative, "~"-prefixed, or carry a redundant
# trailing separator, while the other side is already os.path.abspath()'d.
def resolve_blank_blend_path():
    raw = os.environ.get("PI_BLENDER_BLANK_BLEND_PATH")
    if not raw or not raw.strip():
        return None
    expanded = os.path.expanduser(raw.strip())
    if not os.path.isabs(expanded):
        expanded = os.path.join(os.getcwd(), expanded)
    return os.path.abspath(expanded)


BLANK_BLEND_PATH = resolve_blank_blend_path()


def is_discardable_scratch_blend(blend_path):
    """True if `blend_path` is this session's throwaway blank, not real work.

    The answer to "may I throw away the unsaved changes in this file?" is yes
    for the blank, because the next launch overwrites it from scratch anyway,
    and no for everything else, because a workspace model.blend may hold the
    only copy of someone's work. An empty current path (an unsaved, never-saved
    scene) is also treated as discardable: there is no file to lose.

    With no blank path in the environment (a Blender started outside the
    extension) this returns False for every real file, i.e. the old
    conservative behaviour.
    """
    if not blend_path:
        return True
    return bool(BLANK_BLEND_PATH) and blend_path == BLANK_BLEND_PATH


REQUESTS_DIR = os.path.join(BRIDGE_DIR, "requests")
RESPONSES_DIR = os.path.join(BRIDGE_DIR, "responses")
# A request is moved here by whichever poller wins the atomic rename, so a
# second Blender polling the same bridge dir can never execute it too.
CLAIMS_DIR = os.path.join(BRIDGE_DIR, "claims")
POLL_INTERVAL_SECONDS = 0.5
# Set by handle_shutdown. Read by process_request_file only AFTER the response
# has been written, so the caller always gets its answer before the UI dies.
PENDING_QUIT = False


def request_quit_after_response():
    """Quit this Blender once the current response is safely on disk.

    bpy.ops.wm.quit_blender is not instantaneous in effect: the poll loop that
    called it is mid-tick, and the process is torn down from the main loop. The
    timer defers it by a full poll interval so the response file is closed and
    the poller has returned before the window disappears.
    """
    bpy.app.timers.register(_quit_now, first_interval=POLL_INTERVAL_SECONDS)


def _quit_now():
    bpy.ops.wm.quit_blender()
    # `return None` is load-bearing, not decoration. bpy.app.timers treats a
    # None return as "do not run this timer again" and any truthy return as
    # "reschedule in that many seconds". A truthy return here would re-register
    # the quit every frame, so ruff's RET501/PLR1711 ("useless return") is a
    # false positive on this line -- the return IS the result the timer reads.
    return None


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


def render_override(viewport, scene, **extra):
    """bpy.context override for an engine render, with a window if there is one.

    A background Blender has no window, screen, area or region to override, and
    passing None for them makes the override context manager fail on an argument
    the caller did not choose. So the override carries whatever exists: the full
    set in a windowed session, and just the scene headless. Either way the render
    itself is the same call with the same settings — which is the point of
    routing a windowed request through this file at all.
    """
    context = {"scene": scene}
    if viewport is not None:
        context.update(
            {
                "window": viewport["window"],
                "screen": viewport["screen"],
                "area": viewport["area"],
                "region": viewport["region"],
                "space_data": viewport["space"],
            }
        )
    context.update(extra)
    return bpy.context.temp_override(**context)


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

    if bpy.data.is_dirty and not is_discardable_scratch_blend(current_blend_path):
        current_label = current_blend_path or "the current unsaved Blender scene"
        raise RuntimeError(
            f'Blender has unsaved changes in {current_label}. Save or discard them before pi-blender can switch to "{requested_blend_path}".'
        )

    if bpy.data.is_dirty:
        # Discarding the blank is not data loss, it is the blank's normal life:
        # it is regenerated from nothing on the next launch. Refusing here used
        # to make the per-instance UI permanently unusable — the first open of a
        # workspace marks the blank dirty, and from then on every switch was
        # blocked until something killed the Blender, which the supervisor then
        # relaunched. That relaunch-on-a-refusal loop is what looked like the
        # extension "opening Blender again", so switching away from the scratch
        # blank is allowed and the leftover state is simply dropped.
        print(
            f'[pi-blender] discarding unsaved changes in scratch blank "{current_blend_path or "unsaved scene"}"'
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
    if discarded_unsaved and not same_blend and not is_discardable_scratch_blend(current_blend_path):
        current_label = current_blend_path or "the current unsaved Blender scene"
        raise RuntimeError(
            f'Blender has unsaved changes in {current_label}. Save or discard them before pi-blender can switch to "{requested_blend_path}".'
        )

    if discarded_unsaved:
        print(
            f'[pi-blender] reload-blend: discarding unsaved changes in "{current_blend_path or "unsaved scene"}"'
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
    changed = False
    before = snapshot(bpy)

    def sample_change():
        """Record whether this execution changed the scene's content.

        Sampled immediately after exec returns, and again when it raises, so a
        mutation made before the exception still counts. Content hashes rather
        than `bpy.data.is_dirty`: that flag is a UI-facing notion of unsaved
        work, it reads False in background mode, and reading it after the save
        would report the file clean precisely when the run did the most work.
        """
        nonlocal changed
        if not changed and content_changed(before, snapshot(bpy)):
            changed = True

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
            sample_change()
            if request.get("saveAfter", True):
                bpy.ops.wm.save_mainfile()
        except Exception:
            sample_change()
            exit_code = 1
            traceback.print_exc()
        finally:
            os.chdir(previous_cwd)

    return {
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "exitCode": exit_code,
        "changed": changed,
    }


def handle_read_only_python(request):
    """Run a measurement script with the mutating half of bpy refused.

    The refusal is installed in the bridge, not in the prompt, because a role
    boundary held only in a system prompt is a suggestion: the script decides
    whether to honour it. Nothing is saved, so a refused run leaves model.blend
    exactly as the bridge found it even if the script got far enough to change
    something in memory.
    """
    ensure_requested_blend_open(request)
    globals_dict = {
        "__name__": "__main__",
        "bpy": bpy,
        "OUTPUT_BLEND_PATH": bpy.data.filepath,
        "WORKSPACE_PATH": request["workspacePath"],
        "ITERATION_PATH": request["iterationPath"],
        "READ_ONLY": True,
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
            with read_only_run(bpy):
                # pi-lens-ignore: ast-grep:no-compile-call, S102, eval-exec
                exec(compile(code, request["userScriptPath"], "exec"), globals_dict)
        except ReadOnlyViolation as violation:
            # A refusal is the answer, not a crash: the script asked something
            # out of scope, and the caller needs to be told what it asked.
            exit_code = 2
            print(str(violation))
        except Exception:
            exit_code = 1
            traceback.print_exc()
        finally:
            os.chdir(previous_cwd)

    return {
        "stdout": stdout_buffer.getvalue(),
        "stderr": stderr_buffer.getvalue(),
        "exitCode": exit_code,
        "readOnly": True,
    }


def handle_render(request):
    ensure_requested_blend_open(request)

    viewport = find_viewport_context()
    scene = viewport["scene"]
    view_source = request.get("viewSource", "camera")
    viewport_shading = viewport_shading_type(request.get("viewportShading", "material-preview"))

    # Every one of these is scene state, and a render is not a preview: unlike
    # the viewport settings below, the values set here survive the call and are
    # then written into model.blend by the next execute-python's save_mainfile().
    # That is how a 400x300 scratch render used to leave the user's model at
    # 400x300, JPEG-flipped, with the render camera still assigned as
    # scene.camera -- a silent, permanent edit to their work caused by asking
    # for a look at it. Snapshot and restore instead; a render is read-only
    # with respect to the file it is asked to photograph.
    render_settings = scene.render
    previous_scene_camera = scene.camera
    previous_resolution = (
        render_settings.resolution_x,
        render_settings.resolution_y,
        render_settings.resolution_percentage,
    )
    previous_file_format = render_settings.image_settings.file_format
    previous_filepath = render_settings.filepath
    previous_cycles_samples = scene.cycles.samples if hasattr(scene, "cycles") else None

    # Assigned before the try, so the response never depends on control flow
    # that a failed render may have skipped.
    output_path = request["outputPath"]
    camera_object = None
    result = None

    try:
        camera_object = ensure_render_camera(scene, request.get("cameraName")) if view_source == "camera" else None
        resolution = request.get("resolution") or {}

        render_settings.resolution_x = int(resolution.get("x", render_settings.resolution_x))
        render_settings.resolution_y = int(resolution.get("y", render_settings.resolution_y))
        render_settings.resolution_percentage = int(
            resolution.get("percentage", render_settings.resolution_percentage)
        )

        samples = request.get("samples")
        if samples is not None and previous_cycles_samples is not None:
            scene.cycles.samples = int(samples)

        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        render_settings.image_settings.file_format = "PNG"
        render_settings.filepath = output_path

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

        # Read the render's own values for the response while the overridden
        # settings are still in place.
        result = {
            "outputPath": output_path,
            "cameraName": camera_object.name if camera_object is not None else None,
            "resolution": {
                "x": int(render_settings.resolution_x),
                "y": int(render_settings.resolution_y),
                "percentage": int(render_settings.resolution_percentage),
            },
        }
    finally:
        # Restore on the outer try, not the inner one: a render that throws
        # partway through must not leave the user's file modified either.
        scene.camera = previous_scene_camera
        (
            render_settings.resolution_x,
            render_settings.resolution_y,
            render_settings.resolution_percentage,
        ) = previous_resolution
        render_settings.image_settings.file_format = previous_file_format
        render_settings.filepath = previous_filepath
        if previous_cycles_samples is not None and hasattr(scene, "cycles"):
            scene.cycles.samples = previous_cycles_samples

    return result


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
    "joint",
    "clearance",
    "path",
    "pair",
    "shape",
    "topology",
    "scale",
)
GEOMETRY_PROBE_VERTEX_SAMPLE_LIMIT = 4000
# The shape family is a summary, not a dump: it reports counts, a few scalars
# and a short profile, so the sample cap has to be generous enough for the
# symmetry and convexity averages to be stable without pulling a 200k-vertex
# mesh through every loop.
GEOMETRY_PROBE_SHAPE_SAMPLE_LIMIT = 20000
# Convexity is a nearest-surface-point query per sampled vertex, so it is
# measured on its own coarser sample. 1000 vertices is where the ratio stops
# visibly drifting on a deliberately lumpy mesh.
GEOMETRY_PROBE_CONVEXITY_VERTEX_LIMIT = 1000
# A vertex of a genuinely convex mesh lies ON its hull, so the tolerance is
# float noise on a scale of the mesh's own size, not a modelling tolerance.
GEOMETRY_PROBE_CONVEXITY_EPSILON = 1e-5
SHAPE_PROFILE_SAMPLES = 8
# A deviation below this fraction of the mesh's size is float noise on a
# mirrored mesh, not an asymmetry, so it is reported as a ratio and the mirror
# axis is still named.
SHAPE_SYMMETRY_EPSILON = 1e-4
# Relative slack for the in-contact threshold, so float noise cannot flip the
# verdict for parts that are exactly at the requested tolerance.
PAIR_TOLERANCE_EPSILON = 1e-9
# Vertices sampled per island when measuring the gap between islands. The gap is
# the pair measurement, and a 66-island railing would otherwise be the expensive
# check in a scene census; 256 per side is far finer than any modelling slip
# that would hide between the samples.
ISLAND_GAP_SAMPLE_VERTS = 256
# An island whose nearest other island is farther away than this fraction of its
# OWN size is floating free rather than built to meet it. Dimensionless on
# purpose: the same 25 mm is a seam on a 2.65 m plank and a canyon on a 0.3 m
# bollard, so no absolute millimetre threshold can serve both.
ISLAND_FLOATING_RATIO = 0.05


def _as_int(value, field, default=None):
    """An int from a JSON field, or a default, naming the field on a bad value.

    Every numeric request field reaches here as whatever the caller sent, so
    `int()` on it is a ValueError waiting for a typo -- and the raw exception
    names neither the field nor the tool, which is the one thing a caller needs.
    A bare default is not an answer either: `tolerance: "0.05"` is a plausible
    mistake, and silently measuring at the default would report numbers the
    caller never asked for.
    """
    if value is None:
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"`{field}` must be a whole number, got {value!r}") from None


def _as_float(value, field, default=None):
    """A float from a JSON field, or a default, naming the field on a bad value."""
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(f"`{field}` must be a number, got {value!r}") from None


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

    Two things here are correctness, not taste, and both were measured against
    a real Blender rather than reasoned about:

    The stride is applied by INDEX, not by slice. `vertices[::stride]` raises
    `TypeError: bpy_prop_collection[slice]: slice steps not supported` in
    Blender 5.2, so the sampling only ever ran on meshes at or under the limit
    (`stride == 1`, and a step of 1 is not a step). The first mesh over
    GEOMETRY_PROBE_VERTEX_SAMPLE_LIMIT -- measured with an 8066-vertex UV
    sphere -- took the whole geometry probe down with that TypeError, which is
    the exact case the subsampling exists to handle.

    The last vertex is appended only when the stride did NOT already sample it.
    The intent is "an even sample, plus the last vertex so the extreme is not
    lost", and `stride > 1` was standing in for that: it happens to be right
    whenever the last index is not a multiple of the stride, and it silently
    counts the last vertex TWICE when it is (8000 vertices at a limit of 4000
    samples every index the stride reaches). Comparing the index to the stride
    states the intent, so the count is `total // stride` or `total // stride + 1`
    and never the same vertex twice.
    """
    total = len(obj.data.vertices)
    stride = max(1, total // limit)
    sampled = range(0, total, stride)
    coords = [obj.matrix_world @ obj.data.vertices[index].co for index in sampled]
    if total > 0 and (total - 1) % stride != 0:
        coords.append(obj.matrix_world @ obj.data.vertices[total - 1].co)
    return coords


# How close a vertex must be to the other object's SURFACE to count as lying
# on it. Deliberately far tighter than the contact tolerance: "these two are in
# contact" tolerates a 2mm joint, and this asks the opposite question -- are
# two surfaces so close they are indistinguishable, which is the z-fighting
# case. A tolerance borrowed from the contact check would call every flush
# joint a defect, which is precisely the noise this avoids.
COINCIDENT_EPSILON = 0.0001
# How much of one object has to lie on the other before coincidence is even
# considered: a vertex count floor, and a share of the mesh. The count floor
# is what separates two panels lying on top of each other from a bolt head
# resting flush on a wall; the share floor is what separates a coincidence
# from a handful of stray vertices touching a surface they were fitted to.
COINCIDENT_MIN_VERTICES = 8
COINCIDENT_MIN_SHARE = 0.15


def _coincident_surface(first, second, first_bvh, second_bvh, first_points, second_points, shared_min, shared_max):
    """How much of one object lies ON the other's surface.

    Two objects sharing a stretch of surface render with COLOUR BANDING --
    z-fighting, the depth buffer picking one of them per pixel and the shading
    flipping between the two. No existing check sees it: the pair check
    reports a CONTACT verdict, which is what a clean flush abutment reports
    too, and the joint sweep skips every pair that is in contact precisely so
    the healthy joints cannot bury a detached one. A flush-laid panel is
    therefore invisible from both directions, and it is the defect a house
    built from pieces produces when a panel is laid on a wall instead of
    abutting it.

    The signed distances behind those verdicts get a coplanar pair wrong too,
    and it is worth knowing that rather than reading the numbers: the
    inside/outside sign comes from ray parity, which is arbitrary when two
    surfaces lie in one plane, so two coincident panels came back reporting a
    half-metre `deepestPenetration` while touching nowhere. That is a
    property of the measurement, not a second finding, and this figure is the
    one to read.

    Every count is taken INSIDE the two objects' shared bounding box, and the
    share is of the vertices inside that box rather than of the whole mesh.
    That denominator is the whole design, and the first version got it wrong:
    a panel laid on a wall covers a fraction of the wall, so measured against
    the wall's 81 vertices the panel's 12 touching ones came to 14.8% and
    missed a 15% floor -- the cleanest case of the defect failing to report.
    What the question actually asks is whether a stretch of ONE surface lies
    on the other, and every vertex of that stretch is inside the overlap, so
    the box is both the right scope and the right denominator.

    Symmetric on purpose. A vertex of one object lying on the other's surface
    is one-sided evidence: a wall has plenty of vertices near any part resting
    against it, while the part has only a few near the wall's span. The
    smaller count and the smaller share are judged, so coincidence has to be
    mutual before it is called one -- and a genuinely coplanar overlap is
    mutual by construction, since both panels carry vertices spread across the
    strip they share. The cost is a SMALL coincidence on a large mesh being
    missed, which is the conservative direction.

    Shares are of the vertices inside the shared box, which are counted first
    and reported, so a reader can see the denominator instead of trusting a
    ratio whose base is invisible. An empty or near-empty box cannot report a
    coincidence however close the surfaces are: two objects that share no
    space at all have no vertices inside the intersection, and treating a
    denominator of zero as "everything is coincident" is how a tolerance
    turns into noise.
    """
    epsilon = COINCIDENT_EPSILON
    first_shared = []
    for point in first_points:
        if all(shared_min[axis] - epsilon <= point[axis] <= shared_max[axis] + epsilon for axis in range(3)):
            first_shared.append(point)
    second_shared = []
    for point in second_points:
        if all(shared_min[axis] - epsilon <= point[axis] <= shared_max[axis] + epsilon for axis in range(3)):
            second_shared.append(point)

    first_hits = 0
    for point in first_shared:
        location, _normal, _index, distance = second_bvh.find_nearest(point)
        if location is not None and distance <= epsilon:
            first_hits += 1
    second_hits = 0
    for point in second_shared:
        location, _normal, _index, distance = first_bvh.find_nearest(point)
        if location is not None and distance <= epsilon:
            second_hits += 1

    first_total = len(first_shared)
    second_total = len(second_shared)
    first_share = (first_hits / first_total) if first_total else 0.0
    second_share = (second_hits / second_total) if second_total else 0.0
    smaller_count = min(first_hits, second_hits)
    smaller_share = min(first_share, second_share)
    return {
        "epsilon": _round(epsilon),
        "firstVertices": first_hits,
        "secondVertices": second_hits,
        "firstShare": _round(first_share, 4),
        "secondShare": _round(second_share, 4),
        "smallerCount": smaller_count,
        "smallerShare": _round(smaller_share, 4),
        "sharedVertices": {first.name: first_total, second.name: second_total},
        "isCoincident": smaller_count >= COINCIDENT_MIN_VERTICES
        and smaller_share >= COINCIDENT_MIN_SHARE,
    }


def _world_bounding_box(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    maximum = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return minimum, maximum


def _world_thinnest(obj, points=None):
    """The object's own SMALLEST world extent, in metres.

    Used as the denominator of the buried measure, and it is a world-axis
    extent rather than a principal axis on purpose. A principal axis follows
    the object when it is rotated -- a door lying flat would report its
    diagonal as its thin dimension and read as shallowly buried -- whereas a
    world extent is the same number a person measures with a tape, so "buried
    900 mm into a 40 mm door" reads the same whichever way the door points.

    `_world_vertices` rather than `bound_box` for the same reason: a rotated
    object's local bounding box corners transform into a LARGER world box, and
    a rotation would inflate the very dimension the measure divides by.
    """
    world_points = _world_vertices(obj) if points is None else points
    if not world_points:
        return None
    spans = []
    for axis in range(3):
        values = [point[axis] for point in world_points]
        spans.append(max(values) - min(values))
    smallest = min(spans)
    # A degenerate object -- a plane, a single polygon -- has no thickness to
    # be buried relative to, so it is reported as absent rather than as zero,
    # which would divide by nothing and produce an infinity.
    return smallest if smallest > 1e-6 else None


def _buried_depth(depth_inside, depth_outside, first, second, first_points, second_points):
    """How deep one object sits inside the other, in units of its OWN thickness.

    `interpenetrating` is one word for two unrelated situations: a railing post
    set 2 mm into a deck, which is how the joint is built, and a door buried
    900 mm inside a 40 mm wall, which is a wall built through a door. Both are
    interpenetrating, so the boolean cannot tell a working construction from a
    swallowed part, and any threshold in absolute metres fails the moment the
    asset changes scale -- the same 5 cm is a healthy overlap on a railing post
    and an invisible sliver on a bridge deck.

    Dividing by the BURIED part's own thinnest extent makes the measure
    scale-free, so one threshold serves a 4 cm door and a 4 m pier. The rule is
    the arithmetic of intent: a part sinks into another a little so the joint
    reads as solid, and sinks into it entirely when the modeller placed the two
    without noticing. Whichever part is deeper inside is the one reported,
    because that is the one that vanished.
    """
    entries = []
    for depth, obj, points, other_name, other in (
        (depth_inside, first, first_points, second.name, second),
        (depth_outside, second, second_points, first.name, first),
    ):
        if depth <= 0.0:
            continue
        thickness = _world_thinnest(obj, points)
        own_min, own_max = _world_bounding_box(obj)
        own_extent = max(own_max[axis] - own_min[axis] for axis in range(3))
        other_min, other_max = _world_bounding_box(other)
        other_extent = max(other_max[axis] - other_min[axis] for axis in range(3))
        # A part swallowed BY something is a part placed into it, and a thing
        # you place into something else is smaller than the thing that holds
        # it. Two surfaces of comparable size that overlap are LAYERS -- a
        # ground plane and a pond floor, a deck and a lawn -- not a swallow,
        # and without this the pond reports the grass above it as buried.
        #
        # Measured on a real 243-object scene, this is the line between the
        # findings and the artifacts: a 0.1 m part inside a 0.5 m block is 5x
        # and is a swallow, while two ground layers of near-equal extent
        # overlap by construction and are not.
        relative = other_extent / own_extent if own_extent > 0.0 else None
        entries.append(
            {
                "buriedObject": obj.name,
                "buriedIn": other_name,
                "depth": _round(depth),
                "thickness": _round(thickness) if thickness is not None else None,
                "depthVsThickness": _round(depth / thickness) if thickness is not None else None,
                "relativeSize": _round(relative) if relative is not None else None,
            }
        )
    if not entries:
        return None
    entries.sort(
        key=lambda entry: entry["depthVsThickness"] if entry["depthVsThickness"] is not None else -1.0
    )
    return entries[-1]


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

    first_min, first_max = _world_bounding_box(first)
    second_min, second_max = _world_bounding_box(second)
    shared_min = [max(first_min[axis], second_min[axis]) for axis in range(3)]
    shared_max = [min(first_max[axis], second_max[axis]) for axis in range(3)]
    overlap = [
        _round(min(first_max[i], second_max[i]) - max(first_min[i], second_min[i]), 5)
        for i in range(3)
    ]

    if not both:
        # The coincidence figure is still computable here: it asks only
        # whether vertices lie ON a surface, which is what find_nearest
        # answers, while the signed distances that produced `both` could not
        # be sampled. Returning the key is the point -- a caller reading
        # coincidentSurface must not have to know which of two return shapes
        # it got.
        return {
            "verdict": "unknown",
            "reason": "no surface distance samples available",
            "tolerance": _round(tolerance),
            "coincidentSurface": _coincident_surface(
                first, second, first_bvh, second_bvh, first_points, second_points, shared_min, shared_max
            ),
            "buried": None,
        }

    first_inside = sum(1 for d in first_to_second if d < 0.0)
    second_inside = sum(1 for d in second_to_first if d < 0.0)
    inside_count = first_inside + second_inside
    deepest = min(both)
    closest = min(d for d in both if d >= 0.0) if any(d >= 0.0 for d in both) else None

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
        "coincidentSurface": _coincident_surface(
            first, second, first_bvh, second_bvh, first_points, second_points, shared_min, shared_max
        ),
        "buried": _buried_depth(
            -min(first_to_second) if first_inside else 0.0,
            -min(second_to_first) if second_inside else 0.0,
            first,
            second,
            first_points,
            second_points,
        ),
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


# How close two bounding boxes must come before a separated pair is worth
# reporting at all. Past this the two objects are simply PLACED near each
# other -- a chair pulled up to a table, a step beside a plinth -- and
# reporting them is the false positive that would train an analyst to ignore
# the list.
JOINT_NEAR_MISS_MAX = 0.05

# ---------------------------------------------------------------- clearance --
#
# The free-floor measure. Everything else this module reports is a fault in
# the JOIN: two things that should meet and do not, or do too much. This one
# is about the space BETWEEN things -- furniture standing in the only route
# across a room -- and it is the fault class a render cannot show, because a
# room with a sofa across the foot of a window photographs exactly like a room
# without one.
#
# The measure is deliberately the SIMPLEST one that can be computed from the
# scene alone: a 2D occupancy raster of the floor, one cell per CLEARANCE_CELL
# metres, with each object stamped as a footprint. It cannot know what a person
# intends to walk, so it does not claim to. What it can do is state the two
# numbers a room is judged on -- how much floor is free, and how wide the
# biggest connected free space is -- which are exactly the numbers that
# collapse when furniture is placed first and circulation second.
#
# Connected-component labelling rather than a distance transform, because the
# question is "can you get from here to there", and that is a question about
# connectivity rather than about width. The WIDTH of the narrowest link in the
# path is not reported, because computing it needs a distance transform over
# every cell and the honest failure mode there is a number nobody trusts.
CLEARANCE_CELL = 0.05
# Below this, an object is not furniture and does not block anything: dust,
# a ceiling fitting seen in plan, a wall's own skirting. Reported, so the caller
# can see what was ignored rather than discovering it in the difference.
CLEARANCE_IGNORE_MAX_EXTENT = 0.05
# A footprint is its object's world bounding box. That is generous for a
# diagonal object -- a round table reads as a square, so a person could walk
# through its corner and the raster would call it blocked -- which biases
# toward REPORTING a blockage, the safe direction for a number a human is
# about to act on.
#
# Standing height, because a rug and a ceiling rose are on the floor in a
# top-down projection and neither is an obstruction. A room's own walls,
# ceiling and floor are excluded by name shape rather than by height, because
# a shell wall is 2.4 m tall and belongs to the room's BOUNDS, not to its
# contents; the room is measured by its own extent, so a shell object's
# footprint would otherwise fill the entire floor with "furniture".
CLEARANCE_OBSTRUCTION_HEIGHT = 1.9
# How much of the room's own footprint a horizontal surface must cover to be
# that room's floor rather than a wall standing on it. Generous, because the
# alternative -- stamping a floor as an obstruction -- reports every room as
# entirely blocked, which reads as "cannot sample" rather than as a mistake.
CLEARANCE_FLOOR_SHARE = 0.8
CLEARANCE_SHELL_HINTS = ("wall", "floor", "ceiling", "roof", "slab", "shell", "room")
# The radius of a person, and the one number the whole measure turns on. A
# gap narrower than this is inside the reach of a shoulder, so it is not a way
# through; a gap wider than it is. 0.25 m is a person's half-width including a
# held arm, which is the width that has to fit past a door and round a corner.
CLEARANCE_BODY_RADIUS = 0.25
# 4 million cells is 64 MB of bytearrays, which is fine, and is also 20 m square
# at 1 cm -- finer than the raster's own quantisation is worth. Past this the
# answer is "pass fewer objects", not a coarser guess presented as a number.
CLEARANCE_MAX_SAMPLES = 4_000_000


def _clearance_raster(meshes, cell, radius, include_shell):
    """One floor raster, shared by every check that reasons about walking.

    Returns the grid plus everything a caller needs to interpret a number read
    off it: the cell, the stride, the origin, the room's extent, and the
    `blocked` mask. `include_shell` decides whether walls are stamped.

    The two checks want OPPOSITE answers from the same room, which is why this
    is one function with a flag rather than two rasterisers that could drift.
    `clearance` measures free floor, and a wall is not furniture in the room --
    stamping it would shrink the floor of every room by its own perimeter and
    then again by the dilation. `path` measures the walk from one door to
    another, and there a wall is the entire subject: a path that ignores walls
    goes through them. The floor and the room's own extent are shared, so both
    checks see the same world at the same resolution.

    A refusal is returned rather than raised, and carries `refused: True` so the
    caller can strip the marker and return the reason as its own answer: the
    clearance check reports a refusal as a `sampled: False` payload, because a
    room too big to sample is a fact about the room.
    """
    minima = []
    maxima = []
    for obj in meshes:
        minimum, maximum = _world_bounding_box(obj)
        minima.append(minimum)
        maxima.append(maximum)
    room_min = Vector((min(v.x for v in minima), min(v.y for v in minima), 0.0))
    room_max = Vector((max(v.x for v in maxima), max(v.y for v in maxima), 0.0))
    # The floor level, taken as the lowest surface in the room rather than
    # assumed to be z=0: an imported house often sits at its own origin, and a
    # test of "is this above head height" is only meaningful relative to the
    # floor somebody actually stands on.
    floor_z = min(v.z for v in minima)
    span_x = room_max.x - room_min.x
    span_y = room_max.y - room_min.y

    # Samples go on a stride rather than at every grid cell, because each one
    # is stamped with a dilated box spanning 2R and a dense grid would spend
    # the whole budget re-blocking the same patch. The stride is the sample's
    # own extent, so neighbouring samples do not overlap and coverage is
    # uniform across the room.
    reach = max(1, int(math.ceil(radius / cell)))
    step = reach * 2 * cell + cell

    # The first sample is one body-radius in from the room's edge: a person
    # standing against the wall is still standing in the room, and sampling the
    # wall line itself would report every room as blocked along its perimeter.
    usable_x = span_x - 2.0 * radius
    usable_y = span_y - 2.0 * radius
    if usable_x < 0.0 or usable_y < 0.0:
        return {
            "refused": True,
            "reason": (
                f"the probed extent is {span_x:.2f} x {span_y:.2f} m, which is narrower than the "
                f"{_round(radius * 2.0)} m a body of radius {_round(radius)} m needs. Pass a smaller `body`."
            ),
            "extent": {"x": _round(span_x), "y": _round(span_y)},
            "cellSize": _round(cell),
            "bodyRadius": _round(radius),
        }

    origin = Vector((room_min.x + radius, room_min.y + radius, 0.0))
    columns = int(math.floor(usable_x / step)) + 1
    rows = int(math.floor(usable_y / step)) + 1
    if columns < 1 or rows < 1:
        return {
            "refused": True,
            "reason": (
                f"the probed extent is {span_x:.2f} x {span_y:.2f} m, which holds no sample point at "
                f"a {step:.2f} m stride. Pass a smaller `body`."
            ),
            "extent": {"x": _round(span_x), "y": _round(span_y)},
            "cellSize": _round(cell),
            "bodyRadius": _round(radius),
        }
    if columns * rows > CLEARANCE_MAX_SAMPLES:
        return {
            "refused": True,
            "reason": (
                f"the probed extent is {span_x:.1f} x {span_y:.1f} m, which is {columns * rows} "
                f"samples, over the {CLEARANCE_MAX_SAMPLES} ceiling. Pass fewer objects -- one room "
                "at a time is usually the right scope, since the measure cannot tell a room from "
                "the house around it."
            ),
            "extent": {"x": _round(span_x), "y": _round(span_y)},
            "cellSize": _round(cell),
            "bodyRadius": _round(radius),
        }

    blocked = bytearray(columns * rows)
    shell = bytearray(columns * rows)
    ignored = []
    for obj, minimum, maximum in zip(meshes, minima, maxima, strict=True):
        extent = maximum - minimum
        if max(extent.x, extent.y) <= CLEARANCE_IGNORE_MAX_EXTENT:
            ignored.append(obj.name)
            continue
        lowered = obj.name.lower()
        is_shell = any(hint in lowered for hint in CLEARANCE_SHELL_HINTS)
        if is_shell and not include_shell:
            # A shell wall defines the room's boundary; stamping it as
            # furniture would report every room as blocked along its perimeter
            # and then again by the dilation. The room is measured by its own
            # extent, so a shell object's footprint must not count.
            continue
        if minimum.z - floor_z > CLEARANCE_OBSTRUCTION_HEIGHT:
            # Its UNDERSIDE is above head height: a ceiling rose, a hanging
            # lamp, a beam, an upper shelf. Not an obstruction to somebody
            # walking, and counting it would shrink the free floor of a room
            # that is entirely clear.
            #
            # The test is the bottom, not the height. A wall is 2.5 m tall --
            # the ordinary height of a wall -- and testing height would skip
            # every wall in the house, leaving the walk free to pass straight
            # through them, which is the whole reason `include_shell` exists.
            # What distinguishes a wall from a lamp is that a wall reaches the
            # floor and a lamp does not.
            continue
        # A floor and a wall are both named like a shell, and stamping a floor
        # as a wall blocks the entire room -- including when the caller asked
        # for walls to be stamped. The name is a weak signal and the geometry is
        # an exact one: a horizontal surface whose footprint is the room IS the
        # room's floor, whatever it is called. A wall bounds the room; the floor
        # IS the room, so it is excluded from both masks and never a target.
        if is_shell and extent.x * extent.y >= CLEARANCE_FLOOR_SHARE * span_x * span_y:
            ignored.append(obj.name)
            continue
        # Dilate: a sample is blocked when an obstruction is within a body's
        # reach, so the stamped region grows by the radius in every direction.
        x0 = int(math.ceil((minimum.x - radius - origin.x) / step))
        x1 = int(math.floor((maximum.x + radius - origin.x) / step))
        y0 = int(math.ceil((minimum.y - radius - origin.y) / step))
        y1 = int(math.floor((maximum.y + radius - origin.y) / step))
        target = shell if is_shell else blocked
        for ix in range(max(0, x0), min(columns - 1, x1) + 1):
            for iy in range(max(0, y0), min(rows - 1, y1) + 1):
                target[ix * rows + iy] = 1

    return {
        "columns": columns,
        "rows": rows,
        "step": step,
        "origin": origin,
        "roomMin": room_min,
        "roomMax": room_max,
        "floorArea": span_x * span_y,
        "extent": {"x": _round(span_x), "y": _round(span_y)},
        "cellSize": _round(cell),
        "bodyRadius": _round(radius),
        "blocked": blocked,
        "shell": shell,
        "ignored": ignored,
    }


def _clearance_components(grid, mask):
    """Connected components of free samples, and the free samples themselves.

    Shared by `clearance` and `path` because both need the same decomposition
    and because a flood fill written twice is a flood fill that will disagree
    about what "reachable" means. Returns `(component_sizes_by_index, free
    total)` where the sizes are in samples, not square metres.
    """
    columns = grid["columns"]
    rows = grid["rows"]
    blocked = mask
    free_total = 0
    for index in range(columns * rows):
        if not blocked[index]:
            free_total += 1

    visited = bytearray(columns * rows)
    queue = []
    for ix in range(columns):
        for iy in (0, rows - 1):
            index = ix * rows + iy
            if not blocked[index]:
                queue.append(index)
    for iy in range(rows):
        for ix in (0, columns - 1):
            index = ix * rows + iy
            if not blocked[index]:
                queue.append(index)

    component_sizes = []
    while queue:
        start = queue.pop()
        if visited[start]:
            continue
        size = 0
        stack = [start]
        visited[start] = 1
        while stack:
            index = stack.pop()
            size += 1
            ix, iy = index // rows, index % rows
            for neighbour in ((ix + 1, iy), (ix - 1, iy), (ix, iy + 1), (ix, iy - 1)):
                nx, ny = neighbour
                if not (0 <= nx < columns and 0 <= ny < rows):
                    continue
                other = nx * rows + ny
                if blocked[other] or visited[other]:
                    continue
                visited[other] = 1
                stack.append(other)
        component_sizes.append(size)
    return component_sizes, free_total


def _probe_clearance(objects, cell=None, body=None):
    """Free floor area, and the widest single free region in it.

    Everything here is derived, never asked for: the room's bounds are the
    union of the objects probed, and the obstructions are the ones standing on
    the floor. A caller that wants a different notion of "the room" passes the
    objects that define it, which is why the measure takes the same `objects`
    argument the rest of the probe does.

    The core of the measure is a BODY RADIUS, not a grid. Every sample point
    stands for a person, and each is blocked if any obstruction comes within
    `body` of it, so a sample is free only where somebody could actually
    stand.

    That radius is the whole design, and it came from a fixture that caught the
    obvious version failing. A plain occupancy raster -- cells blocked by
    whatever covers them -- reports a room cut in two by a sofa with a 50 mm
    gap at each end as ONE free region, because a flood fill walks through a
    one-cell gap as readily as through a metre. Measured: a sofa spanning
    5.9 m of a 6 m room, gaps of 50 mm, read `islandCount: 1` and
    `unreachableArea: 0.0`, which is precisely the fault this measure exists
    to report and precisely the answer it gave. The same sofa with 500 mm
    either side also read 1, so the number could not tell a blocked room from a
    clear one. Dilating the obstructions by the radius of a person fixes both,
    because 50 mm is inside the reach of a shoulder and 500 mm is not.

    Dilating a box means stamping it into the sample grid as a box GREATER
    than the box, and that is why this returns an honest area rather than an
    exact one: a sample represents the square of ground around it, so the
    reported free area is a count of samples and over-counts the open edge of
    the room by up to one stride. The isolation figures -- which regions exist,
    which are unreachable, how big each is -- are the ones to act on, because
    they answer a question about points rather than about square metres.

    Returns None when there is no room to measure, and a refusal with a reason
    when the sample would be too coarse to mean anything -- a 40 m hall is
    7k samples, but a garden is four million -- rather than quietly reporting a
    number nobody can act on.
    """
    cell = CLEARANCE_CELL if cell is None else cell
    if cell <= 0.0:
        raise ValueError(f"`cell` must be greater than zero, got {cell!r}")
    radius = CLEARANCE_BODY_RADIUS if body is None else body
    if radius < 0.0:
        raise ValueError(f"`body` must be zero or greater, got {radius!r}")

    meshes = [obj for obj in objects if obj.type == "MESH"]
    if not meshes:
        return None

    grid = _clearance_raster(meshes, cell, radius, include_shell=False)
    if grid.get("refused"):
        refusal = {key: value for key, value in grid.items() if key != "refused"}
        refusal["sampled"] = False
        return refusal

    columns = grid["columns"]
    rows = grid["rows"]
    step = grid["step"]
    origin = grid["origin"]
    room_min = grid["roomMin"]
    room_max = grid["roomMax"]
    blocked = grid["blocked"]
    ignored = grid["ignored"]

    # Flood fill the free samples from the sampled grid's own edge, so
    # "reachable" is measured from where a person can actually enter -- the
    # boundary -- rather than from an arbitrary corner that a wall may enclose.
    reachable = bytearray(columns * rows)
    free_total = sum(1 for index in range(columns * rows) if not blocked[index])
    component_sizes = []
    queue = []
    for ix in range(columns):
        for iy in (0, rows - 1):
            index = ix * rows + iy
            if not blocked[index]:
                queue.append(index)
    for iy in range(rows):
        for ix in (0, columns - 1):
            index = ix * rows + iy
            if not blocked[index]:
                queue.append(index)

    while queue:
        start = queue.pop()
        if reachable[start]:
            continue
        size = 0
        stack = [start]
        reachable[start] = 1
        while stack:
            index = stack.pop()
            size += 1
            ix, iy = index // rows, index % rows
            for neighbour in ((ix + 1, iy), (ix - 1, iy), (ix, iy + 1), (ix, iy - 1)):
                nx, ny = neighbour
                if not (0 <= nx < columns and 0 <= ny < rows):
                    continue
                other = nx * rows + ny
                if blocked[other] or reachable[other]:
                    continue
                reachable[other] = 1
                stack.append(other)
        component_sizes.append(size)

    # Two different faults live in these two figures, and conflating them would
    # make both useless. `islandCount` above 1 is reachable free floor in more
    # than one piece: a sofa across a room splits it, and each half may still
    # touch the boundary, so both are reachable and neither is connected to the
    # other -- that is the commonest placement fault and it is measured by the
    # count. `unreachableArea` is the narrower one: a pocket cut off from EVERY
    # edge by a closed ring of furniture, so somebody standing at the door
    # cannot walk to it at all. A cut room has an islandCount above 1 and an
    # unreachableArea of zero; a ringed room has an islandCount of 1 and a
    # positive unreachableArea. Both are worth saying, and neither subsumes
    # the other.
    unreachable = free_total - sum(component_sizes)
    largest = max(component_sizes) if component_sizes else 0
    sample_area = step * step
    floor_area = grid["floorArea"]

    return {
        "sampled": True,
        "cellSize": _round(cell),
        "bodyRadius": _round(radius),
        "stride": _round(step),
        "extent": grid["extent"],
        "floorArea": _round(floor_area, 4),
        "sampleArea": _round(sample_area, 6),
        "sampleCount": columns * rows,
        "freeArea": _round(free_total * sample_area, 4),
        "freeShare": _round((free_total * sample_area) / floor_area, 4) if floor_area > 0 else 0.0,
        "largestFreeArea": _round(largest * sample_area, 4),
        "largestFreeShare": _round((largest * sample_area) / floor_area, 4) if floor_area > 0 else 0.0,
        "islandCount": len(component_sizes),
        "unreachableArea": _round(unreachable * sample_area, 4),
        "ignoredObjects": sorted(ignored),
        "note": (
            "Each sample stands for a person of radius "
            f"{_round(radius)} m and is blocked when an obstruction comes within that reach, which is "
            "why a 50 mm gap reads as blocked and a 500 mm one does not: the difference between them "
            "is the difference between a shoulder and a doorway. An area is therefore a count of "
            f"samples x {_round(sample_area)} m2, so it quantises and over-counts the open edge of "
            "the room by up to one stride; the isolation figures -- which regions exist, which are "
            "unreachable, how large each is -- are the ones to act on. Footprints are bounding boxes, "
            "so a round table reads as the square that bounds it and the free area is understated: "
            "the error is toward calling a room more blocked than it is. Objects above "
            f"whose underside is more than {CLEARANCE_OBSTRUCTION_HEIGHT} m above the floor (a "
            "hanging lamp, a beam, an upper shelf -- a wall does not qualify, because a wall reaches "
            "the floor), as are those under "
            f"{CLEARANCE_IGNORE_MAX_EXTENT} m across and any whose name contains "
            f"{', '.join(CLEARANCE_SHELL_HINTS)} (a shell wall bounds the room, it does not furnish "
            "it). 'islandCount' counts the connected pieces of REACHABLE free floor, so more "
            "than one means furniture has cut the floor into pieces nobody can walk between, "
            "whether or not each piece touches the boundary; "
            "'unreachableArea' is free floor that reaches NO edge at all -- a pocket a person at the "
            "door cannot walk to -- and it is measured as the difference, so a ringed room reports "
            "islandCount 1 and a positive unreachableArea. The measure does NOT know where a door is, "
            "so a room with no door at all reads as one reachable island -- that is judgement, not "
            "geometry."
        ),
    }


# How a door that does not line up is told from a hall that turns a corner.
#
# The defect is a path that zig-zags: you come through one door, turn, turn
# again, and arrive at the next, because somebody placed each room's shell
# against its own origin rather than against a shared axis. Nothing about it is
# broken -- every wall meets, every door exists, every opening is the right
# width -- and it is invisible in a render, because a viewer sees the room and
# not the route through it. What makes it measurable is that a path is longer
# than the straight line between its ends by an amount a person can feel and a
# picture cannot show.
#
# So the measure is a RATIO: the walked distance over the straight-line distance
# between the same two points. 1.0 is a straight corridor, and a right-angle L
# is about 1.27 -- which is why the threshold is set well above 1 rather than
# at 1.01: real architecture bends, and a door that is slightly off a wall is
# what the caller asked to catch, not a hall that turns once.
PATH_DETOUR_DEFAULT = 1.45
# A straight-line distance this small carries no direction to be off from: two
# doors 20 cm apart are a single opening, not a route, and their ratio is
# whatever the quantisation happens to make it.
PATH_MIN_SPAN = 0.5


def _path_straight_line(grid, first, second):
    """Euclidean distance between two samples, in metres, ignoring the raster."""
    return math.hypot((second[0] - first[0]) * grid["step"], (second[1] - first[1]) * grid["step"])


def _path_walk(grid, blocked, start, goal):
    """Shortest walked distance between two samples, or None when unreachable.

    A* on an eight-connected grid, which costs a diagonal `sqrt(2)` and so
    cannot shave a corner the way a flood fill over four-connected cells
    quietly can: on a four-connected grid a staircase's shortest path is
    measurably longer than the staircase, which would inflate exactly the
    number this measure exists to read. The heuristic is the straight-line
    distance in cell units, scaled by sqrt(2) so it never overestimates and
    the search stays admissible.
    """
    columns = grid["columns"]
    rows = grid["rows"]
    diagonals = math.sqrt(2.0)
    # Callers think in (column, row) because a sample came from the snapper as
    # a pair; the search thinks in flat indices because that is what `blocked`
    # is indexed by. Convert once here rather than at every hop.
    first_index = start[0] * rows + start[1]
    goal_index = goal[0] * rows + goal[1]

    def heuristic(index):
        ix, iy = index // rows, index % rows
        return diagonals * math.hypot(ix - goal[0], iy - goal[1])

    # A plain binary heap is more code than this measure warrants, and the
    # frontier here is bounded by the room, so a sorted list with a moving
    # cursor is simpler and measurably fast enough: the pops are O(n) in the
    # worst case but n is the frontier, not the room.
    frontier = [(heuristic(first_index), 0.0, first_index)]
    cost = {first_index: 0.0}
    while frontier:
        frontier.sort(key=lambda entry: entry[0])
        _, walked, current = frontier.pop(0)
        if current == goal_index:
            return walked * grid["step"]
        if walked > cost.get(current, walked):
            continue
        cx, cy = current // rows, current % rows
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                nx, ny = cx + dx, cy + dy
                if not (0 <= nx < columns and 0 <= ny < rows):
                    continue
                # Never cut a corner through a diagonal gap: a cell that is
                # blocked between two free ones is a wall corner, and letting
                # the walk squeeze past it would report a path through a wall.
                if dx and dy:
                    if blocked[cx * rows + ny] or blocked[nx * rows + cy]:
                        continue
                other = nx * rows + ny
                if blocked[other]:
                    continue
                step_cost = diagonals if dx and dy else 1.0
                candidate = walked + step_cost
                if candidate < cost.get(other, float("inf")):
                    cost[other] = candidate
                    frontier.append((candidate + heuristic(other), candidate, other))
    return None


def _path_samples_near(grid, mask, point, radius):
    """Free samples whose centre lies within `radius` metres of a world point.

    The mask is the point of the function. A door centre is given by whoever
    drew the plan, so it lands near the opening as often as in it -- and the
    nearest sample to that number is frequently the one INSIDE the door frame.
    Snapping to the blocked cell would start the walk from inside a wall, and
    the search then reports no route at all, which reads as "this pair is
    fine" rather than as the failure it is.
    """
    columns = grid["columns"]
    rows = grid["rows"]
    origin = grid["origin"]
    step = grid["step"]
    reach = int(math.ceil(radius / step))
    centre_x = (point[0] - origin.x) / step
    centre_y = (point[1] - origin.y) / step
    found = []
    for ix in range(max(0, int(centre_x) - reach), min(columns - 1, int(centre_x) + reach) + 1):
        for iy in range(max(0, int(centre_y) - reach), min(rows - 1, int(centre_y) + reach) + 1):
            if mask[ix * rows + iy]:
                continue
            world_x = origin.x + ix * step
            world_y = origin.y + iy * step
            if math.hypot(world_x - point[0], world_y - point[1]) <= radius:
                found.append((ix, iy))
    return found


def _probe_path(objects, request_points, cell=None, body=None, detour=None, threshold=None):
    """How much longer the walk between two points is than the line between them.

    This is the one architectural defect in this extension that a picture
    genuinely cannot show. Every wall meets, every opening is the right width,
    every room is correct in isolation -- and a person walks a zig-zag from one
    door to the next because each shell was placed against its own origin. The
    render looks like a house. Only the route betrays it.

    The measure is a detour ratio: shortest walked distance over the straight
    line between the same two points. The straight line is a lower bound on any
    path, so the ratio is 1.0 for a corridor and rises with every turn. A
    right-angle L is about 1.27, which is why the default threshold is 1.45:
    real architecture bends once, and the defect asked about here is the
    several-turn stair-step, not the elbow.

    `points` is the caller's list of world positions to measure between -- door
    centres, the ends of a corridor, anywhere a person is meant to travel. Each
    is snapped to the nearest FREE sample within a body's reach, so a point
    given slightly off the exact opening still resolves: a door centre lands as
    often beside its frame as in it, and snapping to the blocked cell instead
    would start the walk from inside a wall and report no route at all, which
    reads as "this pair is fine" rather than as the failure it is. A point that
    finds no free sample is reported as `unresolved` rather than guessed at,
    because a door buried in a solid and a door nobody modelled look identical
    here and only one of them is a layout error.

    The snap has one consequence worth knowing before a number is compared with
    a textbook: a door centre moves into the room, so both the straight line and
    the walk shorten together and the ratio survives, but the absolute ratio of
    an idealised right-angle L comes out nearer 1.08 than 1.27. The ratio is a
    property of the building; its exact value is a property of the raster.

    The grid is built with walls INCLUDED, unlike the clearance check on the
    same scope: a path that ignores walls goes through them. The floor and the
    room's extent are shared, so both checks see the same world at the same
    resolution and neither can drift from the other.
    """
    meshes = [obj for obj in objects if obj.type == "MESH"]
    if not meshes:
        return None
    cell = CLEARANCE_CELL if cell is None else cell
    if cell <= 0.0:
        raise ValueError(f"`cell` must be greater than zero, got {cell!r}")
    radius = CLEARANCE_BODY_RADIUS if body is None else body
    if radius < 0.0:
        raise ValueError(f"`body` must be zero or greater, got {radius!r}")
    limit = PATH_DETOUR_DEFAULT if detour is None else detour
    if limit < 1.0:
        raise ValueError(f"`detour` is a ratio of walked distance over straight-line distance, so it cannot be below 1.0, got {limit!r}")
    if limit == PATH_DETOUR_DEFAULT and threshold is not None:
        limit = threshold

    grid = _clearance_raster(meshes, cell, radius, include_shell=True)
    if grid.get("refused"):
        refusal = {key: value for key, value in grid.items() if key != "refused"}
        refusal["sampled"] = False
        return refusal

    columns = grid["columns"]
    rows = grid["rows"]
    blocked = bytearray(columns * rows)
    for index in range(columns * rows):
        # Shell and furniture block alike here. That is the whole difference
        # from `clearance`, and it is why one raster serves both.
        if grid["blocked"][index] or grid["shell"][index]:
            blocked[index] = 1

    points = request_points or []
    if not points:
        return {
            "sampled": True,
            "paths": [],
            "worstDetour": None,
            "detailThreshold": _round(limit),
            "note": (
                "No `points` were given, so no route could be measured. Pass the world positions "
                "a person is meant to travel between -- door centres, the ends of a corridor, the "
                "foot of a stair. The measure reports how much longer the walk is than the "
                "straight line between the same two points; it does not know which way a person "
                "should go, only that the shortest walk they can make is longer than the line."
            ),
        }

    span = max(grid["extent"]["x"], grid["extent"]["y"])
    # At least a full step, or a valid point falls BETWEEN samples and is
    # reported as a door nobody modelled. The stride is body-driven, so it
    # grows with `body` while this radius must grow with it or the two stops
    # agreeing; the 1.5 covers a sample that is blocked, so a point beside a
    # frame still reaches the free cell beyond it rather than the frame.
    hop = max(radius, grid["step"] * 1.5, span * 0.05)
    located = []
    unresolved = []
    for point in points:
        near = _path_samples_near(grid, blocked, point, hop)
        if not near:
            unresolved.append([_round(point[0]), _round(point[1])])
            continue
        located.append((near[0], point))
    if len(located) < 2:
        return {
            "sampled": True,
            "paths": [],
            "worstDetour": None,
            "unresolved": unresolved,
            "detailThreshold": _round(limit),
            "note": (
                f"Only {len(located)} of {len(points)} points landed on free floor within "
                f"{_round(hop)} m of where they were given. A point nobody can stand at is either "
                "a door buried in a wall or a door that was never modelled; the measure cannot tell "
                "those apart, so it reports the position instead of guessing."
            ),
        }

    reports = []
    worst = None
    # Only the ordered routes the caller named, plus every pair: a house is
    # short of doors and long of rooms, so the pair a designer forgot is the
    # one that zig-zags. With a handful of points that is a handful of pairs,
    # and each is one A* over a room-sized grid.
    pairs = [(located[i], located[j]) for i in range(len(located)) for j in range(i + 1, len(located))]
    for first, second in pairs:
        (fa, fp), (sa, sp) = first, second
        straight = _path_straight_line(grid, fa, sa)
        if straight < PATH_MIN_SPAN:
            continue
        walked = _path_walk(grid, blocked, fa, sa)
        if walked is None:
            continue
        ratio = walked / straight if straight > 0.0 else float("inf")
        entry = {
            "from": [_round(fp[0]), _round(fp[1])],
            "to": [_round(sp[0]), _round(sp[1])],
            "straightLine": _round(straight, 3),
            "walked": _round(walked, 3),
            "detour": _round(ratio, 3),
            "excess": _round(walked - straight, 3),
            "overThreshold": ratio > limit,
            "zigzag": ratio > limit,
        }
        reports.append(entry)
        if worst is None or ratio > worst["detour"]:
            worst = entry
    reports.sort(key=lambda entry: entry["detour"], reverse=True)

    return {
        "sampled": True,
        "cellSize": grid["cellSize"],
        "bodyRadius": grid["bodyRadius"],
        "stride": _round(grid["step"]),
        "extent": grid["extent"],
        "detailThreshold": _round(limit),
        "paths": reports,
        "worstDetour": worst,
        "unresolved": unresolved,
        "zigzagCount": sum(1 for entry in reports if entry["zigzag"]),
        "ignoredObjects": sorted(grid["ignored"]),
        "note": (
            "Each pair reports the shortest walk a person can make against the straight line "
            "between the same two points, so 1.0 is a corridor and every turn raises it: a single "
            "right-angle elbow is about 1.27, which is why the threshold sits well above 1 rather "
            "than at 1.01. Rooms bend; a stair-step of several short offsets does not, and that is "
            "the shape this catches -- doors placed against separate origins rather than a shared "
            "axis. Walls ARE stamped here, unlike the clearance check on the same scope, because a "
            "path that ignores walls goes through them, and the walk is eight-connected so a "
            "diagonal costs sqrt(2) and cannot shave a wall corner the way a four-connected fill "
            "quietly can. `unresolved` lists points that landed on no free floor: either a door "
            "buried in a wall or a door nobody modelled, and the measure cannot tell those apart. "
            "It also does not know which route a person SHOULD take -- only that the shortest one "
            "is longer than the line, so a house with a deliberate detour through a hall reads the "
            "same as one built by accident. Judge `zigzag` against the brief."
        ),
    }


# How a broken continuation is told from a placement.
# Two parts that continue
# each other are separated by a fraction of their own length along the axis
# they share: an 11mm gap between a 1m riser and the pipe above it is 1% of
# the pipe, because the two were meant to be ONE pipe. A chair 25mm below a
# table top is 125% of the seat's own thickness, which is the arithmetic of
# two separate things that happen to be stacked.
JOINT_CONTINUATION_RATIO = 0.1

# How far one part's cross-section may sit outside the other's, as a fraction
# of the larger, before the two stop looking like a continuation of each
# other. A pipe meeting a slightly wider collar is still a joint; a leg beside
# a step is not.
JOINT_CONCENTRIC_SLACK = 0.25

# How deep into another object a part may sit, as a multiple of its OWN
# thinnest extent, before it reads as swallowed rather than joined.
#
# The figure comes from how a joint is actually built. A post, a bolt, a
# railing foot or a pier all sink into what they meet by a sliver, so they
# measure well under 1. A part that measures AT its own thickness is as deep
# as it is thick -- entirely inside -- and one at several times that has
# passed straight through and only shows where it pokes out the far side.
#
# The multiple, not a distance, is the whole point: any threshold in metres
# is a statement about the size of this asset, and assets change size.
BURIED_DEPTH_RATIO = 1.0

# How much bigger the container must be, as a multiple of the buried part's own
# largest extent, before the two are a swallow rather than two layers.
#
# Without this the depth rule fires on correct geometry: on a real 243-object
# scene a pier founded in the ground measured 55x buried (a 24 m pier inside a
# 28 m ground plane) and a lantern standing inside a railing's extent measured
# 8.9x, because both are inside something large. Neither is a defect, and
# together they buried the handful of findings that were real.
#
# A part swallowed BY something is a part placed into it, and a thing you place
# into something else is smaller than the thing holding it -- a door in a wall,
# a rail in a post, a pier in a bank. Two surfaces of near-equal extent that
# overlap are layers: a ground plane and a lawn, a deck and a rug. 1.5 is where
# the measured swallows sat (a 0.1 cube in a 0.5 block is 5x) and the measured
# artifacts sat below (both cases above are under 1.2x).
BURIED_RELATIVE_SIZE = 1.5


def _box_gap(first_min, first_max, second_min, second_max):
    """Per-axis gap and overlap between two axis-aligned world boxes.

    One expression, because the sign is the whole answer: `lower - upper` is
    NEGATIVE when the two slabs overlap (by how much) and POSITIVE when they
    are apart (by how much). Writing it as two branches with the subtraction
    reversed between them is the bug this docstring exists to prevent -- both
    branches return a negative number, so every gap is an overlap, the largest
    one is read as the distance between the two, and the distance filter can
    never reject anything.

    The distance between two boxes is the largest entry, NOT only when every
    axis is positive. Two objects a floor apart overlap on both horizontal
    axes, so "distance = 0 when any axis overlaps" filters out nothing and
    reports every pair in the scene. For the same reason one box swallows
    another when the largest entry is <= 0, NOT when the smallest is negative:
    a chair under a table overlaps on X and Y and is apart on Z, which is the
    opposite of being swallowed.
    """
    gap = []
    for axis in range(3):
        lower = max(first_min[axis], second_min[axis])
        upper = min(first_max[axis], second_max[axis])
        gap.append(lower - upper)
    return gap


def _probe_joints(objects, tolerance):
    """Pairs that ought to meet and do not, found without being asked for.

    The pair check answers "how far apart are these two" for the two someone
    thought to name. It cannot answer "is anything in this scene detached",
    which is the defect that actually reaches a user: a shower riser modelled
    clear of the pipe it continues looks correct in a render from any useful
    angle, and nobody pairs two pipes of the same family by instinct.

    So this sweeps every candidate pair and reports the ones whose BOUNDING
    BOXES say they should be touching while the SURFACES say they are not.
    Severity comes from the geometry of the separation, and the three classes
    are what a real scene actually contains:

      * overlapping-but-apart -- one box swallows the other, so the two parts
        occupy the same place in the model, yet no surface of one reaches any
        surface of the other. A part buried inside another's extent with no
        contact. A defect.
      * broken-continuation -- the two parts are separated along ONE axis,
        and on the other two their cross-sections are concentric: a pipe
        meeting the pipe above it, a leg meeting its foot, a collar on a post.
        The gap is also a small fraction of their own length along that axis.
        That is a joint that was meant to be made and was missed, and it is
        the user's shower. A defect.
      * near-miss -- everything else within JOINT_NEAR_MISS_MAX. A placement
        to JUDGE. A chair under a table is correct and reads the same as a
        detached riser at this resolution, because the two differ in MEANING
        and no measurement recovers meaning. It is reported because it is
        cheap and a render hides it, and marked because treating it as a
        defect is how a measurement turns into noise an analyst learns to skip.

    The box test is a filter, never a verdict. The distance that settles each
    candidate is the same signed BVH measurement the pair check uses, so a
    pair the caller ALSO asked for gets identical numbers here and in `pairs`.
    """
    candidates = []
    boxes = {}
    for obj in objects:
        minimum, maximum = _world_bounding_box(obj)
        boxes[obj.name] = (minimum, maximum)

    for first_index, first in enumerate(objects):
        first_min, first_max = boxes[first.name]
        for second in objects[first_index + 1 :]:
            second_min, second_max = boxes[second.name]
            gap = _box_gap(first_min, first_max, second_min, second_max)
            # One box swallows the other only when NO axis separates them, so
            # the test is the LARGEST gap being zero or negative -- not the
            # smallest. Read it the other way round and every pair that shares
            # space on its perpendicular axes is "overlapping", which is a
            # stacked chair under a table and a pipe below a pipe, both of
            # which are apart on the axis that matters.
            distance = max(0.0, max(gap))
            overlapping = max(gap) <= 0.0
            if distance > JOINT_NEAR_MISS_MAX:
                continue
            separation_axis = distance

            measurement = _probe_pair_geometry(first, second, tolerance)
            # Copied into a plain dict so the access below is total: the pair
            # measurement returns "unknown" with no coincidence figure at all
            # when it could not sample any surface distance.
            coincidence = measurement.get("coincidentSurface") or {}
            is_coincident = bool(coincidence.get("isCoincident"))
            buried = measurement.get("buried")
            buried_info = buried or {}
            ratio = buried_info.get("depthVsThickness")
            relative = buried_info.get("relativeSize")
            # Both figures are required, because each alone is wrong on a real
            # scene: the depth ratio alone reports a pier founded in the ground
            # as 55x buried, and the size ratio alone would let a swallowed
            # part through whenever the container happens to be its match.
            is_buried = (
                ratio is not None
                and relative is not None
                and ratio >= BURIED_DEPTH_RATIO
                and relative >= BURIED_RELATIVE_SIZE
            )
            if measurement["verdict"] in ("interpenetrating", "in-contact") and not is_coincident and not is_buried:
                # They DO meet. Nothing to report: this is the healthy case the
                # sweep exists to distinguish, and reporting it would bury the
                # one that matters. Coincidence is the ONE exception, because
                # two surfaces sharing a stretch is still a contact verdict
                # while rendering as colour banding -- skipping on the verdict
                # alone is exactly what hid it. A buried part is the other,
                # because `interpenetrating` is also the verdict of every
                # working joint in the model: a post 2 mm into a deck is
                # interpenetrating and correct, while a wall built through a
                # door is interpenetrating and a defect, and the boolean alone
                # cannot tell them apart.
                continue

            # `.get`, not `[...]`: _probe_pair_geometry has TWO return shapes.
            # When it could not sample a single signed distance -- which a mesh
            # with no faces does, since the BVH has no surface to find a nearest
            # point on -- it returns the "unknown" shape, and that shape has no
            # "closestSurfaceDistance" key at all. Reproduced against a real
            # Blender: the sweep raised
            #   KeyError: 'closestSurfaceDistance'
            # here, taking the whole geometry probe with it, on a scene where
            # one object had no faces yet. `None` is the honest answer for
            # "no distance could be measured", and the branch below already
            # treats None as "nothing to report".
            surfaces = measurement.get("closestSurfaceDistance")
            if surfaces is None and not is_coincident and not is_buried:
                continue

            if is_coincident:
                # Ranked above the other defects: it is the only severity that
                # is guaranteed to be visible in the final render rather than
                # merely suspected from it, so burying it under a detached
                # pipe would be the wrong order of worries.
                severity = "coincident-surface"
                hits = coincidence["smallerCount"]
                epsilon = coincidence["epsilon"]
                share = coincidence["smallerShare"]
                reason = (
                    f"{hits} of one object's vertices lie within {epsilon} of the other's surface "
                    f"(the smaller side is {share} of that mesh), so a stretch of the two occupies "
                    "the same plane and will render as z-fighting colour banding"
                )
            elif is_buried:
                # Ahead of the other defects and behind only coincidence: a
                # buried part is INVISIBLE in the render, so nothing downstream
                # will notice it, but the model is wrong -- the part is there
                # only as a silhouette poking through.
                severity = "buried"
                reason = (
                    f"{buried_info['buriedObject']} sits {buried_info['depth']} m inside {buried_info['buriedIn']}, "
                    f"which is {ratio} times its own thickness of {buried_info['thickness']} m, and it "
                    f"itself is only {relative} times the size of what holds it -- the part is swallowed "
                    "rather than joined, so it reads only as a bump through the surface"
                )
            elif overlapping:
                severity = "overlapping-but-apart"
                reason = (
                    "one bounding box swallows the other, so the two parts occupy the same place "
                    "in the model, but no surface of one reaches any surface of the other"
                )
            else:
                axis = gap.index(separation_axis)
                length_a = first_max[axis] - first_min[axis]
                length_b = second_max[axis] - second_min[axis]
                shorter = min(length_a, length_b)
                # Concentric on the two axes they are NOT separated along: a
                # continuation is a pipe inside a pipe's footprint, not a
                # diagonal neighbour that happens to be close.
                concentric = True
                for other in range(3):
                    if other == axis:
                        continue
                    span_a = first_max[other] - first_min[other]
                    span_b = second_max[other] - second_min[other]
                    slack = JOINT_CONCENTRIC_SLACK * max(span_a, span_b)
                    if (
                        first_min[other] < second_min[other] - slack
                        or first_max[other] > second_max[other] + slack
                    ):
                        concentric = False
                if concentric and shorter > 0.0 and separation_axis < JOINT_CONTINUATION_RATIO * shorter:
                    severity = "broken-continuation"
                    reason = (
                        f"separated along {'XYZ'[axis]} by {round(separation_axis, 5)} with concentric "
                        f"cross-sections, which is a fraction of the parts' own length along that axis "
                        f"({round(shorter, 5)}) -- the two look like one part split in two"
                    )
                else:
                    severity = "near-miss"
                    reason = (
                        f"bounding boxes come within {round(distance, 5)} of each other without "
                        "overlapping on any axis, so the two may or may not be meant to meet -- judge this one"
                    )

            candidates.append(
                {
                    "a": first.name,
                    "b": second.name,
                    "severity": severity,
                    "reason": reason,
                    "gap": surfaces,
                    "coincidentSurface": coincidence,
                    "buried": buried,
                    "tolerance": measurement["tolerance"],
                    "boundingBoxGap": {"x": _round(gap[0]), "y": _round(gap[1]), "z": _round(gap[2])},
                    "boundingBoxOverlapAxes": ["XYZ"[i] for i in range(3) if gap[i] < 0.0],
                    "overlapping": overlapping,
                    "boundingBoxDistance": _round(distance),
                }
            )

    rank = {
        "coincident-surface": 0,
        "buried": 1,
        "broken-continuation": 2,
        "overlapping-but-apart": 3,
        "near-miss": 4,
    }
    candidates.sort(key=lambda entry: (rank[entry["severity"]], entry["gap"] if entry["gap"] is not None else 0.0))
    defects = [
        entry
        for entry in candidates
        if entry["severity"] in ("coincident-surface", "buried", "broken-continuation", "overlapping-but-apart")
    ]
    near_misses = [entry for entry in candidates if entry["severity"] == "near-miss"]
    return {
        "tolerance": _round(tolerance),
        "nearMissMax": JOINT_NEAR_MISS_MAX,
        "defectCount": len(defects),
        "nearMissCount": len(near_misses),
        "joints": candidates,
        "note": (
            "A joint is a pair whose bounding boxes overlap or come within "
            f"{JOINT_NEAR_MISS_MAX} of each other while their surfaces are further apart than the "
            f"tolerance of {_round(tolerance)}. 'coincident-surface' (a stretch of the two lies on "
            "the same surface, so it renders as z-fighting colour banding), 'buried' (a part sunk "
            "into another by at least its own thickness, so it reads only as a bump through the "
            "surface rather than as a join), 'broken-continuation' "
            "(separated along one axis, "
            "concentric on the others, by a fraction of their own length) and 'overlapping-but-apart' "
            "are defects: two parts that were meant to be one and are not touching. 'near-miss' is a "
            "placement to judge -- a chair at a table is correct and is geometrically indistinguishable "
            "from a detached riser, because the two differ in meaning. The box test only selects "
            "candidates; the gap is a signed BVH measurement, the same one the pair check reports."
        ),
    }


def _probe_topology(obj):
    """Non-manifold / loose / duplicate geometry counts, and mesh islands.

    Counts only: the analyst needs to know a defect exists and how bad it is,
    and full mesh data would swamp its context. A duplicate-face or
    non-manifold-edge count is the reliable signal that a shape is not the
    solid the analyst thinks it is.

    The component count is the one number here that catches a defect the others
    cannot see, because a mesh split into drifting pieces can be perfectly
    clean by every other measure: each piece is a closed solid, so there are no
    boundary edges, no non-manifold edges, no loose vertices and no duplicate
    vertices. A shower head modelled as ONE object whose head has drifted off
    its own pipe reports all zeros here and looks correct in a render. Only
    the connectivity of the mesh says otherwise.
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

    # Connected components over the mesh's own edges, by BFS from each
    # unvisited vertex. Vertices are reached through link_edges rather than the
    # index table so a mesh whose indices are not contiguous still resolves.
    # Coordinates are snapshotted per island because the gap below needs them
    # after the BFS consumed `unvisited`, and reading a BMVert after `bm.free()`
    # raises rather than returning stale data.
    unvisited = set(bm.verts)
    component_sizes = []
    island_points = []
    island_members = []
    while unvisited:
        seed = unvisited.pop()
        component = 1
        members = [seed]
        frontier = [seed]
        while frontier:
            current = frontier.pop()
            for edge in current.link_edges:
                other = edge.other_vert(current)
                if other in unvisited:
                    unvisited.discard(other)
                    component += 1
                    members.append(other)
                    frontier.append(other)
        component_sizes.append(component)
        island_members.append(members)
        island_points.append([vert.co.copy() for vert in members])
    order = sorted(range(len(component_sizes)), key=lambda i: component_sizes[i], reverse=True)
    component_sizes = [component_sizes[i] for i in order]
    island_members = [island_members[i] for i in order]
    island_points = [island_points[i] for i in order]
    total_verts = len(bm.verts)
    largest_share = (component_sizes[0] / total_verts) if component_sizes and total_verts else 0.0
    # Island detail, capped: a mesh fragmented into hundreds of pieces needs the
    # COUNT and the share far more than the whole list, and a 400-vertex cube
    # in boolean-trash mode should not put 200 entries in an analyst's context.
    island_samples = [
        {"vertices": size, "share": _round(size / total_verts, 4) if total_verts else 0.0}
        for size in component_sizes[1:6]
    ]

    # `isSplit` alone cannot tell a broken mesh from a correctly composed one,
    # because a railing of 66 balusters, a bamboo cluster of 83 culms and a
    # drone's four propeller blades are all one mesh with many components -- and
    # all of them are CORRECT. A worker that merges repeated parts into one mesh
    # is doing what this toolchain asks of it, so the raw count cannot be read as
    # a defect or every procedural assembly in every workspace reads as broken.
    #
    # What separates them is whether any one island dominates. An assembly has no
    # single body: 66 balusters of 8 verts each means the largest island is 1.5%
    # of the mesh, and "largest share 1.5%" is the signature of repeated parts. A
    # mesh that broke has a main body plus an offcut -- 50%, 62%, 96% -- because
    # the break took a piece off something that was otherwise whole.
    #
    # KNOWN LIMIT, stated rather than hidden: this is a heuristic on ONE number,
    # and a canopy assembled from many similar-sized clusters reads as an
    # assembly when it is one object a person considers whole. The measurement
    # below is the evidence; this label is the reading of it. `minIslandGap` is
    # given for the case the label gets wrong -- islands a few millimetres apart
    # are a break whatever their count.
    ISLAND_ASSEMBLY_SHARE = 0.10
    if len(component_sizes) <= 1:
        island_read = "continuous"
    elif largest_share < ISLAND_ASSEMBLY_SHARE:
        island_read = "assembly"
    else:
        island_read = "break-candidate"

    # `assembly` on its own is not a PASS, and this is where that becomes
    # actionable. "Many equal parts" says nothing about whether the parts MEET,
    # and a merged mesh whose parts float apart is the exact shape of the defect
    # this whole family of checks exists for -- a railing of balusters with 25 cm
    # of air between each one is not an assembly, it is a broken model with a
    # healthy-looking island count.
    #
    # Measured on real workspaces, the two are indistinguishable by count and
    # opposite by contact: 32 bridge planks 2.65 m long, 25.4 mm apart, and a
    # bamboo cluster with 79 of 83 culms 126 mm from their nearest neighbour.
    # Both read `assembly`. Only the contact answers whether they are built.
    #
    # So the contact is measured per island against its nearest OTHER island,
    # and compared not to an absolute millimetre but to the island's OWN size:
    # a gap that is large against the part is a part floating free, while a gap
    # that is small against the part is two pieces that were meant to meet. That
    # ratio is dimensionless and scale-independent, which a fixed threshold is
    # not -- the same 25 mm is a seam on a plank and a canyon on a bollard.
    # `minIslandGap` and `islandFloatingShare` are measured below, from a
    # nearest-neighbour pass over every island, so they arrive with islandRead.
    island_floating = None
    island_contact = None
    min_island_gap = None
    if len(island_points) > 1:
        # Box separation was tried first and is WRONG for an elongated part: 32
        # planks 2.65 m long laid 25 mm apart have OVERLAPPING boxes, so the box
        # measure reports them joined at gap 0. A box is only as good as its
        # shortest axis, and every assembly that repeats a long thin member --
        # planks, balusters, slats, blades -- has almost none.
        #
        # Surface to surface, which is the same measure `_probe_pair_geometry`
        # uses between two objects, applied between islands of one mesh. It needs
        # a BVH per island, so it is built once per island and asked both ways,
        # because the nearest approach can be missed from either side alone.
        #
        # Cost is O(islands) BVHs and O(vertices) distance queries. That is
        # deliberately inside the `topology` check the docs already call
        # "the expensive one", rather than being paid on every probe.
        island_index_by_vert = {}
        for index, members in enumerate(island_members):
            for vert in members:
                island_index_by_vert[vert.index] = index
        # Face vertex indices must be LOCAL to the vertex list handed to the BVH,
        # and an island's vertices are a SUBSET of the mesh's. Passing the mesh's
        # own indices against a subset list reads out of range: it crashed the
        # probe at exit 139 before any assertion, which is why it is written as an
        # explicit remap rather than reused verbatim.
        island_faces = [[] for _ in island_members]
        for face in bm.faces:
            owner = island_index_by_vert.get(face.verts[0].index)
            if owner is None:
                continue
            island_faces[owner].append(
                [island_members[owner].index(vert) for vert in face.verts]
            )

        island_bvhs = []
        for index, members in enumerate(island_members):
            island_bvhs.append(
                BVHTree.FromPolygons(
                    [vert.co.copy() for vert in members],
                    island_faces[index],
                    all_triangles=False,
                    epsilon=0.0,
                )
            )

        ratios = []
        for index, members in enumerate(island_members):
            own_bvh = island_bvhs[index]
            extent = max(
                max(component[axis] for component in island_points[index])
                - min(component[axis] for component in island_points[index])
                for axis in range(3)
            )
            if extent <= 0.0:
                continue
            nearest_distance = None
            for other_index, members_b in enumerate(island_members):
                if other_index == index:
                    continue
                other_bvh = island_bvhs[other_index]
                for vert in members:
                    signed = _signed_distance_to_surface(vert.co, other_bvh)
                    if signed is None:
                        continue
                    # Negative means this vertex is INSIDE the other island, so
                    # the two parts interpenetrate: contact, not separation.
                    distance = abs(signed)
                    if nearest_distance is None or distance < nearest_distance:
                        nearest_distance = distance
                for vert in members_b:
                    signed = _signed_distance_to_surface(vert.co, own_bvh)
                    if signed is None:
                        continue
                    distance = abs(signed)
                    if nearest_distance is None or distance < nearest_distance:
                        nearest_distance = distance
                if nearest_distance == 0.0:
                    break
            if nearest_distance is None:
                continue
            ratios.append((nearest_distance / extent, nearest_distance))
        if ratios:
            ratios.sort()
            island_contact = _round(ratios[0][0], 4)
            island_floating = round(
                100.0 * sum(1.0 for ratio, _ in ratios if ratio > ISLAND_FLOATING_RATIO) / len(ratios), 1
            )
            # The tightest join in the mesh, in metres. It comes from the same
            # nearest-neighbour pass as the ratios above, so there is no second
            # all-pairs walk: that earlier loop was O(islands x vertices) and this
            # is O(n log n).
            #
            # Its scope is every island pair rather than only main-body-to-other.
            # A pair of alike halves drifting apart -- the case the body-only
            # version could not see, because neither half was the largest -- is
            # exactly what a minimum over all pairs does find.
            min_island_gap = _round(min(distance for _, distance in ratios), 5)
    bm.free()
    return {
        "available": True,
        "vertices": total_verts,
        "edges": len(mesh.edges),
        "faces": len(mesh.polygons),
        "nonManifoldEdges": non_manifold,
        "boundaryEdges": boundary,
        "looseVertices": loose_verts,
        "looseEdges": loose_edges,
        "degenerateFaces": degenerate,
        "duplicateVertices": duplicates,
        "connectedComponents": len(component_sizes),
        "largestComponentShare": _round(largest_share, 4),
        "islandSizes": island_samples,
        # One component is the healthy case for every closed solid and for every
        # surface with a single shell. A mesh with more is either several pieces
        # that should be one object, or one object split by a modelling slip --
        # and a surface that is a shell PLUS a base, or a shape with a separate
        # inset piece, is legitimate, so this is a finding to judge, not a
        # defect count. `largestComponentShare` says how much of the mesh the
        # main body is, which separates "one small extra piece" from "in pieces".
        "isSplit": len(component_sizes) > 1,
        # The reading of the numbers above, because `isSplit` on its own cannot
        # be acted on: a railing of 66 balusters and a drone's four blades are
        # both correctly composed meshes that read as split.
        "islandRead": island_read,
        "minIslandGap": min_island_gap,
        # Whether the parts of an assembly MEET, which the island count cannot
        # say and a render cannot show. `islandFloatingShare` is the percentage
        # of islands whose nearest neighbour is farther than
        # ISLAND_FLOATING_RATIO of their own size; `islandContact` is that ratio
        # for the closest pair in the mesh. A railing whose balusters touch
        # reports a small contact ratio and a low floating share; the same
        # railing with 25 cm of air between each one reads identically on
        # islandRead and completely differently here.
        "islandFloatingShare": island_floating,
        "islandContact": island_contact,
    }


def _sample_world_points(obj, limit):
    """World-space points, evenly subsampled above `limit`, plus the total count.

    Returns (points, total) so a caller can report the real vertex count next to
    a sample-derived number, which is otherwise indistinguishable from one taken
    over every vertex.
    """
    total = len(obj.data.vertices)
    stride = max(1, total // limit)
    coords = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices[::stride]]
    if coords and stride > 1:
        coords.append(obj.matrix_world @ obj.data.vertices[-1].co)
    return coords, total


def _shape_self_symmetry(points, minimum, maximum):
    """How far each world axis mirror disagrees with the mesh.

    The mesh's own bounding-box centre is the mirror plane, not the world
    origin: a model that simply sits off to one side is still symmetric, and
    testing against the origin would report every placed object as lopsided.

    Each mirrored point is matched to its nearest real vertex, so the number is
    a genuine surface-to-surface distance rather than a difference of two
    arbitrary index pairs — a mesh with uneven vertex density does not read as
    asymmetric just because its indices are not mirrored.
    """
    try:
        # pi-lens-ignore: ast-grep:unresolved-import-python
        from mathutils import kdtree  # pyright: ignore[reportMissingImports]
    except ImportError:
        return {
            "mirrorAxis": None,
            "meanDeviation": None,
            "maxDeviation": None,
            "deviationRatio": None,
            "perAxis": [],
            "reason": "mathutils.kdtree unavailable in this Blender build",
        }

    if len(points) < 3:
        return {
            "mirrorAxis": None,
            "meanDeviation": None,
            "maxDeviation": None,
            "deviationRatio": None,
            "perAxis": [],
            "reason": "fewer than 3 sampled vertices",
        }

    size = max(maximum[i] - minimum[i] for i in range(3))
    if size <= 0.0:
        size = 1.0

    tree = kdtree.KDTree(len(points))
    for index, point in enumerate(points):
        tree.insert(point, index)
    tree.balance()

    center = (minimum + maximum) * 0.5
    per_axis = []
    deviations = {}
    for axis_index, axis_name in enumerate(("X", "Y", "Z")):
        total = 0.0
        worst = 0.0
        for point in points:
            mirrored = Vector(point)
            mirrored[axis_index] = 2.0 * center[axis_index] - mirrored[axis_index]
            distance = tree.find(mirrored)[2]
            total += distance
            if distance > worst:
                worst = distance
        deviations[axis_name] = worst
        per_axis.append(
            {
                "axis": axis_name,
                "meanDeviation": _round(total / len(points)),
                "ratio": _round((total / len(points)) / size, 5),
            }
        )

    per_axis.sort(key=lambda entry: entry["ratio"])
    best = per_axis[0]
    symmetric = best["ratio"] <= 0.05
    return {
        "mirrorAxis": best["axis"] if symmetric else None,
        "meanDeviation": best["meanDeviation"],
        "maxDeviation": _round(deviations[best["axis"]]),
        "deviationRatio": best["ratio"] if symmetric else None,
        "perAxis": [
            {"axis": entry["axis"], "meanDeviation": entry["meanDeviation"]}
            for entry in per_axis
        ],
        "note": None if symmetric else "least-asymmetric axis; none within 5% of the mesh size",
    }


def _shape_radius_profile(points, minimum, maximum):
    """Mean distance from the mesh's own long axis, sampled along it.

    The axis is the mesh's largest bounding-box dimension, because that is what
    a reader means by "the object's axis" and because a principal axis from the
    covariance sweep is an arbitrary in-plane direction on a symmetric object.
    `spread` alongside `radius` is what separates a smooth taper from a bulge:
    a locally fatter band raises the spread without changing the trend.
    """
    axis_index = max(range(3), key=lambda i: maximum[i] - minimum[i])
    axis_name = ("X", "Y", "Z")[axis_index]
    extent = maximum[axis_index] - minimum[axis_index]
    if extent <= 0.0:
        return None, axis_name

    center = (minimum + maximum) * 0.5
    half_width = extent / (2.0 * SHAPE_PROFILE_SAMPLES)
    samples = []
    for index in range(SHAPE_PROFILE_SAMPLES):
        position = minimum[axis_index] + extent * ((index + 0.5) / SHAPE_PROFILE_SAMPLES)
        slab = [point for point in points if abs(point[axis_index] - position) <= half_width]
        if not slab:
            continue
        distances = []
        for point in slab:
            axis_point = Vector((center.x, center.y, center.z))
            axis_point[axis_index] = point[axis_index]
            distances.append((point - axis_point).length)
        mean = sum(distances) / len(distances)
        variance = sum((value - mean) ** 2 for value in distances) / len(distances)
        samples.append(
            {
                "t": _round((index + 0.5) / SHAPE_PROFILE_SAMPLES, 4),
                "radius": _round(mean),
                "spread": _round(variance ** 0.5),
            }
        )

    if len(samples) < 2:
        return None, axis_name

    # strict=False is the intent, not an omission: the sample list is paired
    # with itself shifted by one, so the two sequences differ in length by
    # exactly one and strict=True would raise on every call.
    shrinking = sum(1 for a, b in zip(samples, samples[1:], strict=False) if b["radius"] <= a["radius"])
    first = samples[0]["radius"]
    taper = (first - samples[-1]["radius"]) / first if first > 0.0 else 0.0
    return (
        {
            "t": [sample["t"] for sample in samples],
            "radius": [sample["radius"] for sample in samples],
            "spread": [sample["spread"] for sample in samples],
            "monotonic": _round(shrinking / (len(samples) - 1), 4),
            "taper": _round(taper, 4),
        },
        axis_name,
    )


def _shape_convexity(obj, points):
    """Fraction of the surface that lies on or inside the mesh's own convex hull.

    A perfect sphere or capsule reads 1.0; a dumbbell, a saddle or a limb
    junctioned onto a torso reads lower. It is a shape defect a silhouette can
    hide, because the offending part may be facing away or occluded.
    """
    try:
        # pi-lens-ignore: ast-grep:unresolved-import-python
        import bmesh  # pyright: ignore[reportMissingImports]
    except ImportError:
        return None, "bmesh unavailable in this Blender build", None

    try:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        result = bmesh.ops.convex_hull(bm, input=list(bm.verts))
        # The hull's own faces are the BMFace entries of `geom`; bm afterwards
        # holds the original mesh with its interior faces deleted, so re-reading
        # bm would measure the wrong surface.
        for entry in ("geom", "geom_cut"):
            faces = [item for item in result.get(entry, []) if isinstance(item, bmesh.types.BMFace)]
            if faces:
                break
        else:
            bm.free()
            return None, f"convex hull returned no faces (keys: {', '.join(sorted(result))})", None
        world_corners = []
        polygons = []
        for face in faces:
            first = len(world_corners)
            world_corners.extend(tuple(obj.matrix_world @ vert.co) for vert in face.verts)
            polygons.append(list(range(first, len(world_corners))))
        bm.free()
        hull = BVHTree.FromPolygons(world_corners, polygons, all_triangles=False, epsilon=0.0)
    except Exception as error:
        return None, f"convex hull failed: {error}", None

    matrix = obj.matrix_world
    # Distance to the hull surface, not a ray. A hull built from the mesh's own
    # faces is a surface with no interior, so a ray from any vertex finds the
    # nearest face and the direction chosen decides the answer; a sphere would
    # read 0.0 or 1.0 depending on which side the ray happened to leave from.
    # The nearest surface point does not have that ambiguity, and a vertex of a
    # genuinely convex mesh sits on the hull at distance zero.
    limit = min(GEOMETRY_PROBE_CONVEXITY_VERTEX_LIMIT, len(obj.data.vertices))
    stride = max(1, len(obj.data.vertices) // limit)
    on_hull = 0
    counted = 0
    worst = 0.0
    for vertex in obj.data.vertices[::stride]:
        origin = matrix @ vertex.co
        found, _, _, distance = hull.find_nearest(origin)
        if found is None:
            continue
        counted += 1
        if distance <= GEOMETRY_PROBE_CONVEXITY_EPSILON:
            on_hull += 1
        else:
            worst = max(worst, distance)
    if counted == 0:
        return None, "no vertices sampled", None
    return _round(on_hull / counted, 4), None, worst


def _probe_shape(obj):
    """Shape measurements no render can settle.

    Symmetry, a radius profile along the mesh's own axis, convexity and open
    edges. All of it is a scalar or a short series: the point is to give the
    analyst a sentence with numbers in it ("the taper is monotonic but the base
    is 8% too fat"), not the vertex data to form that sentence herself.
    """
    points, total = _sample_world_points(obj, GEOMETRY_PROBE_SHAPE_SAMPLE_LIMIT)
    minimum, maximum = _world_bounding_box(obj)
    profile, profile_axis = _shape_radius_profile(points, minimum, maximum)
    convexity, convexity_reason, worst_gap = _shape_convexity(obj, points)

    open_edges = None
    loose_verts = None
    try:
        # pi-lens-ignore: ast-grep:unresolved-import-python
        import bmesh  # pyright: ignore[reportMissingImports]
    except ImportError:
        pass
    else:
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        # Fewer than two adjacent faces, not zero: a boundary edge of a grid or
        # the rim of a hole has one, and is exactly the defect a closed mesh
        # never has.
        # Fewer than two adjacent faces, not zero. A 2x2 grid has 12 edges of
        # which 8 are boundary, and every one of them still has ONE adjacent
        # face, so `== 0` reports a wide-open plane as watertight.
        # Fewer than two adjacent faces, not zero. A 2x2 grid has 12 edges of
        # which 8 are boundary, and every boundary edge still has ONE adjacent
        # face, so `== 0` reports a wide-open plane as watertight.
        open_edges = sum(1 for edge in bm.edges if len(edge.link_faces) < 2)
        loose_verts = sum(1 for vert in bm.verts if not vert.link_edges)
        bm.free()

    entry = {
        "vertices": total,
        "faces": len(obj.data.polygons),
        "dimensions": _round_vector(maximum - minimum),
        "profileAxis": profile_axis,
        "profile": profile,
        "selfSymmetry": _shape_self_symmetry(points, minimum, maximum),
        "convexityRatio": convexity,
        "openEdges": open_edges,
        "looseVerts": loose_verts,
    }
    if profile is None:
        entry["note"] = "mesh has no extent along its long axis; radius profile unavailable"
    elif convexity_reason is not None:
        entry["note"] = f"convexity unavailable: {convexity_reason}"
    elif convexity is not None and convexity < 1.0:
        entry["deepestInsideHull"] = _round(worst_gap, 5)
    if total > len(points):
        entry["sampleNote"] = f"symmetry, profile and convexity used {len(points)} of {total} vertices, evenly subsampled"
    return entry


def _parse_length(value):
    """Return a length in metres from a number or a dimension string.

    Interiors are specified in millimetres and a brief that writes "900" for a
    counter height is stating 900 mm, not 900 m. A bare INTEGER is therefore
    millimetres and a bare DECIMAL is metres, because a rendered scene cannot
    show a factor of a thousand: a 900 m ceiling looks exactly like a 0.9 m one
    from inside a 900 m room. Strings carrying an explicit unit are taken at
    their word.
    """
    if isinstance(value, (int, float)):
        return float(value) / 1000.0
    text = str(value).strip().lower().replace(" ", "")
    for suffix, scale in (("mm", 0.001), ("cm", 0.01), ("m", 1.0), ("in", 0.0254), ("'", 0.3048), ('"', 0.6096)):
        if text.endswith(suffix):
            head = text[: -len(suffix)]
            try:
                return float(head) * scale
            except ValueError as err:
                raise RuntimeError(f'Cannot read a length from "{value}". Write it as 900mm, 2.4m or 0.9.') from err
    try:
        # A bare DECIMAL is metres and a bare INTEGER is millimetres, which is
        # how a brief writes them: "900" is a counter height and "0.9" is the
        # same counter in SI. A unitless integer read as metres would be a
        # 1000x error that renders plausibly, so it is not an option.
        number = float(text)
    except ValueError as err:
        raise RuntimeError(f'Cannot read a length from "{value}". Write it as 900mm, 2.4m or 0.9.') from err
    return number if "." in text else number / 1000.0


def _probe_scale_contract(specifications, measurements, default_tolerance):
    """Compare measured objects against the dimensions a brief named.

    An interior is defined by human dimensions — a 900 mm counter, a 2100 mm
    door, a 2400 mm ceiling — and nothing else in the scene carries scale. A
    build can be internally consistent and still be wrong by a factor of a
    thousand, and a render cannot show it: a 900 m ceiling looks exactly like a
    0.9 m one from inside a 900 m room.

    So the reference has to be stated and then measured against. This is the
    check that turns "the kitchen looks wrong" into "Counter: 0.94 m against a
    0.90 m target".
    """
    results = {}
    for name, spec in (specifications or {}).items():
        obj = bpy.data.objects.get(name)
        if obj is None:
            results[name] = {
                "status": "missing",
                "detail": f'No object named "{name}" exists to measure.',
            }
            continue
        if obj.type != "MESH":
            results[name] = {
                "status": "not-a-mesh",
                "detail": f'"{name}" is a {obj.type}, so it has no measured extent.',
            }
            continue

        entry = measurements.get(name) or {}
        bounds = entry.get("bounds")
        if bounds is None:
            minimum, maximum = _world_bounding_box(obj)
            bounds = {
                "min": _round_vector(minimum),
                "max": _round_vector(maximum),
                "size": _round_vector(maximum - minimum),
                "center": _round_vector((minimum + maximum) * 0.5),
            }

        tolerance = _as_float(spec.get("tolerance"), "specifications[...].tolerance", default_tolerance)
        axes = {}
        # The spec is keyed by width/depth/height, which are the words a brief
        # uses; each maps to one measured world axis.
        for label, axis in (("width", "x"), ("depth", "y"), ("height", "z")):
            if label not in spec:
                continue
            target = _parse_length(spec[label])
            measured = float(bounds["size"][{"x": 0, "y": 1, "z": 2}[axis]])
            delta = measured - target
            axes[label] = {
                "axis": axis,
                "label": label,
                "measured": _round(measured),
                "target": _round(target),
                "delta": _round(delta),
                "ratio": _round(measured / target) if target else None,
                "withinTolerance": abs(delta) <= tolerance,
            }

        failed = [label for label, block in axes.items() if not block["withinTolerance"]]
        if not axes:
            results[name] = {
                "status": "no-axes",
                "detail": f'Specification for "{name}" names no axis. Use width, depth or height.',
            }
        elif failed:
            detail = "; ".join(
                "{label} {measured} m against {target} m".format(
                    label=label,
                    measured=axes[label]["measured"],
                    target=axes[label]["target"],
                )
                for label in failed
            )
            results[name] = {"status": "off-spec", "detail": detail, "axes": axes}
        else:
            results[name] = {"status": "on-spec", "detail": "within tolerance of every named axis", "axes": axes}
    return results


def handle_geometry_probe(request):
    """Measure mesh/transform relationships in the open scene.

    Read-only by construction: it builds BVHs and reads vertex coordinates,
    and never mutates or saves. That is what makes it safe for a diagnostician
    to call while the manager has a worker mid-iteration.

    The blend is opened if this is a fresh process. The windowed bridge already
    has the workspace open, so the call was free there; headless there is no
    session and an unopened file measures nothing at all.
    """
    ensure_requested_blend_open(request)
    requested = request.get("checks") or list(GEOMETRY_PROBE_CHECKS)
    unknown = [check for check in requested if check not in GEOMETRY_PROBE_CHECKS]
    if unknown:
        raise RuntimeError(
            f"Unknown geometry probe check(s): {', '.join(unknown)}. "
            f"Available: {', '.join(GEOMETRY_PROBE_CHECKS)}"
        )

    tolerance = _as_float(request.get("tolerance"), "tolerance", 0.002)
    specifications = request.get("specifications") or None
    if specifications is not None and "scale" not in requested:
        # Naming the dimensions is the request; requiring the caller to also
        # remember the check name is a way of silently measuring nothing.
        requested = list(requested) + ["scale"]
    if request.get("points") and "path" not in requested:
        # Same reasoning, and it matters more here: a caller who passes door
        # positions and forgets the check name gets a probe with no path in it
        # and no complaint, which reads as a route that was never worth
        # measuring.
        requested = list(requested) + ["path"]
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

        if "shape" in requested:
            entry["shape"] = _probe_shape(obj)

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

    joints = None
    if "joint" in requested:
        # Swept over the resolved targets, not over `pairs`: the whole point is
        # the pair nobody thought of. `objects` still scopes the sweep, so a
        # probe of one part still costs one sweep rather than the whole scene.
        joints = _probe_joints([obj for obj in targets if obj.type == "MESH"], tolerance)

    clearance = None
    if "clearance" in requested:
        # Over the same targets, for the same reason as the sweep: `objects`
        # scopes the room, so a caller measuring one room of a house pays for
        # one room.
        clearance = _probe_clearance(
            [obj for obj in targets if obj.type == "MESH"],
            _as_float(request.get("cell"), "cell", None),
            _as_float(request.get("body"), "body", None),
        )

    path = None
    if "path" in requested:
        points = request.get("points") or []
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2:
                raise ValueError(
                    f"`points` must be a list of [x, y] world positions in metres, got {point!r}. "
                    "Pass the door centres a person is meant to travel between."
                )
        path = _probe_path(
            [obj for obj in targets if obj.type == "MESH"],
            [(float(point[0]), float(point[1])) for point in points],
            _as_float(request.get("cell"), "cell", None),
            _as_float(request.get("body"), "body", None),
            _as_float(request.get("detour"), "detour", None),
        )

    scale_contract = {}
    if "scale" in requested:
        if not specifications:
            raise RuntimeError(
                'The "scale" check compares objects against reference dimensions, so it needs '
                '`specifications`: {"Counter": {"height": "900mm"}, "Door": {"height": "2100mm", '
                '"width": "900mm"}}. Bare numbers in a specification are read as millimetres.'
            )
        scale_contract = _probe_scale_contract(specifications, measurements, tolerance)

    return {
        "blendPath": bpy.data.filepath if bpy.data.filepath else None,
        "isDirty": bool(bpy.data.is_dirty),
        "checks": requested,
        "tolerance": _round(tolerance),
        "unitNote": "Blender units; 1.0 = 1 m by default. In a specification a bare number is millimetres.",
        "objects": measurements,
        "pairs": pairs,
        "joints": joints,
        "clearance": clearance,
        "path": path,
        "scaleContract": scale_contract,
    }


def handle_shutdown(request):
    """Save the open blend (if asked) and quit this Blender.

    Sent by the extension on session_shutdown when the reason is "quit", so a
    pi process that ends releases its own private UI instead of leaving a
    Blender window and its memory behind for the user to close by hand.

    Two ordering constraints make this handler more than a two-liner:

      * It must NOT quit inline. process_request_file writes the response only
        AFTER handle_request returns, so quitting here would kill the process
        before the response file exists and the caller would sit there until
        its own timeout expired, reporting a failure for a request that
        actually succeeded. So the quit is deferred (see request_quit_after_response).
      * Saving is best-effort and never fatal. A blend that cannot be written
        (read-only path, full disk) must still let the UI close, or the user is
        left with exactly the stuck window this handler exists to prevent. The
        reason string is returned so the failure is visible rather than silent.
    """
    result = {
        "saved": False,
        "savedPath": None,
        "quitting": True,
        "blendPath": bpy.data.filepath or None,
        "wasDirty": bool(bpy.data.is_dirty),
    }

    if request.get("save") and bpy.data.filepath:
        try:
            bpy.ops.wm.save_mainfile()
            result["saved"] = True
            result["savedPath"] = bpy.data.filepath
        except Exception as error:
            # Report, do not raise: raising would skip the quit and strand the
            # window. The caller surfaces this string in its exit log.
            result["saveError"] = str(error)

    if not request.get("save"):
        result["note"] = "save=false: the open blend was left untouched on disk"

    global PENDING_QUIT
    PENDING_QUIT = True
    return result


def _montage_subject_extent(subject_names):
    """World-space extent of the comparison subject in the OPEN blend.

    Returns (bounds_min, bounds_max) or None when the blend holds none of the
    named objects. Tolerance rather than strictness is deliberate: the BASELINE
    of a comparison is the state before a part existed, so an object named in
    the brief and missing from the older checkpoint is the normal case, not a
    caller error. It is also why the union below can be smaller than the
    current subject alone, which the caller is told about rather than left to
    discover from a cropped panel.
    """
    names = [name for name in subject_names if bpy.data.objects.get(name) is not None] if subject_names else []
    if not names:
        names = [obj.name for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not names:
        return None
    corners = []
    for name in names:
        obj = bpy.data.objects.get(name)
        if obj is None or obj.type != "MESH":
            continue
        minimum, maximum = _world_bounding_box(obj)
        corners.append(minimum)
        corners.append(maximum)
    if not corners:
        return None
    bounds_min = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    bounds_max = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return bounds_min, bounds_max


def _union_extent(a, b):
    """The tightest box containing both extents, either of which may be None.

    An extent here is the (bounds_min, bounds_max) PAIR that
    _montage_subject_extent returns, not a per-axis dict, because that is the
    shape every caller here already holds.
    """
    extents = [extent for extent in (a, b) if extent is not None]
    if not extents:
        return None
    if len(extents) == 1:
        return extents[0]
    return (
        Vector(tuple(min(extent[0][i] for extent in extents) for i in range(3))),
        Vector(tuple(max(extent[1][i] for extent in extents) for i in range(3))),
    )


def _montage_placements(resolved, bounds_min, bounds_max):
    """One camera per requested view, all framed from the SAME extent.

    Two families, chosen per view name. An ORBIT preset (front, left,
    three-quarter) frames the subject's bounding sphere, which is the right
    question for an object on a turntable. An INTERIOR preset (interior-corner,
    interior-doorway) stands inside the subject at eye height, which is the only
    question a room can be asked: a 6x4x2.8m room has a bounding-sphere radius
    of 3.9m, so every orbit panel of it photographs the outside of a wall.

    Both families are fixed presets rather than anything computed per subject.
    A framing that derived its angles from the geometry would put the
    comparison of two panels at the mercy of the geometry being judged.
    """
    centre = tuple((bounds_min + bounds_max) * 0.5)
    radius = max(((bounds_max - bounds_min) * 0.5).length, 0.01)
    distance = montage.framing_distance(radius)
    # Orbit panels share one distance, so no angle silently frames the subject
    # tighter than another. Interior panels ignore it entirely: their distance
    # from the room's centre is a property of the room, not a framing choice.
    placements = []
    for angle, placement in resolved:
        if angle is None:
            family = "interior"
            location, target, lens_mm = montage.interior_placement(bounds_min, bounds_max, placement)
            placements.append((family, location, target, lens_mm))
        else:
            family = "orbit"
            location = montage.camera_location(centre, distance, angle[0], angle[1])
            # Look at the subject, not at the world origin: the orbit only says
            # where the camera sits.
            placements.append((family, location, centre, None))
    return placements, centre, radius, distance


def _render_montage_panels(scene, viewport, view_names, placements, output_dir, panel_width, panel_height, prefix):
    """Render one panel per view, returning (panels, panel_paths).

    The caller owns the render settings and restores them; this owns the
    temporary cameras and removes them even when a render raises, so a failed
    sheet leaves no camera behind in the session it was asked from.
    """
    render_settings = scene.render
    created_cameras = []
    panels = []
    panel_paths = []
    try:
        render_settings.resolution_x = panel_width
        render_settings.resolution_y = panel_height
        render_settings.resolution_percentage = 100
        render_settings.image_settings.file_format = "PNG"

        for index, view_name in enumerate(view_names):
            panel_path = os.path.join(output_dir, f"{prefix}{index + 1}-{view_name}.png")
            camera_data = bpy.data.cameras.new(f"montage-camera-{index + 1}")
            camera_object = bpy.data.objects.new(camera_data.name, camera_data)
            scene.collection.objects.link(camera_object)
            created_cameras.append(camera_object)
            family, location, target, lens_mm = placements[index]
            camera_object.location = location
            if lens_mm is not None:
                # The orbit's 50mm is a whole-subject framing choice; an interior
                # preset's lens is part of standing inside something. A 50mm at
                # 300mm from a wall photographs that wall and nothing else.
                camera_data.lens = lens_mm
            direction = Vector(target) - camera_object.location
            if direction.length < 1e-6:
                raise RuntimeError(
                    f'View "{view_name}" puts the camera exactly where it is looking. '
                    "A subject with no extent in one direction has no framing for "
                    "that preset."
                )
            camera_object.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
            scene.camera = camera_object

            render_settings.filepath = panel_path
            with render_override(viewport, scene):
                bpy.ops.render.render(write_still=True)

            panels.append(montage.read_panel(panel_path))
            panel_paths.append(panel_path)
    finally:
        for camera_data in created_cameras:
            data = camera_data.data
            bpy.data.objects.remove(camera_data, do_unlink=True)
            if data.users == 0:
                bpy.data.cameras.remove(data)
    return panels, panel_paths


def _montage_view_names(request):
    view_names = list(request.get("views") or ["front", "three-quarter"])
    if len(view_names) < 1:
        raise RuntimeError("A montage needs at least one view.")
    # An angle the caller misspelled must not cost a render of the panels that
    # did resolve, so every name is checked before anything is created.
    return view_names, [montage.resolve_angle(name) for name in view_names]


def handle_montage(request):
    """Render several preset views of one subject and tile them into a sheet.

    Read-only with respect to the file it photographs: the resolution, file
    format, filepath and scene camera are snapshotted and restored, and the
    temporary cameras are removed, so asking for a sheet leaves the workspace
    exactly as it was found.

    Two families of preset, chosen per view name. An ORBIT preset (front, left,
    three-quarter) frames the subject's bounding sphere, which is the right
    question for an object on a turntable. An INTERIOR preset (interior-corner,
    interior-doorway) stands inside the subject at eye height, which is the only
    question a room can be asked: a 6x4x2.8m room has a bounding-sphere radius
    of 3.9m, so every orbit panel of it photographs the outside of a wall.

    Both families are fixed presets rather than anything computed per subject.
    A framing that derived its angles from the geometry would put the
    comparison of two panels at the mercy of the geometry being judged.
    """
    ensure_requested_blend_open(request)

    # Optional, not required: the orbit and the tiling do not need a viewport,
    # and a headless Blender has none. Requiring one here is what made a montage
    # impossible without a window, for a sheet whose only window-dependent part
    # was an override context.
    viewport = find_optional_viewport_context()
    scene = viewport["scene"] if viewport is not None else bpy.context.scene
    view_names, resolved = _montage_view_names(request)

    subjects = _resolve_probe_objects(request.get("subject") or [])
    if not subjects:
        raise RuntimeError("No mesh objects to frame. Pass `subject` explicitly if the scene is empty or filtered.")
    extent = _montage_subject_extent(request.get("subject") or [])
    if extent is None:
        raise RuntimeError("No mesh objects to frame. Pass `subject` explicitly if the scene is empty or filtered.")
    bounds_min, bounds_max = extent
    placements, centre, radius, distance = _montage_placements(resolved, bounds_min, bounds_max)

    columns = _as_int(request.get("columns"), "columns", 1 if len(view_names) <= 2 else 2)
    columns = max(1, min(4, columns))
    panel = request.get("panelResolution") or {}
    panel_width = _as_int(panel.get("x"), "panelResolution.x", 900)
    panel_height = _as_int(panel.get("y"), "panelResolution.y", 700)

    output_dir = request["outputDir"]
    # exist_ok already covers the only expected failure, a directory that
    # exists; what is left is a path that cannot become one at all -- a file
    # in the way, a missing parent, no permission -- and the raw OSError names
    # a path without saying which request field asked for it.
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as error:
        raise RuntimeError(f"`outputDir` could not be created at {output_dir}: {error}") from error
    sheet_path = os.path.join(output_dir, request.get("outputName") or "montage.png")

    render_settings = scene.render
    previous_scene_camera = scene.camera
    previous_resolution = (
        render_settings.resolution_x,
        render_settings.resolution_y,
        render_settings.resolution_percentage,
    )
    previous_file_format = render_settings.image_settings.file_format
    previous_filepath = render_settings.filepath

    try:
        panels, panel_paths = _render_montage_panels(
            scene, viewport, view_names, placements, output_dir, panel_width, panel_height, "panel-"
        )
        sheet, layout = _montage_sheet(panels, view_names, columns, panel_width)
        montage.write_png(sheet_path, sheet)
    finally:
        scene.camera = previous_scene_camera
        (
            render_settings.resolution_x,
            render_settings.resolution_y,
            render_settings.resolution_percentage,
        ) = previous_resolution
        render_settings.image_settings.file_format = previous_file_format
        render_settings.filepath = previous_filepath

    return {
        "montagePath": sheet_path,
        "panelPaths": panel_paths,
        "views": [str(name) for name in view_names],
        "layout": layout,
        "subject": [obj.name for obj in subjects],
        "framing": {
            "family": "interior" if all(f[0] == "interior" for f in placements) else "orbit",
            "center": [_round(value) for value in centre],
            "radius": _round(radius),
            "distance": _round(distance),
            "views": [
                {
                    "view": str(view_name),
                    "mode": family,
                    "location": [_round(value) for value in location],
                    "target": [_round(value) for value in target],
                    "lensMm": _round(lens_mm) if lens_mm is not None else None,
                }
                for view_name, (family, location, target, lens_mm) in zip(view_names, placements, strict=True)
            ],
        },
        "note": (
            "Orbit panels share one distance so a difference between them is the "
            "geometry, not the framing. Interior panels stand inside the subject "
            "at eye height, which is the only framing a room answers to."
        ),
    }


def _montage_sheet(panels, labels, columns, panel_width):
    # The label scale is derived from the sheet width rather than fixed, so
    # a four-panel sheet labels readably at the default panel size.
    return montage.tile(panels, labels, columns=columns, label_scale=max(2, min(4, panel_width // (12 * columns))))


def handle_compare(request):
    """Two generations of one subject, framed identically, labelled, on one sheet.

    A regression is invisible in a single render: the previous picture is
    overwritten by the next one, and "it looks the same as before" is an
    assertion about a picture nobody is holding. So the baseline is RE-RENDERED
    from the checkpoint the previous run left on disk, and both land on one
    sheet with the generation in each panel's label.

    The one framing decision is the whole point: both generations are framed
    from the UNION of their extents, so the camera is identical and any
    difference between two panels of the same view is geometry. Framing each
    generation on its own extent would make a part that grew read as a camera
    change, which is exactly the confusion this sheet exists to remove.

    The baseline is a checkpoint on disk, never the session's own state: it is
    opened, rendered, and the requested blend put back before this returns, so a
    comparison never replaces what the artist is looking at. Nothing in the
    workspace is mutated either way, and the baseline's panels are kept beside
    the sheet.
    """
    baseline_blend = request.get("baselineBlendPath")
    if not baseline_blend:
        raise RuntimeError(
            "A comparison needs baselineBlendPath: the state to compare AGAINST. "
            "Without it there is nothing to regress from, and a sheet of one "
            "generation labelled as if it were a comparison would invite reading "
            "the current build as an improvement over nothing."
        )
    output_dir = request["outputDir"]
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as error:
        raise RuntimeError(f"`outputDir` could not be created at {output_dir}: {error}") from error
    sheet_path = os.path.join(output_dir, request.get("outputName") or "compare.png")
    baseline_dir = os.path.join(output_dir, "baseline")
    try:
        os.makedirs(baseline_dir, exist_ok=True)
    except OSError as error:
        raise RuntimeError(f"compare's baseline folder could not be created at {baseline_dir}: {error}") from error

    viewport = find_optional_viewport_context()
    view_names, resolved = _montage_view_names(request)
    panel = request.get("panelResolution") or {}
    panel_width = int(panel.get("x") or 900)
    panel_height = int(panel.get("y") or 700)
    subject = request.get("subject") or []

    # The union is measured ACROSS both generations before either is rendered,
    # which is why the baseline is opened first: framing is the one thing that
    # must be decided from both sides at once.
    ensure_requested_blend_open(request)
    current_extent = _montage_subject_extent(subject)
    if current_extent is None:
        raise RuntimeError("No mesh objects to frame. Pass `subject` explicitly if the scene is empty or filtered.")

    with _open_for_baseline(baseline_blend, viewport) as (baseline_scene, baseline_viewport):
        baseline_extent = _montage_subject_extent(subject)
        baseline_missing = _subject_names_missing_from_open_blend(subject)
        union = _union_extent(current_extent, baseline_extent)
        if union is None:
            # Unreachable while current_extent is checked above; stated because
            # the guard below is the only thing making that assumption visible.
            raise RuntimeError("Neither generation holds a mesh to frame.")
        placements, centre, radius, distance = _montage_placements(resolved, union[0], union[1])

        baseline_panels, baseline_panel_paths = _render_montage_panels(
            baseline_scene, baseline_viewport, view_names, placements, baseline_dir, panel_width, panel_height, "panel-"
        )

    if not baseline_panels:
        raise RuntimeError(
            f'The baseline blend "{baseline_blend}" produced no panels. It holds none of the '
            f"subject objects ({', '.join(subject) if subject else 'any mesh'}), which is what a "
            "checkpoint from before this part existed looks like. Compare against a run that "
            "already had it, or montage the current build on its own."
        )

    # Re-found, not reused: the baseline swap opened and closed a file, which
    # freed the scene and viewport this handler captured before it.
    scene = bpy.context.scene
    current_viewport = find_optional_viewport_context()
    labels = {
        "baseline": str(request.get("baselineLabel") or "BEFORE"),
        "current": str(request.get("currentLabel") or "AFTER"),
    }

    render_settings = scene.render
    previous_scene_camera = scene.camera
    previous_resolution = (
        render_settings.resolution_x,
        render_settings.resolution_y,
        render_settings.resolution_percentage,
    )
    previous_file_format = render_settings.image_settings.file_format
    previous_filepath = render_settings.filepath
    try:
        panels, panel_paths = _render_montage_panels(
            scene, current_viewport, view_names, placements, output_dir, panel_width, panel_height, "panel-"
        )
    finally:
        scene.camera = previous_scene_camera
        (
            render_settings.resolution_x,
            render_settings.resolution_y,
            render_settings.resolution_percentage,
        ) = previous_resolution
        render_settings.image_settings.file_format = previous_file_format
        render_settings.filepath = previous_filepath

    # Interleaved per view, so the two panels of one view sit side by side and
    # the eye is not asked to hold one generation in memory while it finds the
    # other. The reading order IS the comparison.
    ordered = []
    ordered_labels = []
    ordered_paths = []
    for index, view_name in enumerate(view_names):
        ordered.append(baseline_panels[index])
        ordered_labels.append(f'{labels["baseline"]} {view_name}')
        ordered_paths.append(baseline_panel_paths[index])
        ordered.append(panels[index])
        ordered_labels.append(f'{labels["current"]} {view_name}')
        ordered_paths.append(panel_paths[index])

    columns = _as_int(request.get("columns"), "columns", 2)
    columns = max(1, min(4, columns))
    sheet, layout = _montage_sheet(ordered, ordered_labels, columns, panel_width)
    montage.write_png(sheet_path, sheet)

    return {
        "montagePath": sheet_path,
        "panelPaths": ordered_paths,
        "views": [str(name) for name in view_names],
        "layout": layout,
        "labels": labels,
        "subject": [obj.name for obj in _resolve_probe_objects(subject)] if subject else [],
        "baseline": {
            "blendPath": os.path.abspath(baseline_blend),
            "panelPaths": baseline_panel_paths,
            "missingSubjects": baseline_missing,
            "usedItsOwnExtent": baseline_extent is not None and tuple(baseline_extent) != tuple(current_extent),
        },
        "framing": {
            "family": "interior" if all(f[0] == "interior" for f in placements) else "orbit",
            "center": [_round(value) for value in centre],
            "radius": _round(radius),
            "distance": _round(distance),
            "fromUnion": True,
            "views": [
                {
                    "view": str(view_name),
                    "mode": family,
                    "location": [_round(value) for value in location],
                    "target": [_round(value) for value in target],
                    "lensMm": _round(lens_mm) if lens_mm is not None else None,
                }
                for view_name, (family, location, target, lens_mm) in zip(view_names, placements, strict=True)
            ],
        },
        "note": (
            "Both generations are framed from the union of their extents, so the "
            "camera is identical and a difference between two panels of the same "
            "view is geometry rather than framing. Every panel carries the "
            "generation it is in its label."
            + (
                " Subjects missing from the baseline are listed: a BEFORE panel "
                "without them is a checkpoint from before they existed, not a "
                "rendering fault."
                if baseline_missing
                else ""
            )
        ),
    }


def _subject_names_missing_from_open_blend(subject):
    """Which named subjects the CURRENTLY OPEN blend does not hold.

    Read here rather than guessed, because the answer changes what the sheet
    means: a baseline missing an object named in the brief is a checkpoint from
    before the part existed, and a reader who is not told that will call the
    part absence in the BEFORE panels a rendering fault.
    """
    return [name for name in subject if bpy.data.objects.get(name) is None]


@contextlib.contextmanager
def _open_for_baseline(blend_path, viewport):
    """Swap the session's blend for the baseline and yield the scene to render.

    In this process rather than a second Blender, because the extent maths that
    frames both generations has to be the SAME code in both: two copies in two
    processes is two rules, and a baseline framed by one of them is a comparison
    that proves nothing while looking perfectly legible.

    The live blend is restored afterwards even on failure, because the artist may
    have unsaved work in it and this request only ever meant to read a file. A
    session with unsaved changes in a real blend is REFUSED rather than
    restored-then-resaved, because opening a file discards what is in memory and
    a flag cannot put it back — the same rule, and for the same reason, as
    ensure_requested_blend_open.
    The viewport is RE-FOUND after every open, because bpy.ops.wm.open_mainfile
    frees the old scene and the old area/region pointers along with it. A
    viewport captured before the open is a dangling StructRNA, and the failure it
    produces — a ReferenceError partway through a render — names nothing that
    caused it.
    """
    _refuse_dirty_baseline_swap()
    if not os.path.exists(blend_path):
        raise RuntimeError(
            f'The baseline blend does not exist: "{blend_path}". A comparison needs a checkpoint '
            "on disk to render the earlier generation from; pass one that exists, or montage the "
            "current build on its own."
        )
    previous_path = os.path.abspath(bpy.data.filepath) if bpy.data.filepath else ""
    bpy.ops.wm.open_mainfile(filepath=blend_path)
    try:
        yield bpy.context.scene, find_optional_viewport_context()
    finally:
        if previous_path and os.path.exists(previous_path):
            bpy.ops.wm.open_mainfile(filepath=previous_path)


def _refuse_dirty_baseline_swap():
    """Block a baseline swap that would discard unsaved work in a real blend."""
    current_path = os.path.abspath(bpy.data.filepath) if bpy.data.filepath else ""
    if bpy.data.is_dirty and current_path and not is_discardable_scratch_blend(current_path):
        current_label = current_path or "the current unsaved Blender scene"
        raise RuntimeError(
            f"Blender has unsaved changes in {current_label}, and rendering the baseline means "
            "opening another file, which would discard them. Save or discard your work, then "
            "compare. (A scratch blank is fine to discard and is never blocked.)"
        )


def handle_request(request):
    request_type = request.get("type")
    if request_type == "get-session-context":
        return handle_get_session_context(request)
    if request_type == "geometry-probe":
        return handle_geometry_probe(request)
    if request_type == "montage":
        return handle_montage(request)
    if request_type == "compare":
        return handle_compare(request)
    if request_type == "export":
        # The opener is passed in rather than imported: opening the blend belongs
        # to the session this bridge owns, and export_asset is also runnable
        # outside it (the exporter's own tests), where there is no opener to
        # import from.
        return export_asset.handle_export(request, ensure_requested_blend_open)
    if request_type == "open-blend":
        return handle_open_blend(request)
    if request_type == "reload-blend":
        return handle_reload_blend(request)
    if request_type == "capture-view":
        return handle_capture_view(request)
    if request_type == "execute-python":
        return handle_execute_python(request)
    if request_type == "read-only-python":
        return handle_read_only_python(request)
    if request_type == "render":
        return handle_render(request)
    if request_type == "set-mode":
        return set_mode_request(request)
    if request_type == "shutdown":
        return handle_shutdown(request)
    raise RuntimeError(f"Unsupported Blender bridge request type: {request_type}")


def serve_once():
    """Run the request given as the argument and print its result as JSON.

    The same handle_request the windowed bridge uses, so the two paths cannot
    disagree about what a geometry probe means. `--` marks the payload, the same
    convention runBlenderProcess uses for every other headless script.

    A handler that raises is reported as a JSON error rather than a traceback on
    stderr alone: the caller parses stdout for the answer, and Blender exits 0
    even when a --python script dies, so the error has to arrive in the payload
    or it is discarded.
    """
    raw = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "{}"
    try:
        request = json.loads(raw)
    except ValueError as error:
        print("__PI_BLENDER_JSON_START__")
        print(json.dumps({"ok": False, "error": f"Invalid request payload: {error}"}))
        print("__PI_BLENDER_JSON_END__")
        return

    try:
        result = handle_request(request)
    except Exception as error:
        print("__PI_BLENDER_JSON_START__")
        print(json.dumps({"ok": False, "error": str(error), "traceback": traceback.format_exc()}))
        print("__PI_BLENDER_JSON_END__")
        return

    print("__PI_BLENDER_JSON_START__")
    print(json.dumps({"ok": True, "result": result}))
    print("__PI_BLENDER_JSON_END__")


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
        if PENDING_QUIT:
            # The response is on disk and closed; only now may the UI go.
            request_quit_after_response()
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
    #
    # The content carries the pid, so the TS side can ask the OS whether that
    # process actually exists instead of trusting a file's mtime alone. A
    # fresh-looking heartbeat from a dead Blender would otherwise make the
    # guard believe a UI exists and refuse to relaunch it. The pid is a hint,
    # not proof: the mtime is still the freshness signal, and the process
    # check can only ever turn "alive" into "dead", never the reverse.
    path = os.path.join(BRIDGE_DIR, "heartbeat")
    # blendPath is what makes the heartbeat usable as a claim: a pi process can
    # die and leave its Blender running and beating, and that live UI still owns
    # the blend it has open. Without this, a dead owner's claim would be taken
    # over and the newcomer would open a second UI on a file the first is still
    # writing. bpy.data.filepath is None on an unsaved scene, which is exactly
    # the "own nothing yet" answer.
    payload = json.dumps(
        {"pid": os.getpid(), "at": time.time(), "blendPath": bpy.data.filepath or None}
    )
    try:
        # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(payload)
    except OSError:
        # First poll of a fresh bridge dir, or a read-only one. Fall back to a
        # pure timestamp touch: mtime alone is the legacy contract and still
        # enough for the freshness check.
        try:
            # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
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
if not (os.environ.get("PI_BLENDER_BRIDGE_DIR")):
    print(
        f'[pi-blender] warning: no bridge dir in the environment; falling back to "{BRIDGE_DIR}". '
        "The pi extension reads its own per-instance dir and will NOT see this UI, so every blender_* call "
        "will time out. Start Blender through the extension (or set PI_BLENDER_BRIDGE_DIR) instead."
    )

# --serve is the headless entry point: one request, run through the same
# dispatch table, print the result as JSON, exit. Polling a queue only makes
# sense for a long-lived process, and this module is otherwise imported by
# those handlers so a headless run and a windowed run cannot drift apart.
#
# Guarded on the flag rather than on bpy.app.background, because the handlers
# that need a VIEW_3D call find_viewport_context() and must still refuse when
# there is none — the flag says why the process has no window, not that window
# work is impossible.
if "--serve" in sys.argv:
    serve_once()
else:
    recover_orphaned_claims()
    if not bpy.app.timers.is_registered(poll_requests):
        bpy.app.timers.register(poll_requests, first_interval=POLL_INTERVAL_SECONDS, persistent=True)
