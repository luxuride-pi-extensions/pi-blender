#!/usr/bin/env python3
"""
Exercise live-bridge.py's `path` check against real Blender.

The defect under test is the one a render cannot show: two doors that line up
with nothing, so the walk between them zig-zags. Every wall meets, every
opening is the right width, every room is correct in isolation -- and the
route betrays all of it. The measure is a detour ratio, the shortest walk over
the straight line between the same two points, so the fixture builds rooms
whose correct ratio is known BY CONSTRUCTION.

Five houses, each answering a different question the measure could get wrong:

  * STRAIGHT: a straight corridor between two aligned doors. Ratio 1.0.
  * ELBOW: a corridor turning once at a right angle. About 1.27 -- the reason
    the threshold sits well above 1 rather than at 1.01, because rooms bend.
  * ZIGZAG: four short offset openings in a row, the shape the check exists to
    catch. Well over the threshold.
  * BLOCKED: a corridor with a wardrobe across it. No walk at all, which must
    be reported as "no route" rather than as a detour of infinity.
  * BURIED: a point inside a wall, which no sample can stand at.

Importing live-bridge.py runs its module-level bootstrap -- it creates bridge
dirs and registers a request-polling timer -- so a throwaway bridge dir goes in
the environment first, and the process leaves with os._exit() because a
registered persistent timer would otherwise keep Blender alive forever.

Run: blender --background --python test/path-probe.py
Exit code 0 means every assertion held.
"""

import importlib.util
import math
import os
import sys
import tempfile

import bpy  # pyright: ignore[reportMissingImports]  # pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
    # Blender buffers its own stdout, so a failure line printed here would
    # otherwise be lost when the process exits hard.
    print(f"  {'ok  ' if condition else 'FAIL'}: {message}")
    sys.stdout.flush()


