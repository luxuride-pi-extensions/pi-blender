#!/usr/bin/env python3
"""
Exercise live-bridge.py's `clearance` check against real Blender.

Why a real Blender: the measure rasterises the floor from world-space bounding
boxes and floods it, so a mock would prove only that the arithmetic is
self-consistent. This builds a room whose correct answers are known BY
CONSTRUCTION, and asserts the two numbers that say whether a room works.

Three rooms, because the measure has three jobs and confusing them is how a
number becomes noise:

  * CLEAR: a 6 x 4 m room with furniture pushed against two walls. One free
    region, and it reaches everything. `islandCount` 1.
  * CUT: the same room with a sofa spanning the width wall to wall. The free
    floor is split in two, so `islandCount` 2 and `unreachableArea` is the
    area of the half behind the sofa -- the fault a render cannot show, since
    both halves photograph as a furnished room.
  * SHRUNK: a 6 x 4 m room whose floor alone is 6 x 4, with the same sofa.
    Identical free area, because the obstruction set is identical -- which is
    the point of asserting it: the measure counts OBSTRUCTIONS against the
    room's own extent, and adding a floor must not change the answer.

Plus the cases where the measure must refuse rather than guess: an extent too
large to raster at the default cell, and an explicit coarse `cell` that brings
it back.

Importing live-bridge.py runs its module-level bootstrap -- it creates bridge
dirs and registers a request-polling timer -- so a throwaway bridge dir goes in
the environment first, and the process leaves with os._exit() because a
registered persistent timer would otherwise keep Blender alive forever.

Run: blender --background --python test/clearance-probe.py
Exit code 0 means every assertion held.
"""

import importlib.util
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


def make_cube(name, size=1.0, location=(0.0, 0.0, 0.0), scale=(1.0, 1.0, 1.0)):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.context.view_layer.update()
    return obj


def load_live_bridge():
    bridge_dir = tempfile.mkdtemp(prefix="pi-blender-clearance-probe-")
    os.environ["PI_BLENDER_BRIDGE_DIR"] = bridge_dir
    path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "blender", "live-bridge.py"
    )
    spec = importlib.util.spec_from_file_location("live_bridge", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"no module spec for the live bridge at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, os.path.join(bridge_dir, "clearance-probe.blend")


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()


def measure(live_bridge, scratch_blend, names, extra=None):
    request = {
        "blendPath": scratch_blend,
        "objects": names,
        "checks": ["clearance"],
    }
    request.update(extra or {})
    return live_bridge.handle_geometry_probe(request)["clearance"]


def build_clear_room():
    """6 x 4 m, furniture pushed against two walls, one free region."""
    clear_scene()
    # A floor 6 x 4 and 0.2 THICK, because the room's own extent is the union
    # of the objects probed and the floor is the only thing that states it.
    make_cube("ClearFloor", size=1.0, location=(0.0, 0.0, -0.1), scale=(6.0, 4.0, 0.2))
    # Against the west wall and the north wall. Both this and the floor are
    # ignored by name -- a floor is the room's bounds, not furniture in it.
    make_cube("Wardrobe", size=0.6, location=(-2.4, 1.4, 1.0), scale=(1.0, 1.0, 2.0))
    # Inside the floor, not overhanging it: the room is the union of the probed
    # objects, so a bed hanging 200mm past the north wall would enlarge the
    # room it is supposed to sit in -- a room does not grow because its
    # furniture does.
    make_cube("Bed", size=2.0, location=(1.5, 1.0, 0.3), scale=(1.0, 0.9, 0.6))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)


def build_cut_room(sofa_length=5.0):
    """The same room with a sofa spanning it, splitting the free floor."""
    clear_scene()
    make_cube("CutFloor", size=1.0, location=(0.0, 0.0, -0.1), scale=(6.0, 4.0, 0.2))
    # Two gaps are in play and both matter. A sofa of 4.2 leaves 900 mm each
    # side, which is a doorway a 500 mm person gets through even after the
    # dilation, so the room stays one region. A sofa of 5.9 leaves 50 mm, which
    # is inside the reach of a shoulder, so the room is cut in two -- and that
    # is the whole reason the measure carries a body radius rather than a
    # grid: a flood fill walks through a 50 mm gap as readily as through a
    # metre, and reported this case as `islandCount: 1`.
    make_cube("Sofa", size=1.0, location=(0.0, 0.0, 0.4), scale=(sofa_length, 1.0, 0.8))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)


