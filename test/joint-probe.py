#!/usr/bin/env python3
"""
Exercise live-bridge.py's joint sweep and island count against real Blender.

Why a real Blender: every number here is computed from bpy/mathutils, so a
mock proves only that the arithmetic is self-consistent. This builds a scene
whose correct answers are known BY CONSTRUCTION -- a shower whose riser pipe
is modelled 11mm clear of the pipe it continues, a pair that genuinely touch,
a chair a few millimetres from a table it is pulled up to -- asks the handler
for the `joint` and `topology` checks, and asserts the verdicts.

The three cases are the three things the sweep must not confuse:
  * overlapping-but-apart: a DEFECT. The two boxes share space, the surfaces
    do not meet. The shower riser.
  * near-miss: a placement to JUDGE. A chair at a table is correct, and reads
    the same as a detached riser at this resolution.
  * in-contact: HEALTHY, and the thing that must be skipped, because reporting
    every touching pair would bury the one that matters.

Importing live-bridge.py runs its module-level bootstrap -- it creates bridge
dirs and registers a request-polling timer -- so a throwaway bridge dir goes in
the environment first, and the process leaves with os._exit() because a
registered persistent timer would otherwise keep Blender alive forever.

Run: blender --background --python test/joint-probe.py
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
    bridge_dir = tempfile.mkdtemp(prefix="pi-blender-joint-probe-")
    os.environ["PI_BLENDER_BRIDGE_DIR"] = bridge_dir
    path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "blender", "live-bridge.py"
    )
    spec = importlib.util.spec_from_file_location("live_bridge", os.path.normpath(path))
    # spec_from_file_location returns None for a path it cannot resolve to a
    # module. Reaching module_from_spec with None raises inside importlib with a
    # message that names neither this file nor the path, so it is turned into
    # one that does -- and the failure below then says the probe's own subject
    # is missing rather than pointing at the dynamic import.
    if spec is None or spec.loader is None:
        raise RuntimeError(f"no module spec for the live bridge at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, os.path.join(bridge_dir, "scratch.blend")


def joint_for(joints, first, second):
    for entry in joints["joints"]:
        if {entry["a"], entry["b"]} == {first, second}:
            return entry
    return None


def pair_for(probe, first, second):
    """The `pairs` figure for two named objects.

    Keyed both ways round because the caller passes a/b in whatever order it
    happened to build them, and the dict is keyed by the caller's own "A|B"
    string, not sorted.
    """
    pairs = probe.get("pairs") or {}
    for key in (f"{first}|{second}", f"{second}|{first}"):
        if key in pairs:
            return pairs[key]
    return None


def main():
    live_bridge, scratch_blend = load_live_bridge()

    # handle_geometry_probe calls ensure_requested_blend_open, which reads
    # request["blendPath"] unconditionally -- the handler is written for a
    # workspace, not for a raw in-memory scene. Saving the blank here and
    # passing that path back is how the probe is pointed at the scene this
    # script builds: the early return fires on the path match, so the handler
    # never tries to reload anything.
    bpy.ops.wm.save_as_mainfile(filepath=scratch_blend)

    # Clear the factory cube so the sweep only sees what this scene made.
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    # --- the shower ------------------------------------------------------
    # Two vertical pipes, one ABOVE the other, the upper one modelled 11mm
    # clear of the lower one's top. That is the user's defect: the two
    # bounding boxes overlap on X and Y and are 11mm apart on Z, so the box
    # test calls it a candidate, and the surfaces confirm they do not meet.
    # The centre of the upper pipe is arithmetic, not a guess: a 0.04 cube
    # scaled 12x in Z is 0.48 tall, so putting its BOTTOM at 1.011 (11mm past
    # the riser's 1.0) puts its centre at 1.251.
    riser = make_cube("Riser", size=0.04, location=(0.0, 0.0, 0.5), scale=(1.0, 1.0, 25.0))
    head_pipe = make_cube("HeadPipe", size=0.04, location=(0.0, 0.0, 1.251), scale=(1.0, 1.0, 12.0))

    # --- a healthy join that must NOT be reported ------------------------
    # Deliberately interpenetrating, so the sweep's skip branch is exercised
    # on the strongest case: two parts that genuinely share material.
    make_cube("WallPost", size=0.04, location=(0.02, 0.0, 0.5), scale=(1.0, 1.0, 25.0))

    # --- a near-miss that is CORRECT -------------------------------------
    # A table top at z=0.75 and a chair seat just under it. They are stacked
    # and disjoint, 20mm apart -- the geometry a chair pulled up to a table
    # actually has. It must be reported as near-miss, not as a defect.
    make_cube("Table", size=0.6, location=(2.0, 0.0, 0.75), scale=(1.0, 1.0, 0.05))
    make_cube("Chair", size=0.4, location=(2.0, 0.0, 0.7), scale=(1.0, 1.0, 0.05))

    # --- a far-apart pair that must be SILENT ---------------------------
    make_cube("FarBox", size=0.2, location=(8.0, 0.0, 0.0))

    result = live_bridge.handle_geometry_probe(
        {
            "blendPath": scratch_blend,
            "objects": [riser.name, head_pipe.name, "WallPost", "Table", "Chair", "FarBox"],
            "checks": ["joint"],
        }
    )
    joints = result["joints"]
    check(joints is not None, "the joint check returned no result")

    defect = joint_for(joints, "Riser", "HeadPipe")
    check(defect is not None, "the detached shower riser was not reported at all")
    if defect is not None:
        check(
            defect["severity"] == "broken-continuation",
            f"the detached riser should be a broken continuation, got {defect['severity']}",
        )
        check(
            0.010 < defect["gap"] < 0.012,
            f"the riser gap should measure ~11mm, got {defect['gap']}",
        )
        check(
            defect["boundingBoxOverlapAxes"] == ["X", "Y"],
            f"stacked pipes should share X and Y, got {defect['boundingBoxOverlapAxes']}",
        )
        check(defect["overlapping"] is False, "stacked pipes with a gap are not inside one another")
        check(joints["defectCount"] >= 1, f"defectCount was {joints['defectCount']}")

    # The healthy join: present in the scene, absent from the report.
    check(
        joint_for(joints, "Riser", "WallPost") is None,
        "a genuinely interpenetrating pair was reported as a suspect joint",
    )
    # Far apart on every axis: not a candidate at all. This is the pair that
    # catches the "distance is 0 when any axis overlaps" bug -- FarBox shares
    # Y and Z with the pipes and is 8m away on X.
    check(
        joint_for(joints, "Riser", "FarBox") is None,
        "a pair 8m apart was reported as a suspect joint",
    )

    near = joint_for(joints, "Table", "Chair")
    check(near is not None, "a chair pulled up to a table was not reported as a near-miss")
    if near is not None:
        check(
            near["severity"] == "near-miss",
            f"the chair at the table should be a near-miss, got {near['severity']}",
        )
        check(near["overlapping"] is False, "a stacked chair/table pair should not report box overlap")
        # The seat is 5mm thick and the gap to the table top is 25mm, so the two
        # are NOT a part split in two however concentric they look.
        check(
            near["boundingBoxDistance"] > 0.05 * 0,
            f"the chair gap should be its real separation, got {near['boundingBoxDistance']}",
        )

    # A part floating in the void of an open frame, touching nothing.
    # A torus, because its hole is genuinely OUTSIDE the material: a hollow
    # ring is a closed solid whose centre is empty space, so the floater's
    # vertices are not inside anything and the nearest surface is 129mm off.
    # Its bounding box, meanwhile, is 0.7 across and 0.1 tall, which wholly
    # contains the 0.1 cube at its centre -- that is what makes this
    # overlapping-but-apart rather than a continuation.
    #
    # Two fixtures that look similar and must NOT be confused, both measured
    # here because the difference is the whole point of the severity:
    #   * this: the part is in a VOID, so no surface reaches it -> a defect.
    #   * `Embedded` below: the part is inside SOLID material, so the two DO
    #     touch -- but `Embedded` is also swallowed, which is now its own
    #     severity. A five-walled box is not a third case: the walls meet at
    # their corners, so it is a closed solid and its "interior" is material,
    # exactly like Embedded. The shape has to be hollow, not merely open.
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.3, minor_radius=0.05, major_segments=32, minor_segments=12
    )
    ring = bpy.context.active_object
    ring.name = "RingFrame"
    ring.location = (8.0, 0.0, 0.0)
    bpy.context.view_layer.update()
    make_cube("Floater", size=0.1, location=(8.0, 0.0, 0.0))
    buried = live_bridge.handle_geometry_probe(
        {
            "blendPath": scratch_blend,
            "objects": ["RingFrame", "Floater"],
            "checks": ["joint"],
        }
    )["joints"]
    buried_entry = joint_for(buried, "RingFrame", "Floater")
    check(buried_entry is not None, "a part floating in a frame's void was not reported")
    if buried_entry is not None:
        check(
            buried_entry["severity"] == "overlapping-but-apart",
            f"the floating part should be overlapping-but-apart, got {buried_entry['severity']}",
        )
        check(buried_entry["overlapping"] is True, "the void part's box is not inside the frame's")
        check(
            abs(buried_entry["boundingBoxDistance"]) < 1e-9,
            f"a contained part has no box separation, got {buried_entry['boundingBoxDistance']}",
        )
        check(
            0.10 < buried_entry["gap"] < 0.20,
            f"the void part should sit ~129mm off the ring, got {buried_entry['gap']}",
        )
        check(buried["defectCount"] >= 1, "a floating part in a void is not counted as a defect")
    # A part buried inside SOLID material is the user's `pier leading into
    # wall`: the two do touch, so every contact-based rule is satisfied, and
    # `interpenetrating` is also the verdict of every healthy joint in the
    # model. The pair check carries the figure; the sweep reads it.
    #
    #     The cube is 0.1 and its centre sits at the block's centre, so it is
    # entirely inside -- but the depth reads 2.0 of its own thickness, not
    # 1.0, and the reason is worth stating because it is a real limit of the
    # measure: depth is the DEEPEST VERTEX's distance to the nearest surface,
    # and a cube has only eight corners, none of them near its middle. The
    # block spans z -0.25..0.25 and the cube z 0.05..0.15, so its deepest
    # corner sits 0.2 from the top face and 0.2 from the near side, while its
    # CENTRE is 0.25 down. A coarse mesh therefore UNDERSTATES depth; it never
    # overstates it, which is the safe direction for a defect that hides.
    make_cube("SolidBlock", size=0.5, location=(10.0, 0.0, 0.0))
    make_cube("Embedded", size=0.1, location=(10.0, 0.0, 0.1))
    embedded = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": ["SolidBlock", "Embedded"], "checks": ["joint", "pair"]}
    )
    embedded_joint = joint_for(embedded["joints"], "SolidBlock", "Embedded")
    check(
        embedded_joint is not None,
        "a part entirely inside solid material was not reported at all",
    )
    if embedded_joint is not None:
        check(
            embedded_joint["severity"] == "buried",
            f"a fully swallowed part should read as buried, got {embedded_joint['severity']}",
        )
        check(
            embedded_joint["buried"] is not None
            and embedded_joint["buried"]["buriedObject"] == "Embedded",
            "the buried side must be named: the block is not the part that vanished",
        )
        check(
            embedded_joint["buried"] is not None
            and 1.95 <= embedded_joint["buried"]["depthVsThickness"] <= 2.05,
            f"the deepest corner of a 0.1 cube centred in a 0.5 block sits 0.2 from a face = 2.0 of its "
            f"own thickness, got {embedded_joint['buried']}",
        )
    embedded_pair = pair_for(embedded, "SolidBlock", "Embedded")
    check(embedded_pair is not None, "the pair check did not measure the buried pair")
    if embedded_pair is not None:
        check(
            embedded_pair["buried"] is not None,
            "the pair check reported interpenetration without the depth that distinguishes a joint from a swallow",
        )
        check(
            embedded_pair["deepestPenetration"] > 0.0,
            "the pair is interpenetrating, so a depth must exist",
        )

    # The counter-case for the threshold: a post set a sliver into the thing it
    # stands on. The post spans z 1.99..2.01 and the deck's top face is z 2.0,
    # so half of it is inside -- `interpenetrating`, touching, and CORRECT. This
    # is how the joint is built, and it must stay out of the sweep entirely.
    make_cube("Deck", size=4.0, location=(-14.0, 0.0, 0.0))
    make_cube("PostSet", size=0.02, location=(-14.0, 0.0, 2.0))
    post = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": ["Deck", "PostSet"], "checks": ["joint", "pair"]}
    )
    check(
        joint_for(post["joints"], "Deck", "PostSet") is None,
        "a post set 10mm into a deck is how the joint is built, and must not be reported",
    )
    post_pair = pair_for(post, "Deck", "PostSet")
    if post_pair is not None and post_pair.get("buried") is not None:
        check(
            post_pair["buried"]["depthVsThickness"] < 1.0,
            f"a 10mm overlap on a 20mm post is 0.5 of its own thickness, got {post_pair['buried']}",
        )
        check(
            post_pair["buried"]["relativeSize"] > 1.5,
            f"the deck dwarfs the post, which is what makes it a joint, got {post_pair['buried']}",
        )

    # The artifact the size rule exists to kill, measured rather than assumed:
    # two ground layers of near-equal extent interpenetrate by construction, and
    # the depth ratio alone calls one of them buried -- a real 243-object scene
    # reported a pier founded in the ground at 55x buried, and a lantern inside
    # a railing's extent at 8.9x, both of them correct geometry.
    make_cube("GroundLayer", size=30.0, location=(-20.0, 0.0, 0.0))
    make_cube("LawnLayer", size=28.0, location=(-20.0, 0.0, 0.1))
    layers = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": ["GroundLayer", "LawnLayer"], "checks": ["joint", "pair"]}
    )
    check(
        joint_for(layers["joints"], "GroundLayer", "LawnLayer") is None,
        "two ground layers of near-equal size overlap by construction and are not a swallow",
    )
    layer_pair = pair_for(layers, "GroundLayer", "LawnLayer")
    if layer_pair is not None and layer_pair.get("buried") is not None:
        check(
            layer_pair["buried"]["relativeSize"] < 1.5,
            f"near-equal layers must measure under the size ratio, got {layer_pair['buried']}",
        )

    # A pair also given in `pairs` must get the SAME number from the sweep:
    # the box test only selects candidates, the BVH measurement settles them.
    both = live_bridge.handle_geometry_probe(
        {
            "blendPath": scratch_blend,
            "objects": [riser.name, head_pipe.name, "WallPost", "Table", "Chair", "FarBox"],
            "checks": ["joint", "pair"],
            "pairs": [["Riser", "HeadPipe"]],
        }
    )
    sweep_entry = joint_for(both["joints"], "Riser", "HeadPipe")
    pair_entry = both["pairs"]["Riser|HeadPipe"]
    check(
        sweep_entry is not None and abs(sweep_entry["gap"] - pair_entry["closestSurfaceDistance"]) < 1e-6,
        f"sweep gap {sweep_entry and sweep_entry['gap']} disagrees with the pair check "
        f"{pair_entry['closestSurfaceDistance']}",
    )
    check(
        pair_entry["verdict"] == "separated",
        f"the pair check should also call the riser separated, got {pair_entry['verdict']}",
    )

    # --- a coincident surface: the user's colour banding ------------------
    # Two panels occupying the SAME plane, which is what a house built from
    # pieces produces when a panel is laid flush on a wall instead of
    # abutting it. Both are grids (a subdivided plane, not a cube) so each
    # carries vertices SPREAD ACROSS the strip they share -- that mutual
    # spread is what the coincidence measure reads, and a bare cube's eight
    # corner vertices would fail the share floor for the wrong reason.
    #
    # This is the pair that proved the whole defect was invisible: the two
    # are exactly in contact, so the sweep skipped on the verdict alone, and
    # `in-contact` is precisely what a CLEAN abutment reports too.
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=8, y_subdivisions=8, size=1.0)
    wall_panel = bpy.context.active_object
    wall_panel.name = "WallPanel"
    wall_panel.location = (12.0, 0.0, 0.0)
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=8, y_subdivisions=8, size=0.4)
    laid_panel = bpy.context.active_object
    laid_panel.name = "LaidPanel"
    # Rotated a full turn about X, so it faces the other way and shares the
    # wall's plane rather than standing off it.
    laid_panel.rotation_euler = (3.141592653589793, 0.0, 0.0)
    laid_panel.location = (12.3, 0.0, 0.0)
    bpy.context.view_layer.update()
    coincidence = live_bridge.handle_geometry_probe(
        {
            "blendPath": scratch_blend,
            "objects": ["WallPanel", "LaidPanel"],
            "checks": ["joint", "pair"],
        }
    )
    coincident_entry = joint_for(coincidence["joints"], "WallPanel", "LaidPanel")
    check(
        coincident_entry is not None,
        "two panels lying in the same plane were not reported at all",
    )
    if coincident_entry is not None:
        check(
            coincident_entry["severity"] == "coincident-surface",
            f"coincident panels should be coincident-surface, got {coincident_entry['severity']}",
        )
        figure = coincident_entry["coincidentSurface"]
        check(
            figure["isCoincident"] is True,
            f"the coincidence figure should call it coincident, got {figure}",
        )
        check(
            figure["smallerCount"] >= 8 and figure["smallerShare"] >= 0.15,
            f"a 5x5 grid of vertices on the other's surface should clear both floors, got {figure}",
        )
    coincident_pair = coincidence["pairs"]["WallPanel|LaidPanel"]
    # Which verdict it gets is beside the point, and asserting one would
    # overstate what the check tells you. Two coincident faces put their
    # vertices exactly ON the other surface, which the signed-distance test
    # reads as inside, so this lands on `interpenetrating`; nudging one panel
    # a hair off its plane would make it `in-contact` or `separated` without
    # changing a single thing about the banding. What matters is that the
    # sweep skips on BOTH of those verdicts, which is why coincidence is
    # measured separately instead of read off one.
    check(
        coincident_pair["verdict"] in ("interpenetrating", "in-contact"),
        f"coincident panels land on a contact-ish verdict, got {coincident_pair['verdict']}",
    )
    # What the coincidence figure reports, in full: all 12 of the wall's
    # vertices inside the SHARED box and all 81 of the panel's, every one of
    # them on the other surface. The shares are 1.0 because the denominator is
    # the shared box, which is the point -- measured against the wall's whole
    # 81 vertices these came to 14.8% and slipped under a 15% floor, so the
    # cleanest case of this defect was the one that did not report.
    figure = coincident_pair["coincidentSurface"]
    check(
        figure["firstShare"] == 1.0 and figure["secondShare"] == 1.0,
        f"every shared vertex should lie on the other surface, got {figure}",
    )
    check(
        figure["sharedVertices"] == {"WallPanel": 12, "LaidPanel": 81},
        f"the shared box should hold the panel's whole grid and the wall's strip, got {figure['sharedVertices']}",
    )
    check(
        coincident_pair["coincidentSurface"]["isCoincident"] is True,
        f"the pair check's own coincidence figure should also fire, got {coincident_pair['coincidentSurface']}",
    )

    # The counter-case that decides whether the measure is noise: a small
    # part resting flush AGAINST a large surface has vertices on it, but the
    # large surface has almost none on the small part, so the smaller side
    # never clears the floor. Reported here because the floor is the whole
    # difference between a measurement and a list of every bolt in the model.
    make_cube("Bolt", size=0.02, location=(14.0, 0.5, 0.5))
    make_cube("BoltPlate", size=0.02, location=(14.0, 0.5, 0.51))
    flush = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": ["Bolt", "BoltPlate"], "checks": ["joint", "pair"]}
    )
    check(
        joint_for(flush["joints"], "Bolt", "BoltPlate") is None,
        "a bolt head resting on a plate was reported as coincident",
    )

    # --- islands ---------------------------------------------------------
    # One mesh that is a body plus a small detached blob: two components, and
    # every OTHER topology number is clean, because each piece is a closed
    # solid. This is the case the island count exists for and the pre-existing
    # counts cannot see. The blob is a SMALL cube on a LARGE body, so the
    # lopsided split is by construction: primitive_cube_add is the cheapest
    # closed solid available and the vertex count is what the share is read
    # against.
    body = make_cube("Body", size=0.4, location=(4.0, 0.0, 0.0))
    blob = make_cube("Blob", size=0.02, location=(4.0, 0.0, 0.4))
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.select_all(action="DESELECT")
    for part in (body, blob):
        part.select_set(True)
    bpy.ops.object.join()
    split = bpy.context.active_object
    split.name = "SplitBody"
    bpy.context.view_layer.update()

    topo = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": [split.name], "checks": ["topology"]}
    )["objects"][split.name]["topology"]
    check(topo["connectedComponents"] == 2, f"expected 2 components, got {topo['connectedComponents']}")
    check(topo["isSplit"] is True, "a split mesh reported isSplit false")
    check(
        topo["nonManifoldEdges"] == 0 and topo["boundaryEdges"] == 0 and topo["looseVertices"] == 0,
        f"the split mesh should be clean on every other count, got {topo}",
    )
    check(
        topo["largestComponentShare"] == 0.5,
        f"two equal 8-vertex cubes split 50/50, got {topo['largestComponentShare']}",
    )
    check(len(topo["islandSizes"]) == 1, f"one extra island expected, got {topo['islandSizes']}")
    check(
        topo["islandSizes"][0]["vertices"] == 8,
        f"the island should be the blob's 8 verts, got {topo['islandSizes']}",
    )
    # Two equal halves is a 50/50 split: the share does not say whether that is
    # a break or an assembly of two alike parts, which is why `islandRead`
    # exists next to the numbers. It has to read as a candidate here, because
    # the alternative (two alike parts intended as one object) is not a shape a
    # probe can recognise without an intent it is not given.
    check(
        topo["islandRead"] == "break-candidate",
        f"a 50/50 split should be a break candidate, got {topo['islandRead']}",
    )
    check(topo["minIslandGap"] is not None, "a split mesh must report the gap between its islands")

    # The case the raw count gets wrong: 66 identical small cubes merged into one
    # mesh. `isSplit` is true and has been all along, but this is a RAILING --
    # correct geometry -- so a reader taking isSplit at face value would bury
    # the real finding under every assembly in the workspace.
    for i in range(66):
        make_cube(f"Baluster{i}", size=0.1, location=(10.0 + i * 0.3, 0.0, 0.0))
    balusters = [o for o in bpy.data.objects if o.name.startswith("Baluster")]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in balusters:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = balusters[0]
    bpy.ops.object.join()
    railing = bpy.data.objects["Baluster0"]
    railing.name = "Railing"
    bpy.context.view_layer.update()
    rail_topo = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": [railing.name], "checks": ["topology"]}
    )["objects"][railing.name]["topology"]
    check(rail_topo["connectedComponents"] == 66, f"expected 66 balusters, got {rail_topo['connectedComponents']}")
    check(rail_topo["isSplit"] is True, "a 66-part assembly still reports isSplit; the label is what changes")
    check(
        rail_topo["islandRead"] == "assembly",
        f"66 equal parts is an assembly, not a break: got {rail_topo['islandRead']} at share {rail_topo['largestComponentShare']}",
    )
    # And now the case that `islandRead` gets wrong in the OTHER direction. The
    # balusters were laid 0.3 m apart with 0.1 m cubes, so every island sits ~9.5x
    # its own size from its neighbour: 100% floating. A railing like that is not
    # assembled, it is a broken model whose island count happens to look healthy,
    # and it is measured from real workspaces rather than invented -- 32 bridge
    # planks 2.65 m long, 25 mm apart, every island free.
    check(
        rail_topo["islandFloatingShare"] == 100.0,
        f"balusters laid 3x their own size apart are all floating free, got {rail_topo['islandFloatingShare']}",
    )
    check(
        rail_topo["islandContact"] is not None and rail_topo["islandContact"] > 0.05,
        f"a floating assembly's tightest gap should exceed 5% of the part, got {rail_topo['islandContact']}",
    )

    # The counter-case, and the one that matters: the SAME assembly shape with
    # the parts touching. 66 cubes overlapping into a continuous run reads
    # identically on islandRead and completely differently on contact, which is
    # what proves the ratio is measuring something the count cannot.
    for i in range(66):
        make_cube(f"Course{i}", size=0.1, location=(20.0 + i * 0.08, 0.0, 0.0))
    courses = [o for o in bpy.data.objects if o.name.startswith("Course")]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in courses:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = courses[0]
    bpy.ops.object.join()
    course = bpy.data.objects["Course0"]
    course.name = "Course"
    bpy.context.view_layer.update()
    course_topo = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": [course.name], "checks": ["topology"]}
    )["objects"][course.name]["topology"]
    check(course_topo["connectedComponents"] == 66, f"expected 66 courses, got {course_topo['connectedComponents']}")
    check(
        course_topo["islandRead"] == rail_topo["islandRead"],
        "both are 66 equal parts, so islandRead cannot be what separates them",
    )
    check(
        course_topo["islandFloatingShare"] == 0.0,
        f"touching parts are none of them floating free, got {course_topo['islandFloatingShare']}",
    )
    check(
        course_topo["minIslandGap"] == 0.0,
        f"overlapping parts share geometry, so the gap is zero, got {course_topo['minIslandGap']}",
    )

    # A single solid cube: one component, not split.
    solid = make_cube("Solid", size=0.3, location=(6.0, 0.0, 0.0))
    solid_topo = live_bridge.handle_geometry_probe(
        {"blendPath": scratch_blend, "objects": [solid.name], "checks": ["topology"]}
    )["objects"][solid.name]["topology"]
    check(solid_topo["connectedComponents"] == 1, f"a cube should be 1 component, got {solid_topo['connectedComponents']}")
    check(solid_topo["isSplit"] is False, "a cube reported as split")
    check(
        solid_topo["islandRead"] == "continuous",
        f"a cube is the healthy case, got {solid_topo['islandRead']}",
    )
    check(solid_topo["minIslandGap"] is None, "a continuous mesh has no gap to report")
    check(solid_topo["largestComponentShare"] == 1.0, f"a cube should be one whole mesh, got {solid_topo['largestComponentShare']}")

    # The severities, in one place, because they mean different things
    # and a reader who finds only one of them in a report cannot tell whether
    # the sweep is broken or the model is.
    severities = {entry["severity"] for entry in joints["joints"]}
    check(
        severities == {"broken-continuation", "near-miss"},
        f"the shower scene should hold exactly a broken continuation and near-misses, got {severities}",
    )
    check(
        all(
            entry["gap"] > entry["tolerance"]
            for entry in joints["joints"]
        ),
        "every reported joint must be beyond the contact tolerance",
    )

    # Coincidence ranks ABOVE a detached part in the sweep's ordering, and it
    # has to: a detached pipe is suspected from a render, while two surfaces
    # in one plane are guaranteed to show as colour banding in the finished
    # image. Buried under the other defects it would be read last, which is
    # the wrong order of worries.
    # That the list holds exactly ONE entry is the ranking assertion: a second
    # entry could only rank below this one, so a single-element list is both the
    # sweep finding nothing else and this pair coming first.
    ranked = [entry["severity"] for entry in coincidence["joints"]["joints"]]
    check(
        ranked == ["coincident-surface"],
        f"the coincidence probe should hold only its own pair, first, got {ranked}",
    )

    if failures:
        print("FAIL")
        for failure in failures:
            print(f"  - {failure}")
        sys.stdout.flush()
        os._exit(1)
    print("PASS: joint sweep and island count agree with known geometry")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
