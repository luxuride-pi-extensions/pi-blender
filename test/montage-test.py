#!/usr/bin/env python3
"""Exercise montage.py's tiling and labelling against known pixel arrays.

The tiling has no Blender in it on purpose, so it can be tested without one:
every assertion below is about where a pixel ended up, which is a fact about the
code rather than about a render.

Run: blender --background --python test/montage-test.py
Exit code 0 means every assertion held.
"""

import os
import sys

import numpy

sys.path.insert(0, "/var/home/lux/Projects/pi-blender/blender")

import montage  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
    print(f"  {'ok  ' if condition else 'FAIL'}: {message}")
    sys.stdout.flush()


def solid(width, height, colour):
    panel = numpy.zeros((height, width, 4), dtype=numpy.float32)
    panel[:, :] = colour
    return panel


RED = (1.0, 0.0, 0.0, 1.0)
GREEN = (0.0, 1.0, 0.0, 1.0)
BLUE = (0.0, 0.0, 1.0, 1.0)
WHITE = (1.0, 1.0, 1.0, 1.0)


def centre_pixel(sheet, x, y):
    return tuple(float(v) for v in sheet[y, x])


# --- the label must be legible ink on a dark band, not panel colour -------
panel = solid(40, 30, WHITE)
sheet, layout = montage.tile([panel], ["front"], columns=1, label_scale=2, gutter=4)
check(layout["panelWidth"] == 40, f"panel width survives tiling: {layout['panelWidth']}")
check(layout["panelHeight"] == 30, f"panel height survives tiling: {layout['panelHeight']}")
check(
    montage.GLYPH_HEIGHT * 2 + 6 <= sheet.shape[0] - 30 - 4,
    "the sheet has room for a label band above the panel",
)

band_rows = slice(4, 4 + montage.GLYPH_HEIGHT * 2 + 6)
band = sheet[band_rows, 4 : 4 + 40, :3]
check(float(band.min()) < 0.2, f"the label band is dark whatever the panel colour: min {band.min():.3f}")
ink = sheet[band_rows, 4 : 4 + 40, :3]
check(float(ink.max()) > 0.8, f"some ink was drawn in the band: max {ink.max():.3f}")

# --- panel order and placement -------------------------------------------
sheet, layout = montage.tile(
    [solid(20, 10, RED), solid(20, 10, GREEN), solid(20, 10, BLUE), solid(20, 10, WHITE)],
    ["front", "left", "three-quarter", "back"],
    columns=2,
    label_scale=2,
    gutter=4,
)
band_h = montage.GLYPH_HEIGHT * 2 + 6
gutter = 4
pw = ph = None
check(layout["columns"] == 2 and layout["rows"] == 2, f"four panels tile 2x2: {layout['columns']}x{layout['rows']}")
check(sheet.shape[1] == 2 * 20 + 3 * gutter, f"sheet width is 2 panels plus 3 gutters: {sheet.shape}")
check(sheet.shape[0] == 2 * (10 + band_h) + 3 * gutter, f"sheet height counts the label band: {sheet.shape}")

# panel 0 at (gutter, gutter+band), panel 1 to its right, panel 2 below panel 0
top_left = centre_pixel(sheet, gutter + 10, gutter + band_h + 5)
top_right = centre_pixel(sheet, gutter + 20 + gutter + 10, gutter + band_h + 5)
bottom_left = centre_pixel(sheet, gutter + 10, gutter + 10 + band_h + gutter + band_h + 5)
check(top_left[:3] == RED[:3], f"panel 0 is red in the top-left slot: {top_left[:3]}")
check(top_right[:3] == GREEN[:3], f"panel 1 is green to its right: {top_right[:3]}")
check(bottom_left[:3] == BLUE[:3], f"panel 2 wraps to the next row: {bottom_left[:3]}")

# --- a panel of a different size cannot shift the others ------------------
mixed, mixed_layout = montage.tile(
    [solid(20, 10, RED), solid(60, 30, GREEN)],
    ["front", "left"],
    columns=2,
    label_scale=2,
    gutter=4,
)
check(mixed_layout["panelWidth"] == 20, "panel size comes from the FIRST panel, so a later odd size cannot shift the grid")
check(centre_pixel(mixed, gutter + 10, gutter + band_h + 5)[:3] == RED[:3], "the first panel keeps its slot next to a resized one")

# --- a label is scaled to its own panel, never across into the next one ----
def label_extent(text, scale):
    """Width in pixels draw_label will use for `text` at `scale`."""
    return max(1, len(text)) * (montage.GLYPH_WIDTH + 1) * scale