def box(name, minimum, maximum):
    """A cube spanning the given world bounds, so a floor plan is a list."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0.0, 0.0, 0.0))
    obj = bpy.context.active_object
    obj.name = name
    centre = ((minimum[0] + maximum[0]) / 2.0, (minimum[1] + maximum[1]) / 2.0, (minimum[2] + maximum[2]) / 2.0)
    scale = (maximum[0] - minimum[0], maximum[1] - minimum[1], maximum[2] - minimum[2])
    obj.location = centre
    obj.scale = scale
    bpy.context.view_layer.update()
    return obj


def load_live_bridge():
    bridge_dir = tempfile.mkdtemp(prefix="pi-blender-path-probe-")
    os.environ["PI_BLENDER_BRIDGE_DIR"] = bridge_dir
    path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "blender", "live-bridge.py"
    )
    spec = importlib.util.spec_from_file_location("live_bridge", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"no module spec for the live bridge at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, os.path.join(bridge_dir, "path-probe.blend")


def measure(live_bridge, scratch_blend, points, extra=None):
    request = {
        "blendPath": scratch_blend,
        "objects": [obj.name for obj in bpy.data.objects if obj.type == "MESH"],
        "checks": ["path"],
        "points": points,
    }
    request.update(extra or {})
    return live_bridge.handle_geometry_probe(request)["path"]


def find(result, index):
    """The entry between the two points at the given positions."""
    for entry in result["paths"]:
        if [round(entry["from"][0], 2), round(entry["from"][1], 2)] == index:
            return entry
    return None


# A run of rooms on one floor plate, divided by cross walls that each carry a
# single door. The rooms are 3 m wide and the plate is 10 m deep, so every room
# is comfortably passable and the ONLY thing that can make a route bend is where
# the doors sit. That is the whole point: a zig-zag is a layout decision, not a
# consequence of a tight building, and a fixture whose rooms are too narrow to
# walk through measures a maze and calls it a defect.
#
# Two details were learned the hard way rather than designed:
#
#  * Every cross wall spans the FULL width of the plate, and the plate's floor
#    extends UNDER the outer walls. An earlier fixture left walls short of the
#    floor, and the walker simply went around their ends, so a corridor built to
#    zig-zag measured a detour of 1.0.
#  * Blender opens with a 2 m Cube at the origin. Left in, it widens the probed
#    extent far enough that the plate's own floor no longer covers most of the
#    room, so the floor stops reading as the floor -- and is then stamped as a
#    wall, and every sample blocks. A debug script that printed the objects
#    found it; the assertions alone did not, because the failure it caused
#    ("no route at all") is indistinguishable from a correctly-blocked room.
PLATE = {"x": (-1.5, 13.5), "y": (-5.0, 5.0)}
WALL = 0.4
DOOR = 1.6
ROOM_W = 3.0


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for leftover in list(bpy.data.objects):
        bpy.data.objects.remove(leftover, do_unlink=True)


def cross_wall(name, x, door_y):
    """A wall across the plate with one opening in it, at `door_y`."""
    low, high = PLATE["y"]
    if door_y - DOOR / 2.0 > low:
        box(name + "Lo", (x - WALL / 2, low, 0.0), (x + WALL / 2, door_y - DOOR / 2.0, 2.6))
    if high > door_y + DOOR / 2.0:
        box(name + "Hi", (x - WALL / 2, door_y + DOOR / 2.0, 0.0), (x + WALL / 2, high, 2.6))


def build_rooms(doors):
    """A row of rooms whose dividing walls sit at `doors` -- (x, door_y) each."""
    clear_scene()
    low_x, high_x = PLATE["x"]
    low_y, high_y = PLATE["y"]
    box("PathFloor", (low_x - WALL, low_y - WALL, -0.2), (high_x + WALL, high_y + WALL, 0.0))
    box("WallOuterS", (low_x - WALL, low_y - WALL, 0.0), (high_x + WALL, low_y, 2.6))
    box("WallOuterN", (low_x - WALL, high_y, 0.0), (high_x + WALL, high_y + WALL, 2.6))
    box("WallOuterW", (low_x - WALL, low_y, 0.0), (low_x, high_y + WALL, 2.6))
    box("WallOuterE", (high_x, low_y, 0.0), (high_x + WALL, high_y + WALL, 2.6))
    for index, (x, door_y) in enumerate(doors):
        cross_wall(f"WallCross{index}", x, door_y)
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)


def build_corridor():
    """A straight walled corridor, for the cases needing a sealed lane."""
    clear_scene()
    low_x, high_x = PLATE["x"]
    box("PathFloor", (low_x - WALL, -1.0 - WALL, -0.2), (high_x + WALL, 1.0 + WALL, 0.0))
    box("WallCorridorS", (low_x, -1.0, 0.0), (high_x, -0.6, 2.6))
    box("WallCorridorN", (low_x, 0.6, 0.0), (high_x, 1.0, 2.6))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)


def inside_room_one():
    return PLATE["x"][0] + ROOM_W / 2.0, 0.0


def main():
    live_bridge, scratch_blend = load_live_bridge()
    bpy.ops.wm.save_as_mainfile(filepath=scratch_blend)

    # --- a straight corridor: the ratio is 1.0 by definition ------------
    doors = [(PLATE["x"][0] + ROOM_W * (n + 1), 0.0) for n in range(4)]
    build_rooms(doors)
    start, finish = inside_room_one()[0], doors[-1][0] + ROOM_W / 2.0
    straight = measure(live_bridge, scratch_blend, [(start, 0.0), (finish, 0.0)])
    check(straight.get("sampled") is True, f"a corridor must be sampled, got {straight}")
    entry = find(straight, [round(start, 2), 0.0])
    check(entry is not None, f"a straight route must be reported, got {straight}")
    if entry is not None:
        check(
            entry["detour"] < 1.1,
            f"a straight corridor's walk IS its line, got {entry['detour']}",
        )
        check(
            entry["zigzag"] is False,
            f"and it is not a zigzag, got {entry['zigzag']}",
        )
        check(
            entry["excess"] < 0.5,
            f"the excess over the line is nearly nothing, got {entry['excess']}",
        )

    # --- one right-angle elbow: about 1.27, and NOT a finding ----------
    # Measured between the two doors themselves, so the offset is the same order
    # as the span. Note the figure is 1.08 and not the textbook 1.27 for an
    # idealised L, and the difference is not error: each door centre is snapped
    # to the nearest FREE sample, which pulls both endpoints off the wall plane
    # into the room, and that shortens the straight line and the walk together.
    # The ratio survives; the absolute value is a property of the raster, not of
    # the building.
    doors_two = [(PLATE["x"][0] + ROOM_W, 0.0), (PLATE["x"][0] + ROOM_W * 2, 3.0)]
    build_rooms(doors_two)
    elbow = measure(live_bridge, scratch_blend, [(doors_two[0][0], 0.0), (doors_two[1][0], 3.0)])
    entry = find(elbow, [round(doors_two[0][0], 2), 0.0])
    check(entry is not None, f"the elbow route must be reported, got {elbow}")
    if entry is not None:
        check(
            1.02 < entry["detour"] < 1.45,
            f"one offset door bends the route but stays under the threshold, got {entry['detour']}",
        )
        check(
            entry["zigzag"] is False,
            f"and a room that turns once is not a zigzag, got {entry['zigzag']}",
        )
        check(
            elbow["worstDetour"]["zigzag"] is False,
            "so nothing in an elbow corridor is over threshold",
        )

    # --- the defect: a stair-step of short offsets ----------------------
    build_rooms(
        [
            (PLATE["x"][0] + ROOM_W * (n + 1), 3.0 if n % 2 == 0 else -3.0)
            for n in range(4)
        ]
    )
    zigzag = measure(live_bridge, scratch_blend, [(start, 3.0), (finish, -3.0)])
    check(
        zigzag["zigzagCount"] >= 1,
        f"three offset openings between two doors is exactly the defect, got {zigzag['zigzagCount']}",
    )
    worst = zigzag["worstDetour"]
    check(worst is not None, f"and it must name the worst route, got {zigzag}")
    if worst is not None:
        check(
            worst["detour"] > zigzag["detailThreshold"],
            f"the worst route is over the threshold, got {worst['detour']} vs {zigzag['detailThreshold']}",
        )
        check(
            worst["zigzag"] is True,
            "and it says so, because a number alone is not a finding",
        )
        check(
            worst["excess"] > 1.0,
            f"the excess is metres wasted walking, got {worst['excess']}",
        )

    # --- the same threshold is the caller's to move ---------------------
    strict = measure(
        live_bridge, scratch_blend, [(doors_two[0][0], 0.0), (doors_two[1][0], 3.0)], {"detour": 1.05}
    )
    check(
        strict["detailThreshold"] == 1.05,
        f"a caller sets the threshold it cares about, got {strict['detailThreshold']}",
    )
    check(
        strict["zigzagCount"] == 1,
        f"and a stricter threshold promotes the elbow into a finding, got {strict['zigzagCount']}",
    )

    # --- a route that does not exist is not a big detour ----------------
    build_corridor()
    box("BlockedWardrobe", (2.4, -0.5, 0.0), (3.6, 1.0, 2.0))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    blocked = measure(live_bridge, scratch_blend, [(0.2, 0.2), (5.8, 0.2)])
    check(
        blocked["paths"] == [],
        f"a wardrobe across the corridor leaves no route to report, got {blocked['paths']}",
    )
    check(
        blocked["worstDetour"] is None,
        "and no worst route, rather than a detour of infinity",
    )

    # --- a point inside a wall is unresolved, not guessed ---------------
    # A point deep inside a solid, far enough from any floor a person could
    # stand on that no free sample lies within reach. Not a point in a thin
    # wall: there the nearest free sample is always close, and resolving it is
    # correct -- a door in a thin wall IS findable, and reporting it as
    # "unresolved" would send the reader looking for a fault that is not there.
    build_corridor()
    box("SolidBlock", (2.3, -0.7, 0.0), (3.7, 0.7, 2.6))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    buried = measure(live_bridge, scratch_blend, [(0.2, 0.2), (3.0, 0.2)])
    check(
        len(buried["unresolved"]) == 1,
        f"a point inside a solid nobody can stand in lands on no sample, got {buried['unresolved']}",
    )
    check(
        "cannot tell those apart" in buried["note"],
        "and the note says why: a buried door and a door nobody modelled look the same here",
    )

    # --- no points at all is a refusal with the request in it ----------
    nothing = measure(live_bridge, scratch_blend, [])
    check(
        nothing["paths"] == [],
        f"with no points there is nothing to measure, got {nothing['paths']}",
    )
    check(
        "door centres" in nothing["note"],
        f"and the note says what to pass instead, got {nothing['note']}",
    )

    # --- bad input is refused by name ----------------------------------
    for field, value in (("cell", 0), ("body", -0.1), ("detour", 0.5)):
        try:
            measure(live_bridge, scratch_blend, [[0.2, 0.2], [5.8, 0.2]], {field: value})
            check(False, f"{field}={value} must be refused rather than measured")
        except ValueError as error:
            check(f"`{field}`" in str(error), f"the refusal must name the field, got: {error}")
    try:
        measure(live_bridge, scratch_blend, [[0.2, 0.2, 0.0], [5.8, 0.2]])
        check(False, "a 3D point must be refused: the walk is a floor question")
    except ValueError as error:
        check(
            "`points`" in str(error),
            f"the refusal must name the field and say what shape it wants, got: {error}",
        )

    # --- the path and clearance checks agree on the room ---------------
    # Same scope, same resolution, opposite answer about walls -- so a room
    # that is clear to walk in and unreachable at the same time would mean the
    # two rasters had drifted apart.
    build_corridor()
    names = [obj.name for obj in bpy.data.objects if obj.type == "MESH"]
    both = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": names, "checks": ["clearance", "path"], "points": [[0.2, 0.2], [5.8, 0.2]]}
    )
    check(
        both["clearance"]["freeArea"] > 0.0,
        f"the floor is free, so clearance has area to report, got {both['clearance']['freeArea']}",
    )
    check(
        len(both["path"]["paths"]) == 1,
        f"and there is one route across it, got {both['path']['paths']}",
    )
    check(
        math.isclose(both["clearance"]["stride"], both["path"]["stride"], rel_tol=1e-9),
        f"same stride from one raster, got {both['clearance']['stride']} vs {both['path']['stride']}",
    )

    if failures:
        print("FAIL")
        for failure in failures:
            print(f"  - {failure}")
        sys.stdout.flush()
        os._exit(1)
    print("PASS: the walk between two doors agrees with the floor plan it was built from")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