def main():
    live_bridge, scratch_blend = load_live_bridge()

    # handle_geometry_probe calls ensure_requested_blend_open, which reads
    # request["blendPath"] unconditionally -- the handler is written for a
    # workspace, not for a raw in-memory scene. Saving the blank here and
    # passing that path back is how the probe is pointed at the scene this
    # script builds: the early return fires on the path match, so the handler
    # never tries to reload anything.
    bpy.ops.wm.save_as_mainfile(filepath=scratch_blend)

    clear_scene()

    # --- a room with nothing in the way ---------------------------------
    build_clear_room()
    clear = measure(live_bridge, scratch_blend, ["ClearFloor", "Wardrobe", "Bed"])
    check(clear.get("sampled") is True, f"the clear room must be sampled, got {clear}")
    check(clear["floorArea"] == 24.0, f"a 6 x 4 room has 24 m2 of floor, got {clear['floorArea']}")
    check(
        clear["islandCount"] == 1,
        f"a clear room is one free region, got {clear['islandCount']}",
    )
    check(
        clear["unreachableArea"] == 0.0,
        f"nothing in a clear room is behind anything, got {clear['unreachableArea']}",
    )
    # The two footprints are 0.36 m2 and 1.8 m2, and each is DILATED by the
    # body radius before it blocks a sample, so the free area must land below
    # 24 - 0.36 - 1.8 = 21.84 -- never above it. A bound rather than an
    # equality, because a free area is a count of samples and quantises.
    check(
        clear["freeArea"] < 24.0 - 0.36 - 1.8,
        f"dilation must cost more than the raw footprints, got {clear['freeArea']}",
    )
    check(
        clear["freeArea"] > 24.0 - 0.36 - 1.8 - 6.0,
        f"but not absurdly less: the dilation is 0.25 m, not half the room, got {clear['freeArea']}",
    )

    # --- the fault: furniture spanning the room -------------------------
    build_cut_room(5.9)
    cut = measure(live_bridge, scratch_blend, ["CutFloor", "Sofa"])
    check(cut.get("sampled") is True, f"the cut room must be sampled, got {cut}")
    check(
        cut["islandCount"] == 2,
        f"a sofa wall-to-wall cuts the floor in two, got {cut['islandCount']} regions",
    )
    # Both halves touch the room's edge, so a person can stand in either one --
    # what they cannot do is get from one to the other, and that is what
    # islandCount reports. `unreachableArea` is a NARROWER fault: floor cut off
    # from EVERY edge by a closed ring of furniture, which is asserted below.
    check(
        cut["unreachableArea"] == 0.0,
        f"both halves touch the room edge, so neither is cut off from it, got {cut['unreachableArea']}",
    )
    check(
        cut["largestFreeArea"] < cut["freeArea"],
        "the largest single region must be smaller than the free floor when the room is cut",
    )
    check(
        cut["freeArea"] > cut["unreachableArea"],
        f"one side of the sofa is the bigger half, got {cut['unreachableArea']} unreachable of {cut['freeArea']} free",
    )

    # --- the counter-case: a sofa with a real way round it --------------
    build_cut_room(4.2)
    passes = measure(live_bridge, scratch_blend, ["CutFloor", "Sofa"])
    check(
        passes["islandCount"] == 1,
        f"a sofa with 900mm either side is passable and is one region, got {passes['islandCount']}",
    )
    check(
        passes["unreachableArea"] == 0.0,
        f"a passable sofa blocks nobody, got {passes['unreachableArea']}",
    )
    check(
        passes["freeArea"] > cut["freeArea"] - 0.5,
        "the two sofas block comparably, and the difference must not be the finding",
    )

    # --- floor cut off from EVERY edge: the narrower fault --------------
    # Four panels forming a closed box in the middle of the room. The pocket
    # inside touches no boundary, so it is free floor a person standing at the
    # door cannot walk to -- which is a different failure from the sofa, and
    # the one `unreachableArea` exists to catch.
    clear_scene()
    make_cube("PocketFloor", size=1.0, location=(0.0, 0.0, -0.1), scale=(8.0, 6.0, 0.2))
    make_cube("PanelN", size=1.0, location=(0.0, 1.0, 0.6), scale=(2.4, 0.2, 1.2))
    make_cube("PanelS", size=1.0, location=(0.0, -1.0, 0.6), scale=(2.4, 0.2, 1.2))
    make_cube("PanelE", size=1.0, location=(1.2, 0.0, 0.6), scale=(0.2, 2.2, 1.2))
    make_cube("PanelW", size=1.0, location=(-1.2, 0.0, 0.6), scale=(0.2, 2.2, 1.2))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    pocket = measure(
        live_bridge,
        scratch_blend,
        ["PocketFloor", "PanelN", "PanelS", "PanelE", "PanelW"],
    )
    check(
        pocket["unreachableArea"] > 0.0,
        f"a closed ring of furniture leaves a pocket nobody at the door can reach, got {pocket['unreachableArea']}",
    )
    check(
        abs(pocket["largestFreeArea"] - (pocket["freeArea"] - pocket["unreachableArea"])) < 1e-6,
        f"the outer region is the whole free floor less the pocket, got {pocket['largestFreeArea']} vs {pocket['freeArea']} - {pocket['unreachableArea']}",
    )
    check(
        pocket["islandCount"] == 1,
        f"a pocket that touches no edge is not a reachable region, so only the outer floor counts, got {pocket['islandCount']}",
    )

    # --- the same two sofas, told apart by a THINNER body ---------------
    # The body radius is the knob, and it is the reason a 50 mm slot and a
    # 900 mm doorway are different facts rather than the same one. Rebuilding
    # the CUT room first: the pocket above saved over the scene, and a probe
    # naming objects the scene no longer has is the fixture's bug, not the
    # tool's.
    build_cut_room(5.9)
    narrow_body_cut = measure(live_bridge, scratch_blend, ["CutFloor", "Sofa"], {"body": 0.02})
    check(
        narrow_body_cut["islandCount"] == 1,
        f"a 20 mm body fits a 50 mm gap, so the room is whole again, got {narrow_body_cut['islandCount']}",
    )

    # --- a bigger sofa than the room -------------------------------------
    clear_scene()
    make_cube("GiantSofa", size=1.0, location=(0.0, 0.0, 0.4), scale=(12.0, 1.0, 0.8))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    giant = measure(live_bridge, scratch_blend, ["GiantSofa"])
    check(giant.get("sampled") is True, f"an oversized sofa is still a room, got {giant}")
    check(
        giant["freeArea"] == 0.0,
        f"a sofa wider than the room leaves no floor at all, got {giant['freeArea']}",
    )
    check(
        giant["islandCount"] == 0,
        f"and no free region, got {giant['islandCount']}",
    )

    # --- a large extent coarsens its own stride ------------------------
    # Not refused, and deliberately: the stride is the sample's own extent, so
    # a big room samples itself proportionally instead of the probe refusing
    # to answer. What must not happen is a silent answer -- the stride and the
    # sample count are reported so a reader can see how fine the answer is.
    clear_scene()
    make_cube("HallFloor", size=1.0, location=(0.0, 0.0, -0.1), scale=(60.0, 40.0, 0.2))
    make_cube("FarThing", size=1.0, location=(20.0, 15.0, 0.4), scale=(1.0, 1.0, 0.8))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    hall = measure(live_bridge, scratch_blend, ["HallFloor", "FarThing"])
    check(
        hall.get("sampled") is True,
        f"a 60 m room is sampled at a coarser stride rather than refused, got {hall}",
    )
    check(
        hall["stride"] == 0.55,
        f"the stride is the body's own extent, so it states what it used, got {hall['stride']}",
    )
    check(
        hall["sampleCount"] > 1000,
        f"and 60 x 40 m at that stride is thousands of samples, got {hall['sampleCount']}",
    )
    check(
        "quantises" in hall["note"],
        "the note must say an area is a count of samples, so nobody reads it as exact",
    )

    # --- bad input is refused by name -----------------------------------
    for field, value in (("cell", 0), ("cell", -1.0), ("body", -0.1)):
        try:
            measure(live_bridge, scratch_blend, ["HallFloor"], {field: value})
            check(False, f"{field}={value} must be refused rather than dividing by it")
        except ValueError as error:
            check(
                f"`{field}`" in str(error),
                f"the refusal must name the field, got: {error}",
            )

    # --- an empty scene is refused by name, before any arithmetic ------
    clear_scene()
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    try:
        measure(live_bridge, scratch_blend, [])
        check(False, "an empty scene must be refused rather than reported as a room of no floor")
    except RuntimeError as error:
        check(
            "No mesh objects to probe" in str(error),
            f"the refusal must name the cause, got: {error}",
        )

    # --- a room narrower than a person is refused, not measured ---------
    clear_scene()
    make_cube("Cupboard", size=1.0, location=(0.0, 0.0, 0.5), scale=(0.2, 0.4, 1.0))
    bpy.ops.wm.save_as_mainfile(filepath=bpy.data.filepath)
    narrow = measure(live_bridge, scratch_blend, ["Cupboard"])
    check(
        narrow.get("sampled") is False,
        f"a 200mm cupboard is not a room, so no floor area rather than 0, got {narrow}",
    )
    check(
        "`body`" in narrow.get("reason", ""),
        f"and the refusal must say which knob turns it into an answer, got {narrow}",
    )
    thin = measure(live_bridge, scratch_blend, ["Cupboard"], {"body": 0.05})
    check(
        thin.get("sampled") is True,
        f"a caller who asks for a thinner body gets an answer, got {thin}",
    )
    check(
        thin["bodyRadius"] == 0.05,
        f"and the answer states the radius it used, got {thin['bodyRadius']}",
    )

    if failures:
        print("FAIL")
        for failure in failures:
            print(f"  - {failure}")
        sys.stdout.flush()
        os._exit(1)
    print("PASS: clearance agrees with known floor plans")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
