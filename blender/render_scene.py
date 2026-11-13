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

# A 3x5 font drawn with NumPy. Sheet labels have to survive headless Blender,
# which has no reliable text API before a render, and a critic must not need the
# JSON sidecar to know which panel it is looking at.
_FONT = {
    "A": ("111", "101", "111", "101", "101"),
    "B": ("110", "101", "110", "101", "110"),
    "C": ("111", "100", "100", "100", "111"),
    "D": ("110", "101", "101", "101", "110"),
    "E": ("111", "100", "110", "100", "111"),
    "F": ("111", "100", "110", "100", "100"),
    "G": ("111", "100", "101", "101", "111"),
    "H": ("101", "101", "111", "101", "101"),
    "I": ("111", "010", "010", "010", "111"),
    "J": ("001", "001", "001", "101", "111"),
    "K": ("101", "101", "110", "101", "101"),
    "L": ("100", "100", "100", "100", "111"),
    "M": ("101", "111", "111", "101", "101"),
    "N": ("101", "111", "111", "111", "101"),
    "O": ("111", "101", "101", "101", "111"),
    "P": ("111", "101", "111", "100", "100"),
    "Q": ("111", "101", "101", "111", "001"),
    "R": ("111", "101", "110", "101", "101"),
    "S": ("111", "100", "111", "001", "111"),
    "T": ("111", "010", "010", "010", "010"),
    "U": ("101", "101", "101", "101", "111"),
    "V": ("101", "101", "101", "101", "010"),
    "W": ("101", "101", "111", "111", "101"),
    "X": ("101", "101", "010", "101", "101"),
    "Y": ("101", "101", "010", "010", "010"),
    "Z": ("111", "001", "010", "100", "111"),
    "0": ("111", "101", "101", "101", "111"),
    "1": ("010", "110", "010", "010", "111"),
    "2": ("111", "001", "111", "100", "111"),
    "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"),
    "7": ("111", "001", "001", "010", "010"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "111"),
    "-": ("000", "000", "111", "000", "000"),
    ".": ("000", "000", "000", "000", "010"),
    ":": ("000", "010", "000", "010", "000"),
    "/": ("001", "001", "010", "100", "100"),
}


def _draw_label(pixels, text, scale=2):
    """Draw an uppercase label into the top strip of a panel."""
    height, width, _channels = pixels.shape
    strip = min(height, 6 * scale + 6)
    # Blender image buffers are bottom-up, so the visual top strip is the last
    # rows of the array. Drawing into rows 0..strip would put the label at the
    # bottom of the saved PNG.
    top_row = height - strip
    pixels[top_row:height, :, :3] = 0.02
    x = 6
    for character in str(text).upper():
        glyph = _FONT.get(character)
        if glyph is None:
            x += 4 * scale
            continue
        for row, line in enumerate(glyph):
            for column, bit in enumerate(line):
                if bit != "1":
                    continue
                bottom = top_row + 3 + (4 - row) * scale
                left = x + column * scale
                if bottom + scale > height or left + scale > width:
                    continue
                pixels[bottom : bottom + scale, left : left + scale, :3] = 0.95
        x += 4 * scale
        if x >= width - 6:
            break


def compose_review_sheet(panels, output_path, columns=2, gutter=8):
    """Tile rendered panels into one sheet without leaving Blender.

    NumPy and `bpy.data.images` ship with Blender, so this needs no dependency
    the extension does not already have. Panels are loaded as scene-linear
    pixels and written back through an sRGB image, which is the round trip a
    saved PNG takes; reading and writing the same buffer keeps the colours the
    renders had. Each panel carries a drawn label: the tool result also names
    the panels, but a critic that reads only the image must still know which
    generation and shot it is looking at. A panel that cannot be read is
    reported by name, not silently replaced with a blank tile.
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
        _draw_label(tile, panel.get("label") or panel.get("name") or "")
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