check(
    montage.fit_label_scale("front", 400, 3) == 3,
    "a short label keeps the preferred scale",
)
long_name = "three-quarter-left"
fitted = montage.fit_label_scale(long_name, 160, 3)
check(
    label_extent(long_name, fitted) <= 160,
    f"a name too long for its panel is scaled down to fit: {label_extent(long_name, fitted)} <= 160",
)
check(fitted >= 1, f"fitting never drops below one readable pixel per glyph cell: {fitted}")

# A label that ignored its panel would still draw every glyph; only the
# sheet-level call passes max_width, so the cap is asserted through tile.
canvas = numpy.zeros((40, 400, 4), dtype=numpy.float32)
montage.draw_label(canvas, long_name, 2, 2, 3, max_width=160)
capped_columns = numpy.where((canvas[:, :, 0] > 0.3).any(axis=0))[0]
check(
    len(capped_columns) == 0 or int(capped_columns.max()) < 160,
    f"draw_label honours max_width: last ink column {int(capped_columns.max()) if len(capped_columns) else -1}",
)
uncapped = numpy.zeros((40, 400, 4), dtype=numpy.float32)
montage.draw_label(uncapped, long_name, 2, 2, 3)
check(
    label_extent(long_name, 3) > 160,
    f"the same label uncapped would overrun: {label_extent(long_name, 3)} > 160",
)

# The whole point: no two panels may be labelled by text that belongs to the
# next one, so every label must fit inside its own panel width.
sheet, layout = montage.tile(
    [solid(160, 120, RED), solid(160, 120, GREEN), solid(160, 120, BLUE), solid(160, 120, WHITE)],
    ["front", "left", "three-quarter", "top"],
    columns=2,
    gutter=4,
)
band_h = montage.GLYPH_HEIGHT * 3 + 6
gutter = 4
for index, (row, column) in enumerate(((0, 0), (0, 1), (1, 0), (1, 1))):
    x0 = gutter + column * (160 + gutter)
    y0 = gutter + row * (120 + band_h)
    band = sheet[y0 : y0 + band_h, x0 : x0 + 160]
    # Alpha is 1 everywhere, so ink is the RED channel specifically: an ink
    # pixel is white, the band is near-black. The label must end inside the
    # panel, or it is identifying the next one.
    ink_columns = numpy.where((band[:, :, 0] > 0.3).any(axis=0))[0]
    check(
        len(ink_columns) == 0 or int(ink_columns.max()) < 160,
        f"the label for panel {index + 1} stays inside its own panel: "
        f"last ink column {int(ink_columns.max()) if len(ink_columns) else -1}",
    )

# --- angles ---------------------------------------------------------------
front_angle, front_placement = montage.resolve_angle("front")
check(front_angle == (0.0, 0.0) and front_placement is None, "front is an orbit preset: an angle and no placement")
check(montage.resolve_angle("Three-Quarter")[0] == (45.0, 20.0), "angle names are case-insensitive")
corner_angle, corner_placement = montage.resolve_angle("interior-corner")
check(corner_angle is None and corner_placement is not None, "an interior preset resolves to a placement, not an angle")
try:
    montage.resolve_angle("hero-angle")
    check(False, "an unknown angle was accepted")
except ValueError as error:
    check("Known views" in str(error), f"an unknown angle lists the known ones: {error}")
    check("interior-corner" in str(error), f"the known list includes the interior family: {error}")

# --- the orbit invariant: every preset sits the same distance from the
# centre, so no preset silently frames the subject tighter than another.
centre = (1.0, 2.0, 3.0)
radius = 4.0
distance = montage.framing_distance(radius)
check(
    distance > radius,
    f"the camera sits outside the subject's bounding sphere: {distance:.3f} > {radius}",
)
distances = {}
for name in montage.ANGLE_PRESETS:
    azimuth, elevation = montage.ANGLE_PRESETS[name]
    x, y, z = montage.camera_location(centre, distance, azimuth, elevation)
    distances[name] = round(((x - centre[0]) ** 2 + (y - centre[1]) ** 2 + (z - centre[2]) ** 2) ** 0.5, 4)
check(len(set(distances.values())) == 1, f"every preset orbits at one radius: {sorted(set(distances.values()))}")

# A longer lens needs the camera further back, or the same subject would be
# framed tighter and a sheet would compare unlike with like.
check(
    montage.framing_distance(radius, lens_mm=200.0) > distance,
    "a longer lens pulls the camera back rather than cropping the subject",
)
check(
    montage.framing_distance(radius * 2) > distance,
    "a bigger subject pulls the camera back",
)
check(
    montage.framing_distance(radius, margin=2.0) > distance,
    "a wider margin pulls the camera back",
)

