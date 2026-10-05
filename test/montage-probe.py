#!/usr/bin/env python3
"""Drive handle_montage in a real Blender against a scene with known geometry.

The sheet's correctness has two halves. The tiling half is pure array work and
lives in test/montage-test.py. This covers the half only Blender can answer:
that the cameras end up where the orbit table says, that each panel looks at
the subject rather than at the world origin, that the temporary cameras are
gone afterwards, and that the render settings a sheet had to touch are back.

Run: blender --background --python test/montage-probe.py
Exit code 0 means every assertion held.
"""

import importlib.util
import json
import os
import sys
import tempfile

# This file's own parent directory is the repo, so the probe tests the checkout
# it lives in. A hardcoded path here meant a developer's other clone got the
# coverage instead of the code under review.
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BRIDGE = os.path.join(REPO, "blender", "live-bridge.py")

# live-bridge.py runs its module-level bootstrap on import, which creates bridge
# directories and registers a request poller, so it gets a throwaway bridge dir
# and the script has to end with os._exit rather than sys.exit.
os.environ["PI_BLENDER_BRIDGE_DIR"] = tempfile.mkdtemp(prefix="montage-probe-bridge-")
spec = importlib.util.spec_from_file_location("live_bridge", BRIDGE)
live_bridge = importlib.util.module_from_spec(spec)
sys.modules["live_bridge"] = live_bridge
spec.loader.exec_module(live_bridge)

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # noqa: E402

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
    print(f"  {'ok  ' if condition else 'FAIL'}: {message}")
    sys.stdout.flush()


