#!/usr/bin/env python3
"""
Exercise live-bridge.py's shape family against real Blender geometry.

Why a real Blender: every number the shape family reports is computed from
bpy/mathutils, so a mock proves only that the arithmetic is self-consistent.
This script builds meshes whose correct answers are known by construction
(a sphere is symmetric and convex, a lopsided dumbbell is not convex), asks
the handler for the `shape` check, and asserts the verdicts.

Importing live-bridge.py runs its module-level bootstrap -- it creates bridge
dirs and registers a request-polling timer -- so a throwaway bridge dir goes in
the environment first, and the process leaves with os._exit() because a
registered persistent timer would otherwise keep Blender alive forever.

Run: blender --background --python test/shape-probe.py
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


def make_sphere(name, radius=0.5, segments=32, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, segments=segments, ring_count=rings)
    obj = bpy.context.active_object
    obj.name = name
    return obj


def make_cube(name, size=1.0, location=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.active_object
    obj.name = name
    return obj


def make_open_plane(name):
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=2, y_subdivisions=2, size=2.0)
    obj = bpy.context.active_object
    obj.name = name
    return obj


def load_live_bridge():
    bridge_dir = tempfile.mkdtemp(prefix="pi-blender-shape-probe-")
    os.environ["PI_BLENDER_BRIDGE_DIR"] = bridge_dir
    path = os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "blender", "live-bridge.py"
    )
    spec = importlib.util.spec_from_file_location("live_bridge", os.path.normpath(path))
    # spec_from_file_location returns None for a path it cannot resolve to a
    # module. Reaching module_from_spec with None raises inside importlib with a
    # message that names neither this file nor the path, so it is turned into
    # one that does -- and the failure then says the probe's own subject is
    # missing rather than pointing at the dynamic import.
    if spec is None or spec.loader is None:
        raise RuntimeError(f"no module spec for the live bridge at {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module, os.path.join(bridge_dir, "scratch.blend")


def probe(live_bridge, blend_path, objects, checks):
    # handle_geometry_probe calls ensure_requested_blend_open, which reads
    # request["blendPath"] unconditionally -- the handler is written for a
    # workspace, not for a raw in-memory scene. Saving the blank and passing
    # that path back is how the probe is pointed at the scene this script
    # builds: the early return fires on the path match, so nothing is reloaded.
    return live_bridge.handle_geometry_probe(
        {"blendPath": blend_path, "objects": objects, "checks": checks}
    )


def main():
    live_bridge, scratch_blend = load_live_bridge()
    bpy.ops.wm.save_as_mainfile(filepath=scratch_blend)

    sphere = make_sphere("Sphere")
    result = probe(live_bridge, scratch_blend, [sphere.name], ["shape"])
    shape = result["objects"][sphere.name]["shape"]

    check(shape["vertices"] == len(sphere.data.vertices), "sphere vertex count mismatch")
    check(shape["profileAxis"] == "Z", f"expected a Z profile axis, got {shape['profileAxis']}")
    profile = shape["profile"]
    check(profile is not None, "sphere has no radius profile")
    check(all(r > 0 for r in profile["radius"]), f"sphere has a non-positive radius sample: {profile['radius']}")
    # A sphere's radius is the same at every height, so taper is ~0 and
    # monotonic is ~0.5 (the samples are equal, so half the comparisons count
    # as "not growing").
    check(abs(profile["taper"]) < 0.05, f"sphere taper should be ~0, got {profile['taper']}")
    # A sphere IS mirror-symmetric about all three axes.
    check(shape["selfSymmetry"]["mirrorAxis"] is not None, "sphere reported as not symmetric about any axis")
    check(shape["selfSymmetry"]["deviationRatio"] < 0.05, f"sphere symmetry ratio {shape['selfSymmetry']['deviationRatio']}")
    # A sphere is convex: every vertex sits on its own hull.
    check(shape["convexityRatio"] == 1.0, f"sphere convexity should be 1.0, got {shape['convexityRatio']}")
    check(shape["openEdges"] == 0, f"sphere has {shape['openEdges']} open edges")
    check(shape["looseVerts"] == 0, f"sphere has {shape['looseVerts']} loose verts")

    # A cube off the origin: still symmetric, because the mirror plane is the
    # mesh's own centre, not the world origin.
    cube = make_cube("Cube", size=1.0, location=(3.0, -2.0, 5.0))
    result = probe(live_bridge, scratch_blend, [cube.name], ["shape"])
    cube_shape = result["objects"][cube.name]["shape"]
    check(cube_shape["selfSymmetry"]["mirrorAxis"] is not None, "offset cube reported as asymmetric")
    check(cube_shape["convexityRatio"] == 1.0, f"cube convexity should be 1.0, got {cube_shape['convexityRatio']}")
    # A cube's profile along Z is constant: its side length, not a taper.
    check(
        all(abs(r - cube_shape["profile"]["radius"][0]) < 1e-3 for r in cube_shape["profile"]["radius"]),
        f"cube profile should be flat, got {cube_shape['profile']['radius']}",
    )

    # A lopsided dumbbell: two spheres joined by a thin bridge, offset in +X.
    # The offset makes it asymmetric about its own centre, and the waist
    # makes it non-convex, so both numbers must say so.
    left = make_sphere("Left", radius=0.3, segments=24, rings=12)
    right = make_sphere("Right", radius=0.3, segments=24, rings=12)
    right.location.x = 0.8
    bpy.context.view_layer.objects.active = right
    bpy.ops.object.select_all(action="DESELECT")
    for part in (left, right):
        part.select_set(True)
    bpy.ops.object.join()
    dumbbell = bpy.context.active_object
    dumbbell.name = "Dumbbell"
    dumbbell.location.x = 2.0
    bpy.context.view_layer.update()
    result = probe(live_bridge, scratch_blend, [dumbbell.name], ["shape"])
    dumbbell_shape = result["objects"][dumbbell.name]["shape"]
    # Two joined spheres have no gap, so they are still mirror-symmetric about
    # the plane between them -- what makes this dumbbell a shape problem is the
    # waist, which convexity catches.
    check(dumbbell_shape["convexityRatio"] < 0.99, f"dumbbell should not be convex, got {dumbbell_shape['convexityRatio']}")
    # The waist: the middle of the X profile must be narrower than the ends.
    x_profile = dumbbell_shape["profile"]
    check(
        x_profile["radius"][0] > x_profile["radius"][len(x_profile["radius"]) // 2],
        f"dumbbell profile should pinch in the middle, got {x_profile['radius']}",
    )

    # An open plane: every boundary edge is an open edge. Blender's grid has a
    # face on both sides of a boundary edge, so the test is the edge's adjacent
    # face area rather than link_faces: a zero-area adjacent face is a wire
    # boundary in effect, and a real closed mesh has no such edge.
    plane = make_open_plane("Plane")
    result = probe(live_bridge, scratch_blend, [plane.name], ["shape"])
    plane_shape = result["objects"][plane.name]["shape"]
    check(plane_shape["openEdges"] > 0, "an open plane reported zero open edges")

    if failures:
        print("FAIL")
        for failure in failures:
            print(f"  - {failure}")
        sys.stdout.flush()
        os._exit(1)
    print("PASS: shape family agrees with known geometry")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
