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

    shrinking = sum(1 for a, b in zip(samples, samples[1:]) if b["radius"] <= a["radius"])
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

        tolerance = float(spec.get("tolerance") or default_tolerance)
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

    tolerance = float(request.get("tolerance") or 0.002)
    specifications = request.get("specifications") or None
    if specifications is not None and "scale" not in requested:
        # Naming the dimensions is the request; requiring the caller to also
        # remember the check name is a way of silently measuring nothing.
        requested = list(requested) + ["scale"]
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

    columns = int(request.get("columns") or (1 if len(view_names) <= 2 else 2))
    columns = max(1, min(4, columns))
    panel = request.get("panelResolution") or {}
    panel_width = int(panel.get("x") or 900)
    panel_height = int(panel.get("y") or 700)

    output_dir = request["outputDir"]
    os.makedirs(output_dir, exist_ok=True)
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
    os.makedirs(output_dir, exist_ok=True)
    sheet_path = os.path.join(output_dir, request.get("outputName") or "compare.png")
    baseline_dir = os.path.join(output_dir, "baseline")
    os.makedirs(baseline_dir, exist_ok=True)

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

    columns = int(request.get("columns") or 2)
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