def build_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    # A cube offset from the origin on purpose: a camera aimed at the world
    # origin would frame empty space, so a sheet of this scene is the test.
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(3.0, -2.0, 1.0))
    camera_data = bpy.data.cameras.new("Camera")
    camera = bpy.data.objects.new("Camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    # A light, because a sheet of unlit geometry is a sheet of black panels: the
    # assertion that two panels differ has nothing to look at otherwise.
    light_data = bpy.data.lights.new("Sun", type="SUN")
    light_data.energy = 4.0
    light = bpy.data.objects.new("Sun", light_data)
    scene.collection.objects.link(light)
    light.rotation_euler = (0.6, 0.2, 0.4)
    # Cycles on CPU, not EEVEE: this script runs with --background, where
    # EEVEE has no GL context and renders pure black, which is an artefact of
    # the harness rather than a fact about the montage. The live bridge runs in
    # a real window, where the scene's own engine applies.
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 4
    return scene


def main():
    scene = build_scene()
    # The bridge refuses to measure anything that is not the file the request
    # named, so the scene has to exist as a real blend on disk — the same
    # invariant every other read-only handler is gated on.
    blend_path = os.path.join(tempfile.mkdtemp(prefix="montage-probe-blend-"), "model.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend_path)

    # A scratch directory rather than a hardcoded one, so the probe does not
    # write into the developer's home on every run. It was previously
    # /var/home/lux/blender-dbg/montage-out, which made the output land outside
    # anything the test harness cleans up.
    output_dir = os.path.join(tempfile.mkdtemp(), "montage-out")
    os.makedirs(output_dir, exist_ok=True)
    for stale in os.listdir(output_dir):
        os.remove(os.path.join(output_dir, stale))

    before = {
        "resolution": (scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage),
        "file_format": scene.render.image_settings.file_format,
        "filepath": scene.render.filepath,
        "camera": scene.camera.name if scene.camera else None,
        "cameras": sorted(obj.name for obj in bpy.data.objects if obj.type == "CAMERA"),
        "objects": sorted(obj.name for obj in bpy.data.objects),
    }

    result = live_bridge.handle_montage(
        {
            "blendPath": blend_path,
            "views": ["front", "left", "three-quarter", "top"],
            "columns": 2,
            "panelResolution": {"x": 160, "y": 120},
            "outputDir": output_dir,
            "outputName": "montage.png",
        }
    )

    check(os.path.exists(result["montagePath"]), f"the sheet exists: {result['montagePath']}")
    check(len(result["panelPaths"]) == 4, f"four panels were written: {len(result['panelPaths'])}")
    check(all(os.path.exists(path) for path in result["panelPaths"]), "every panel path is a real file")
    check(result["layout"]["columns"] == 2, f"the sheet is 2x2: {result['layout']['columns']}")
    check(result["layout"]["rows"] == 2, f"the sheet has two rows: {result['layout']['rows']}")
    check(
        result["layout"]["panelWidth"] == 160 and result["layout"]["panelHeight"] == 120,
        f"panel size is the one asked for: {result['layout']['panelWidth']}x{result['layout']['panelHeight']}",
    )
    check("Cube" in result["subject"], f"the default subject is the visible mesh: {result['subject']}")
    check(
        os.path.getsize(result["montagePath"]) > os.path.getsize(result["panelPaths"][0]),
        "the sheet is larger than any single panel",
    )

    after = {
        "resolution": (scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage),
        "file_format": scene.render.image_settings.file_format,
        "filepath": scene.render.filepath,
        "camera": scene.camera.name if scene.camera else None,
        "cameras": sorted(obj.name for obj in bpy.data.objects if obj.type == "CAMERA"),
        "objects": sorted(obj.name for obj in bpy.data.objects),
    }
    check(after["resolution"] == before["resolution"], f"resolution restored: {after['resolution']}")
    check(after["file_format"] == before["file_format"], f"file format restored: {after['file_format']}")
    check(after["filepath"] == before["filepath"], f"filepath restored: {after['filepath']}")
    check(after["camera"] == before["camera"], f"scene camera restored: {after['camera']}")
    check(after["cameras"] == before["cameras"], f"the temporary cameras are gone: {before['cameras']} -> {after['cameras']}")
    check(after["objects"] == before["objects"], "the scene has the same objects it started with")

    # Two panels of the SAME scene differ only if the cameras moved: identical
    # bytes would mean every view rendered the same picture, which is a montage
    # that cannot compare anything.
    digests = {
        open(path, "rb").read()
        for path in result["panelPaths"]
    }
    check(len(digests) == 4, f"each view produced a distinct panel: {len(digests)} distinct of 4")

    # The framing must describe the cube, not the world: the cube sits at
    # (3, -2, 1) with half-extent 1, so its centre is (3, -2, 1) and its
    # bounding-sphere radius is sqrt(3).
    centre = result["framing"]["center"]
    expected_centre = [3.0, -2.0, 1.0]
    check(
        all(abs(a - b) < 0.01 for a, b in zip(centre, expected_centre)),
        f"framing centre is the subject's, not the world's: {centre}",
    )
    check(
        abs(result["framing"]["radius"] - 3 ** 0.5) < 0.01,
        f"framing radius is the bounding sphere: {result['framing']['radius']:.4f}",
    )
    check(
        result["framing"]["distance"] > result["framing"]["radius"],
        "the camera sits outside the subject",
    )

    # An unknown view must fail before any render, so a typo costs nothing.
    try:
        live_bridge.handle_montage(
            {
                "blendPath": blend_path,
                "views": ["front", "hero-angle"],
                "panelResolution": {"x": 80, "y": 60},
                "outputDir": output_dir,
            }
        )
        check(False, "an unknown view was accepted")
    except ValueError as error:
        check("Known views" in str(error), f"an unknown view lists the known ones: {error}")

    check(
        sorted(os.listdir(output_dir)) == sorted(
            [os.path.basename(result["montagePath"])] + [os.path.basename(p) for p in result["panelPaths"]]
        ),
        f"a rejected request wrote nothing new: {sorted(os.listdir(output_dir))}",
    )

    print(json.dumps({"montage": result["montagePath"], "panels": result["panelPaths"]}))


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    if failures:
        print("FAIL")
        for failure in failures:
            print(f"  - {failure}")
        sys.stdout.flush()
        os._exit(1)
    print("PASS: a montage frames the subject, restores the scene, and writes the sheet")
    sys.stdout.flush()
    os._exit(0)
