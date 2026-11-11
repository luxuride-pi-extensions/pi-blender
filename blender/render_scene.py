"""One scene-render implementation for every headless Blender path.

`blender_render` and a module's branch run both produce a camera render, and
they used to do it with two scripts. The branch renderer never chose an engine
at all, so the engine a branch image came from was unrecorded, and the render
tool's preference list was silently dropped when assigning it raised. Both now
call `render_scene`, so "which engine did that render use" has one answer and a
preference list is actually walked.

Imported by generated Blender scripts, not by the extension: everything here
needs a live `bpy`.
"""

import os

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]


def set_engine(scene, desired):
    """Select the first usable engine from a name or a preference list.

    `desired` may be a single identifier or an ordered list of candidates
    (`mapBackgroundRenderEngine` returns a list for version-dependent names).
    Returns the engine the scene ended up with; raises when nothing usable
    exists rather than silently rendering with whichever engine was current.
    """
    if not desired:
        return scene.render.engine

    preferences = [desired] if isinstance(desired, str) else list(desired)
    for candidate in preferences:
        try:
            scene.render.engine = candidate
        except (TypeError, ValueError):
            continue
        return scene.render.engine

    try:
        available = {
            item.identifier
            for item in scene.render.bl_rna.properties["engine"].enum_items
        }
    except (AttributeError, KeyError, TypeError):
        available = set()
    # Workbench is deliberately absent: it is a flat, unlit viewport mode, and as
    # a last resort it would replace a requested Cycles/EEVEE image with one no
    # critic can judge. An explicit `workbench` request still reaches it above.
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
        if candidate in available:
            scene.render.engine = candidate
            return scene.render.engine
    raise RuntimeError(
        f'No usable render engine for "{desired}"; this build offers: '
        + (", ".join(sorted(available)) or "nothing enumerable")
    )


def render_scene(payload):
    """Render the current scene, then describe what was rendered.

    The camera and the engine are the two settings that make a render
    comparable between callers, so both are reported back: `resolvedEngine` is
    what the build actually used, and `requestedEngine` is what the caller asked
    for (None when it deferred to the scene).
    """
    scene = bpy.context.scene
    requested_engine = payload.get("renderEngine")
    resolved_engine = set_engine(scene, requested_engine)

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
    scene.render.resolution_percentage = int(
        resolution.get("percentage", scene.render.resolution_percentage)
    )

    samples = payload.get("samples")
    if samples is not None and hasattr(scene, "cycles"):
        scene.cycles.samples = int(samples)

    output_path = payload["outputPath"]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = output_path
    bpy.ops.render.render(write_still=True)

    return {
        "outputPath": output_path,
        "cameraName": scene.camera.name if scene.camera else None,
        "resolvedEngine": resolved_engine,
        "requestedEngine": requested_engine,
        "resolution": {
            "x": int(scene.render.resolution_x),
            "y": int(scene.render.resolution_y),
            "percentage": int(scene.render.resolution_percentage),
        },
    }