front = montage.camera_location(centre, distance, 0.0, 0.0)
left = montage.camera_location(centre, distance, -90.0, 0.0)
check(abs(front[0] - centre[0]) < 1e-6, "front stays on the centre's X, so it looks along +Y")
check(abs(front[1] - (centre[1] - distance)) < 1e-6, f"front sits back along -Y, the Blender front view: {front[1]:.3f}")
check(abs(left[0] - (centre[0] - distance)) < 1e-6, f"left sits back along -X: {left[0]:.3f}")
check(abs(left[1] - centre[1]) < 1e-6, "left stays on the centre's Y, so it looks along +X")

right = montage.camera_location(centre, distance, 90.0, 0.0)
check(right[0] > centre[0], f"right is on the opposite side from left: {right[0]:.3f}")

high = montage.camera_location(centre, distance, 0.0, 89.0)
check(high[2] > centre[2], f"top looks down from above: {high[2]:.3f}")
low = montage.camera_location(centre, distance, 0.0, -20.0)
check(low[2] < centre[2], f"a negative elevation looks up from below: {low[2]:.3f}")

# --- interior placements: a camera INSIDE the room, at a human height ------
# The orbit invariant above cannot hold here and must not be forced to: a room's
# bounding-sphere radius puts the camera outside the building. What must hold is
# that the eye is inside the room's own bounds.
room_min = (-3.0, -2.0, 0.0)
room_max = (3.0, 2.0, 2.8)
for name, preset in montage.INTERIOR_PRESETS.items():
    location, target, lens_mm = montage.interior_placement(room_min, room_max, preset)
    inside = all(room_min[axis] - 1e-6 <= location[axis] <= room_max[axis] + 1e-6 for axis in range(3))
    check(inside, f"{name} puts the eye inside the room's bounds: {[round(v, 2) for v in location]}")
    check(target != location, f"{name} aims somewhere it is not: {[round(v, 2) for v in target]}")
    # A 50mm lens standing 300mm from a wall photographs that wall and nothing
    # else, so the lens is part of the preset rather than a preference.
    check(lens_mm <= 24.0, f"{name} uses a wide lens: {lens_mm}mm")

eye_location, _, _ = montage.interior_placement(room_min, room_max, montage.INTERIOR_PRESETS["interior-corner"])
check(
    abs(eye_location[2] - 1.6) < 1e-6,
    f"a standing view puts the eye at 1.6m, not at the ceiling: {eye_location[2]:.2f}",
)

# A room whose ceiling is lower than the eye would otherwise put the camera
# inside the slab, which renders black rather than reporting the clash.
low_location, _, _ = montage.interior_placement((0.0, 0.0, 0.0), (0.9, 0.9, 0.15), montage.INTERIOR_PRESETS["interior-corner"])
check(
    0.0 <= low_location[2] <= 0.15,
    f"a crawlspace clamps the eye under its ceiling: {low_location[2]:.3f}",
)

# The same preset must frame a bathroom and a hall the way a person in each
# would see it, so the placement is a fraction of the span, not an offset.
small_location, small_target, _ = montage.interior_placement((0.0, 0.0, 0.0), (2.0, 2.0, 2.4), montage.INTERIOR_PRESETS["interior-corner"])
large_location, large_target, _ = montage.interior_placement((0.0, 0.0, 0.0), (8.0, 8.0, 6.0), montage.INTERIOR_PRESETS["interior-corner"])
check(
    large_location[0] > small_location[0] and large_target[0] > small_target[0],
    "the inset scales with the room, so the preset means a corner either way",
)

# --- a label is actually drawn for the requested text ---------------------
def label_ink_count(text):
    canvas = numpy.zeros((40, 200, 4), dtype=numpy.float32)
    montage.draw_label(canvas, text, 2, 2, 2)
    return int((canvas[:, :, 0] > 0.5).sum())


check(label_ink_count("front") > 0, "the word front puts ink on the canvas")
check(label_ink_count("three-quarter") > label_ink_count("aaa"), "different text draws a different amount of ink")
check(label_ink_count("") == 0, "an empty label draws nothing")
check(label_ink_count("~") == label_ink_count(" "), "an unknown character falls back to blank rather than crashing")
# Off-canvas drawing must clip, not raise: a long label on a narrow panel is a
# layout problem, not a crash.
canvas = numpy.zeros((10, 10, 4), dtype=numpy.float32)
montage.draw_label(canvas, "a-very-long-label-indeed", 8, 8, 2)
check(True, "a label that runs off the sheet clips instead of raising")

if failures:
    print("FAIL")
    for failure in failures:
        print(f"  - {failure}")
    sys.stdout.flush()
    os._exit(1)
print("PASS: montage tiling and labelling match their known answers")
sys.stdout.flush()
os._exit(0)
