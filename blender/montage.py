"""Turn several rendered views into one labelled sheet.

Why a module rather than part of live-bridge.py: the framing arithmetic and the
tiling are pure computation with no bridge or request plumbing in it, and
keeping them separate is what lets test/montage-test.py exercise them against
known numbers instead of against a render.

The label font is a 5x7 bitmap rather than a real typeface because the label has
one job -- stop a reader from guessing which side of the subject a panel shows.
A guess there produces a confident wrong verdict, which is the most expensive
failure this tool can have.
"""

import math
import os

import numpy

import bpy  # noqa: F401  # available only inside Blender; the tests stub it

# 5 wide, 7 tall. Each string is one row, '#' is ink.
_GLYPHS = {
    "A": ("  #  ", " # # ", "#   #", "#   #", "#####", "#   #", "#   #"),
    "B": ("#### ", "#   #", "#   #", "#### ", "#   #", "#   #", "#### "),
    "C": (" ### ", "#   #", "#    ", "#    ", "#    ", "#   #", " ### "),
    "D": ("#### ", "#   #", "#   #", "#   #", "#   #", "#   #", "#### "),
    "E": ("#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#####"),
    "F": ("#####", "#    ", "#    ", "#### ", "#    ", "#    ", "#    "),
    "G": (" ### ", "#   #", "#    ", "#  ##", "#   #", "#   #", " ### "),
    "H": ("#   #", "#   #", "#   #", "#####", "#   #", "#   #", "#   #"),
    "I": (" ### ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "),
    "J": ("  ###", "   # ", "   # ", "   # ", "   # ", "#  # ", " ##  "),
    "K": ("#   #", "#  # ", "# #  ", "##   ", "# #  ", "#  # ", "#   #"),
    "L": ("#    ", "#    ", "#    ", "#    ", "#    ", "#    ", "#####"),
    "M": ("#   #", "## ##", "# # #", "#   #", "#   #", "#   #", "#   #"),
    "N": ("#   #", "##  #", "# # #", "#  ##", "#   #", "#   #", "#   #"),
    "O": (" ### ", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "),
    "P": ("#### ", "#   #", "#   #", "#### ", "#    ", "#    ", "#    "),
    "Q": (" ### ", "#   #", "#   #", "#   #", "# # #", "#  # ", " ## #"),
    "R": ("#### ", "#   #", "#   #", "#### ", "# #  ", "#  # ", "#   #"),
    "S": (" ####", "#    ", "#    ", " ### ", "    #", "    #", "#### "),
    "T": ("#####", "  #  ", "  #  ", "  #  ", "  #  ", "  #  ", "  #  "),
    "U": ("#   #", "#   #", "#   #", "#   #", "#   #", "#   #", " ### "),
    "V": ("#   #", "#   #", "#   #", "#   #", "#   #", " # # ", "  #  "),
    "W": ("#   #", "#   #", "#   #", "# # #", "# # #", "## ##", "#   #"),
    "X": ("#   #", "#   #", " # # ", "  #  ", " # # ", "#   #", "#   #"),
    "Y": ("#   #", "#   #", " # # ", "  #  ", "  #  ", "  #  ", "  #  "),
    "Z": ("#####", "    #", "   # ", "  #  ", " #   ", "#    ", "#####"),
    "0": (" ### ", "#   #", "#  ##", "# # #", "##  #", "#   #", " ### "),
    "1": ("  #  ", " ##  ", "  #  ", "  #  ", "  #  ", "  #  ", " ### "),
    "2": (" ### ", "#   #", "    #", "   # ", "  #  ", " #   ", "#####"),
    "3": ("#####", "   # ", "  #  ", "   # ", "    #", "#   #", " ### "),
    "4": ("   # ", "  ## ", " # # ", "#  # ", "#####", "   # ", "   # "),
    "5": ("#####", "#    ", "#### ", "    #", "    #", "#   #", " ### "),
    "6": ("  ## ", " #   ", "#    ", "#### ", "#   #", "#   #", " ### "),
    "7": ("#####", "    #", "   # ", "  #  ", " #   ", " #   ", " #   "),
    "8": (" ### ", "#   #", "#   #", " ### ", "#   #", "#   #", " ### "),
    "9": (" ### ", "#   #", "#   #", " ####", "    #", "   # ", " ##  "),
    " ": ("     ", "     ", "     ", "     ", "     ", "     ", "     "),
    "-": ("     ", "     ", "     ", "#####", "     ", "     ", "     "),
    ".": ("     ", "     ", "     ", "     ", "     ", " ##  ", " ##  "),
    "/": ("    #", "    #", "   # ", "  #  ", " #   ", "#    ", "#    "),
    "+": ("     ", "  #  ", "  #  ", "#####", "  #  ", "  #  ", "     "),
    "(": ("   # ", "  #  ", " #   ", " #   ", " #   ", "  #  ", "   # "),
    ")": (" #   ", "  #  ", "   # ", "   # ", "   # ", "  #  ", " #   "),
    ",": ("     ", "     ", "     ", "     ", " ##  ", " ##  ", "#    "),
}

GLYPH_WIDTH = 5
GLYPH_HEIGHT = 7

# Azimuth in degrees around +Z, 0 being the -Y side (Blender's front view), and
# elevation above the horizon. A preset is a pair; anything unlisted is refused
# rather than approximated, because an angle a reader cannot name is an angle a
# critic cannot ask for again.
ANGLE_PRESETS = {
    "front": (0.0, 0.0),
    "back": (180.0, 0.0),
    "left": (-90.0, 0.0),
    "right": (90.0, 0.0),
    "top": (0.0, 89.0),
    "bottom": (0.0, -89.0),
    "three-quarter": (45.0, 20.0),
    "three-quarter-left": (-45.0, 20.0),
    "three-quarter-high": (45.0, 45.0),
    "profile-left": (-90.0, 10.0),
    "profile-right": (90.0, 10.0),
    # Every preset keeps the camera on a fixed orbit: the tool places cameras,
    # it never aims at a subject, because a role that reframes what it judges
    # never converges on anything.
    "front-high": (0.0, 35.0),
}


def resolve_angle(name):
    key = str(name).strip().lower()
    if key not in ANGLE_PRESETS:
        known = ", ".join(sorted(ANGLE_PRESETS))
        raise ValueError(f'Unknown view "{name}". Known views: {known}.')
    return ANGLE_PRESETS[key]


# 50mm on a 36mm sensor: a normal-to-slightly-long lens, so a panel does not
# distort a face the way a wide one would.
DEFAULT_LENS_MM = 50.0
DEFAULT_SENSOR_MM = 36.0
# Breathing room around the subject's bounding sphere, as a fraction of it.
DEFAULT_MARGIN = 1.12


def read_panel(path):
    """Load a rendered PNG as a float RGBA array of shape (height, width, 4).

    Blender's own image loader is used rather than a PNG library: it is already
    here, and it is the same code that wrote the panel.
    """
    # pi-lens-ignore: ast-grep:unresolved-import-python
    import bpy  # noqa: PLC0415

    image = bpy.data.images.load(path, check_existing=False)
    try:
        width, height = image.size
        pixels = numpy.empty(width * height * 4, dtype=numpy.float32)
        image.pixels.foreach_get(pixels)
        return pixels.reshape((height, width, 4))
    finally:
        bpy.data.images.remove(image)


def write_png(path, array):
    """Save a float RGBA array as a PNG, bottom row first as Blender wants it.

    A sheet composed with row 0 at the top has to be flipped on the way out, or
    the labels end up under the panels they identify.
    """
    # pi-lens-ignore: ast-grep:unresolved-import-python
    import bpy  # noqa: PLC0415

    height, width = array.shape[0], array.shape[1]
    name = "montage-sheet"
    existing = bpy.data.images.get(name)
    if existing is not None:
        bpy.data.images.remove(existing)
    image = bpy.data.images.new(name, width, height, alpha=True)
    try:
        image.pixels.foreach_set(numpy.flipud(array).reshape(-1).astype(numpy.float32))
        image.filepath_raw = path
        image.file_format = "PNG"
        image.save()
    finally:
        bpy.data.images.remove(image)
    return path


def framing_distance(radius, lens_mm=DEFAULT_LENS_MM, sensor_mm=DEFAULT_SENSOR_MM, margin=DEFAULT_MARGIN):
    """Distance at which a sphere of `radius` fills the frame.

    Derived from the lens rather than multiplied in, because a fixed multiplier
    frames a 50mm lens and crops a 200mm one. The tangent, not the sine: the
    bounding sphere's silhouette is a circle, and it is the circle's half-angle
    that has to match the camera's.
    """
    half_angle = math.atan((sensor_mm / 2.0) / float(lens_mm))
    return radius / math.sin(half_angle) * float(margin)


def camera_location(center, distance, azimuth_degrees, elevation_degrees):
    """Where a camera sits for one angle, `distance` from the subject centre.

    Every preset keeps the same distance, so no angle silently frames the
    subject tighter than another and a sheet compares like with like.
    """
    azimuth = math.radians(azimuth_degrees)
    elevation = math.radians(elevation_degrees)
    # Horizontal, then lifted: the order matters for elevation, since elevation
    # rotates the horizontal component rather than replacing it.
    horizontal = math.cos(elevation) * distance
    return (
        center[0] + math.sin(azimuth) * horizontal,
        center[1] - math.cos(azimuth) * horizontal,
        center[2] + math.sin(elevation) * distance,
    )


def draw_label(sheet, text, origin_x, origin_y, preferred_scale, max_width=None, ink=(1.0, 1.0, 1.0, 1.0)):
    """Draw text top-left-anchored at (origin_x, origin_y) directly into the sheet.

    In-place, because a sheet the size of a full montage is a large allocation to
    throw away per label.

    `max_width` shrinks the text rather than letting it run past that width. A
    label that reaches the next panel identifies the wrong view, which is worse
    than a small one.
    """
    scale = fit_label_scale(text, max_width, preferred_scale) if max_width else preferred_scale
    height, width = sheet.shape[0], sheet.shape[1]
    cursor_x = int(origin_x)
    for character in str(text):
        glyph = _GLYPHS.get(character) or _GLYPHS.get(character.upper()) or _GLYPHS[" "]
        for row_index, row in enumerate(glyph):
            for column_index, cell in enumerate(row):
                if cell != "#":
                    continue
                x0 = cursor_x + column_index * scale
                y0 = int(origin_y) + row_index * scale
                if x0 < 0 or y0 < 0 or x0 + scale > width or y0 + scale > height:
                    continue
                sheet[y0 : y0 + scale, x0 : x0 + scale] = ink
        cursor_x += (GLYPH_WIDTH + 1) * scale
    return cursor_x


def fit_label_scale(text, available_width, preferred_scale):
    """The largest scale at which `text` still fits inside `available_width`.

    A label that runs into the next panel identifies the wrong view, which is
    worse than a small one.
    """
    advance = (GLYPH_WIDTH + 1) * preferred_scale
    needed = max(1, len(text)) * advance
    if needed <= available_width:
        return preferred_scale
    return max(1, int(available_width // (len(text) * (GLYPH_WIDTH + 1))))


def _resample(panel, width, height):
    """Nearest-neighbour resample. A montage is a contact sheet, not a print."""
    source_height, source_width = panel.shape[0], panel.shape[1]
    rows = (numpy.arange(height) * source_height // height).clip(0, source_height - 1)
    columns = (numpy.arange(width) * source_width // width).clip(0, source_width - 1)
    return panel[rows][:, columns]


def tile(panels, labels, columns=2, label_scale=3, gutter=8, background=(0.0, 0.0, 0.0, 1.0)):
    """Compose labelled panels into one sheet.

    `panels` are float RGBA arrays. All panels are resampled to a common size
    derived from the first one, so a panel that came back at a different
    resolution cannot shift every panel after it.
    """
    if not panels:
        raise ValueError("tile() needs at least one panel")
    if len(panels) != len(labels):
        raise ValueError(f"{len(panels)} panels but {len(labels)} labels")

    columns = max(1, min(int(columns), len(panels)))
    rows = (len(panels) + columns - 1) // columns

    first = panels[0]
    aspect = first.shape[1] / float(first.shape[0])
    panel_width = int(first.shape[1])
    panel_height = int(first.shape[0])
    band = GLYPH_HEIGHT * label_scale + 6

    sheet_width = columns * panel_width + (columns + 1) * gutter
    sheet_height = rows * (panel_height + band) + (rows + 1) * gutter
    sheet = numpy.zeros((sheet_height, sheet_width, 4), dtype=numpy.float32)
    sheet[:, :] = numpy.asarray(background, dtype=numpy.float32)

    band_colour = numpy.asarray((0.05, 0.05, 0.05, 1.0), dtype=numpy.float32)
    for index, panel in enumerate(panels):
        row = index // columns
        column = index % columns
        x0 = gutter + column * (panel_width + gutter)
        y0 = gutter + row * (panel_height + band)
        # Band first, then the panel, then the label: a light panel must not
        # erase the label that identifies it.
        sheet[y0 : y0 + band, x0 : x0 + panel_width] = band_colour
        resized = panel if panel.shape[0] == panel_height and panel.shape[1] == panel_width else _resample(panel, panel_width, panel_height)
        sheet[y0 + band : y0 + band + panel_height, x0 : x0 + panel_width] = resized
        # The label is capped to its own panel width, so a name too long for a
        # narrow panel shrinks instead of running into the next one.
        draw_label(sheet, labels[index], x0, y0 + 2, label_scale, max_width=panel_width)

    return sheet, {"panelWidth": panel_width, "panelHeight": panel_height, "aspect": aspect, "columns": columns, "rows": rows}
