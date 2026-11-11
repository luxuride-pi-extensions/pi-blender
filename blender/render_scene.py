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
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
    except OSError as exc:
        raise RuntimeError(f"could not create the render directory: {exc}") from exc
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

def compose_review_sheet(panels, output_path, columns=2, gutter=8):
    """Tile rendered panels into one sheet without leaving Blender.

    NumPy and `bpy.data.images` ship with Blender, so this needs no dependency
    the extension does not already have. Panels are loaded as scene-linear
    pixels and written back through an sRGB image, which is the round trip a
    saved PNG takes; reading and writing the same buffer keeps the colours the
    renders had. A panel that cannot be read is reported by name, not silently
    replaced with a blank tile.
    """
    # pi-lens-ignore: ast-grep:unresolved-import-python (NumPy ships with Blender)
    import numpy as np  # pyright: ignore[reportMissingImports]

    if not panels:
        raise RuntimeError("a review sheet needs at least one panel")
    loaded = []
    try:
        for panel in panels:
            path = panel["file"]
            image = bpy.data.images.load(path, check_existing=False)
            pixels = np.array(image.pixels[:], dtype=np.float32).reshape(
                image.size[1], image.size[0], 4
            )
            loaded.append((panel, pixels))
            bpy.data.images.remove(image)
    except (OSError, RuntimeError) as error:
        raise RuntimeError(f"could not read a review panel: {error}") from error

    panel_width, panel_height = 640, 480
    resized = []
    for panel, pixels in loaded:
        # Aspect is preserved by fitting inside the tile, never by stretching:
        # a square or portrait hero squeezed into 4:3 would read as geometry.
        scale = min(panel_width / pixels.shape[1], panel_height / pixels.shape[0])
        target_width = max(1, int(pixels.shape[1] * scale))
        target_height = max(1, int(pixels.shape[0] * scale))
        if target_width != pixels.shape[1] or target_height != pixels.shape[0]:
            row_index = np.linspace(0, pixels.shape[0] - 1, target_height).astype(np.int32)
            column_index = np.linspace(0, pixels.shape[1] - 1, target_width).astype(np.int32)
            pixels = pixels[np.ix_(row_index, column_index)]
        tile = np.full((panel_height, panel_width, 4), 0.06, dtype=np.float32)
        tile[:, :, 3] = 1.0
        top = (panel_height - target_height) // 2
        left = (panel_width - target_width) // 2
        tile[top : top + target_height, left : left + target_width] = pixels
        resized.append((panel, tile))
    loaded = resized
    rows = (len(loaded) + columns - 1) // columns
    sheet_width = columns * panel_width + (columns + 1) * gutter
    sheet_height = rows * panel_height + (rows + 1) * gutter
    sheet = np.full((sheet_height, sheet_width, 4), 0.06, dtype=np.float32)
    sheet[:, :, 3] = 1.0
    for index, (_panel, pixels) in enumerate(loaded):
        column = index % columns
        row = index // columns
        x = gutter + column * (panel_width + gutter)
        y_from_top = gutter + row * (panel_height + gutter)
        y = sheet_height - y_from_top - panel_height
        sheet[y : y + panel_height, x : x + panel_width] = pixels

    image = bpy.data.images.new(
        "pi_review_sheet", width=sheet_width, height=sheet_height, alpha=True
    )
    image.colorspace_settings.name = "sRGB"
    image.pixels.foreach_set(sheet.ravel())
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
    except OSError as exc:
        raise RuntimeError(f"could not create the review-sheet directory: {exc}") from exc
    image.filepath_raw = output_path
    image.file_format = "PNG"
    image.save()
    bpy.data.images.remove(image)
    return {"path": output_path, "width": sheet_width, "height": sheet_height}

