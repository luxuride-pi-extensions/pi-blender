"""Render the critic calibration fixture set from Blender primitives.

Every pixel under test/fixtures/critic-calibration/images/ is built here, from
cylinders, cubes and tori. Nothing is downloaded and nothing is traced, so the
set needs no attribution beyond the repository licence and can be regenerated
by anyone with Blender installed. The label for each render is authored in
CASES below, next to the construction that produces it, so a change to the
variant and a change to its label cannot drift apart unnoticed.

Determinism is the point of the script rather than a nice property: the
calibration proxy compares a defective render against the clean render of the
same object, which only means anything if the camera, the lighting and the
sampler are identical. Cycles is fixed to a CPU device, one seed, a fixed
sample count and no adaptive sampling or denoising; the camera is orthographic
so a subject's silhouette width in pixels is its width in metres times a
constant. Re-running on the same Blender version reproduces the same pixels,
which is why the manifest can carry sha256 hashes at all. A Blender upgrade may
change the sampler and therefore the hashes: regenerate, then re-run the
calibration test, which is where the hashes are checked.

Run it with Blender, not with Python:

    HOME=/var/home/lux flatpak run --command=blender org.blender.Blender \\
        --background --factory-startup --python \\
        /abs/path/scripts/generate-calibration-fixtures.py

The output directory defaults to test/fixtures/critic-calibration next to this
script; pass `-- --out <dir>` after the `--` to render somewhere else. The
script rewrites manifest.json from the labels below and the hashes it just
measured, so the manifest can never disagree with the images it describes. It
does NOT write README.md: the thresholds and the "how to add a case" prose are
explained there, and regenerating pixels must not rewrite documentation.
"""

from __future__ import annotations

import hashlib
import json
import math
import sys
from pathlib import Path

# bpy and mathutils are Blender's own modules: they exist inside the Blender
# process that runs this file and nowhere else, so a host-side type checker can
# only report them missing. Resolving them would mean installing Blender as a
# Python dependency, which is the wrong dependency for a generator script.
import bpy  # pyright: ignore[reportMissingImports]
from mathutils import Vector  # pyright: ignore[reportMissingImports]

# --- render settings, recorded in the manifest ---------------------------------

RESOLUTION = (400, 300)
SAMPLES = 24
SEED = 0
# Standard, not AgX: the clipped-exposure case has to be able to pin channels at
# 1.0. AgX rolls highlights off instead of clipping them, so an "overexposed"
# render under the default view transform would keep detail and the fixture
# would label a defect that the pixels do not show.
VIEW_TRANSFORM = "Standard"
# Pure black. The image probe treats a pixel equal to the background as
# background, so a black world makes the subject mask exactly "the object" with
# no per-image background colour to get wrong.
WORLD_COLOR = (0.0, 0.0, 0.0)
KEY_LIGHT_WATTS = 900.0
FILL_LIGHT_WATTS = 260.0
EXPOSE_OVERCLIPPED = 5.0

PROVENANCE = (
    "Self-authored: every render is built from Blender primitives by "
    "scripts/generate-calibration-fixtures.py in this repository. No third-party "
    "image, texture, model or font is used, so the set carries no attribution "
    "obligation."
)
LICENSE = (
    "MIT, the same licence as the rest of pi-blender (see LICENSE and "
    "LICENSING.md). Not CC0: the repository already grants MIT over its own "
    "artefacts and a second licence for part of the tree only makes the terms "
    "harder to state, not freer."
)

# Thresholds are enforced by scripts/critic-proxy.mjs; they are copied into the
# manifest so the labels and the numbers that produce them are readable in one
# place, and the calibration test fails if the two ever disagree.
THRESHOLDS = {
    "clippedShare": 0.25,
    "clippedSevereShare": 0.5,
    "flatNeutralShare": 0.85,
    "chromaNeutral": 0.12,
    "partialLossShare": 0.05,
    "missingSevereShare": 0.15,
    "collapsedAreaShare": 0.6,
    "collapsedHeightShare": 0.4,
    "frameBleedCoverage": 0.35,
}

# --- scene plumbing ------------------------------------------------------------


def reset_scene() -> bpy.types.Scene:
    """An empty scene with the fixture's camera, lights and render settings."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = SAMPLES
    scene.cycles.seed = SEED
    scene.cycles.use_animated_seed = False
    # Adaptive sampling stops early per pixel, so the sample count becomes a
    # property of the noise rather than of the fixture, and two runs disagree.
    scene.cycles.use_adaptive_sampling = False
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = RESOLUTION
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    # Dither off: Cycles dithers by default, which leaves single-pixel values of
    # 1-3 in a black background. The image probe has to call those background to
    # find the subject, so dither would either blur the silhouette into the
    # frame or force a tolerance that softens the subject edge with it.
    scene.render.dither_intensity = 0.0
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGB"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 100
    scene.view_settings.view_transform = VIEW_TRANSFORM
    scene.view_settings.look = "None"
    scene.view_settings.exposure = 0.0

    world = bpy.data.worlds.new("fixture-world")
    world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs[0].default_value = (*WORLD_COLOR, 1.0)
    background.inputs[1].default_value = 1.0
    scene.world = world

    camera = bpy.data.cameras.new("fixture-camera")
    camera.type = "ORTHO"
    # The frame is 4 x 3 metres at 400x300, i.e. exactly 100 px per metre, and
    # the camera is fixed for every case so a silhouette diff is a diff of the
    # object and not of the framing. It is centred at z=1.3 rather than 1.5 so
    # the ground plane (z=0, where every object stands) sits 0.2 m above the
    # bottom edge: a clean render that is cropped by the frame would make the
    # wrong_scale rule ambiguous, and "a whole object" is what a pass label has
    # to mean. The highest subject (the blockout figure, 2.65 m) still clears
    # the top edge by 0.15 m.
    camera.ortho_scale = 4.0
    camera_object = bpy.data.objects.new("fixture-camera", camera)
    camera_object.location = (0.0, -8.0, 1.3)
    camera_object.rotation_euler = (math.pi / 2, 0.0, 0.0)
    scene.collection.objects.link(camera_object)
    scene.camera = camera_object

    add_area_light("key", (3.2, -4.2, 4.6), KEY_LIGHT_WATTS, 3.0)
    add_area_light("fill", (-4.0, -3.0, 2.2), FILL_LIGHT_WATTS, 4.0)
    return scene


def add_area_light(name: str, location, watts: float, size: float) -> None:
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = watts
    data.size = size
    light = bpy.data.objects.new(name, data)
    light.location = location
    # Aim at the origin of the subject, so the gradient across the object is a
    # property of the fixture's geometry and light placement, not of a rotation
    # that has to be re-guessed when a case moves an object.
    direction = Vector((0.0, 0.0, 1.2)) - Vector(location)
    light.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(light)


def material(name: str, color, roughness: float = 0.45) -> bpy.types.Material:
    """A Principled material, i.e. one that responds to light and shows shading."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    principled = mat.node_tree.nodes["Principled BSDF"]
    principled.inputs["Base Color"].default_value = (*color, 1.0)
    principled.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = (*color, 1.0)
    return mat


def flat_material(name: str, color) -> bpy.types.Material:
    """An emissive grey: the same value everywhere, which is what "flat" means.

    Emission rather than "a Principled node with the light removed" because a
    shader that responds to nothing still returns one constant, and that is the
    pixel signature the proxy measures. A diffuse default grey would still be
    shaded by the two lights and would look like a plain material, not a flat
    one.
    """
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = (*color, 1.0)
    emission.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    mat.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    mat.diffuse_color = (*color, 1.0)
    return mat


def cube(name: str, size, location, mat: bpy.types.Material) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    obj.data.materials.append(mat)
    return obj


# --- the three objects ---------------------------------------------------------


def build_mug(mat: bpy.types.Material) -> list[bpy.types.Object]:
    """A ceramic mug: an open cylinder with a torus handle on screen-right."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=0.55, depth=1.1, location=(0.0, 0.0, 0.55))
    body = bpy.context.active_object
    body.name = "mug-body"
    body.data.materials.append(mat)
    # A torus's hole points along +Z; rotate it 90 degrees about X so the hole
    # faces the camera and the loop reads as a handle from the front.
    bpy.ops.mesh.primitive_torus_add(
        major_radius=0.30,
        minor_radius=0.075,
        major_segments=48,
        minor_segments=16,
        location=(0.82, 0.0, 0.62),
        rotation=(math.pi / 2, 0.0, 0.0),
    )
    handle = bpy.context.active_object
    handle.name = "mug-handle"
    handle.data.materials.append(mat)
    return [body, handle]


def build_arch(mat: bpy.types.Material) -> list[bpy.types.Object]:
    """A stone arch: two piers, a lintel and a keystone."""
    parts = [
        cube("arch-pier-left", (0.42, 0.5, 1.5), (-0.85, 0.0, 0.75), mat),
        cube("arch-pier-right", (0.42, 0.5, 1.5), (0.85, 0.0, 0.75), mat),
        cube("arch-lintel-left", (0.6, 0.5, 0.34), (-0.55, 0.0, 1.66), mat),
        cube("arch-lintel-right", (0.6, 0.5, 0.34), (0.55, 0.0, 1.66), mat),
        cube("arch-keystone", (0.4, 0.52, 0.46), (0.0, 0.0, 1.72), mat),
        cube("arch-plinth", (2.2, 0.6, 0.18), (0.0, 0.0, 0.09), mat),
    ]
    return parts


def build_character(skin: bpy.types.Material, shirt: bpy.types.Material, trousers: bpy.types.Material) -> list[bpy.types.Object]:
    """A blockout character: head, torso, two arms, two legs."""
    return [
        cube("char-head", (0.44, 0.4, 0.44), (0.0, 0.0, 2.42), skin),
        cube("char-torso", (0.72, 0.36, 0.86), (0.0, 0.0, 1.77), shirt),
        cube("char-arm-left", (0.2, 0.24, 0.8), (-0.5, 0.0, 1.78), shirt),
        cube("char-arm-right", (0.2, 0.24, 0.8), (0.5, 0.0, 1.78), shirt),
        cube("char-leg-left", (0.26, 0.3, 0.92), (-0.2, 0.0, 0.63), trousers),
        cube("char-leg-right", (0.26, 0.3, 0.92), (0.2, 0.0, 0.63), trousers),
    ]


# --- the labelled cases --------------------------------------------------------


def mug_clean() -> list[bpy.types.Object]:
    return build_mug(material("mug-ceramic", (0.52, 0.18, 0.08), 0.35))


def mug_no_handle() -> list[bpy.types.Object]:
    body, handle = build_mug(material("mug-ceramic", (0.52, 0.18, 0.08), 0.35))
    bpy.data.objects.remove(handle, do_unlink=True)
    return [body]


def arch_clean() -> list[bpy.types.Object]:
    return build_arch(material("arch-sandstone", (0.46, 0.36, 0.24), 0.7))


def character_clean() -> list[bpy.types.Object]:
    return build_character(
        material("char-skin", (0.72, 0.46, 0.34), 0.6),
        material("char-shirt", (0.09, 0.2, 0.45), 0.6),
        material("char-trousers", (0.16, 0.15, 0.14), 0.7),
    )


def character_collapsed() -> list[bpy.types.Object]:
    """Every part squashed to 2% of its height and pulled down to the floor.

    A flattened mesh, not a small one: the silhouette keeps its width and loses
    its height, which is the shape an accidentally-scaled object takes and the
    one a proxy can tell apart from "the object is far away" by comparing with
    the clean render's height and width separately.
    """
    parts = character_clean()
    for obj in parts:
        obj.scale[2] *= 0.02
        obj.location[2] *= 0.02
    return parts


def character_stretched() -> list[bpy.types.Object]:
    """4.2x wider than the frame: a scale error the render cannot contain."""
    parts = character_clean()
    for obj in parts:
        obj.scale[0] *= 4.2
        obj.location[0] *= 4.2
    return parts


def mug_flat() -> list[bpy.types.Object]:
    return build_mug(flat_material("mug-flat-grey", (0.5, 0.5, 0.5)))


def mug_overexposed() -> list[bpy.types.Object]:
    parts = build_mug(material("mug-ceramic", (0.52, 0.18, 0.08), 0.35))
    bpy.context.scene.view_settings.exposure = EXPOSE_OVERCLIPPED
    return parts


CASES = [
    {
        "id": "mug-pass-01",
        "build": mug_clean,
        "expectedAxes": {},
        "pass": True,
        "defects": [],
        "reference": None,
        "notes": "Clean terracotta mug with handle. The false-positive side of the proxy: it must not be called defective.",
    },
    {
        "id": "arch-pass-02",
        "build": arch_clean,
        "expectedAxes": {},
        "pass": True,
        "defects": [],
        "reference": None,
        "notes": "Clean sandstone arch prop, a second object shape so the passes are not one material on one silhouette.",
    },
    {
        "id": "character-pass-03",
        "build": character_clean,
        "expectedAxes": {},
        "pass": True,
        "defects": [],
        "reference": None,
        "notes": "Clean blockout character with three materials and six parts.",
    },
    {
        "id": "defect-collapsed-silhouette",
        "build": character_collapsed,
        "expectedAxes": {"geometry": 0, "validity": 0},
        "pass": False,
        "defects": ["collapsed_silhouette"],
        "reference": "character-pass-03",
        "notes": "The character squashed to 2% height: same width as the clean render, almost no height and no area.",
    },
    {
        "id": "defect-missing-handle",
        "build": mug_no_handle,
        "expectedAxes": {"completeness": 0},
        "pass": False,
        "defects": ["missing_handle"],
        "reference": "mug-pass-01",
        "notes": "The mug without its handle: the same body, one part missing from the silhouette.",
    },
    {
        "id": "defect-wrong-scale",
        "build": character_stretched,
        "expectedAxes": {"geometry": 0, "accuracy": 0},
        "pass": False,
        "defects": ["wrong_scale"],
        "reference": None,
        "notes": "The character 4.2x too wide: the silhouette is cropped by both sides of the frame.",
    },
    {
        "id": "defect-flat-material",
        "build": mug_flat,
        "expectedAxes": {"materials": 0},
        "pass": False,
        "defects": ["flat_material"],
        "reference": None,
        "notes": "The mug in a single emissive grey: correct silhouette, no shading, no colour.",
    },
    {
        "id": "defect-clipped-exposure",
        "build": mug_overexposed,
        "expectedAxes": {"quality": 0},
        "pass": False,
        "defects": ["clipped_exposure"],
        "reference": None,
        "notes": f"The clean mug at +{EXPOSE_OVERCLIPPED:g} EV: the subject's channels pin at white and hold no detail.",
    },
]


# --- rendering and manifest ----------------------------------------------------


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def output_dir(argv: list[str]) -> Path:
    if "--out" in argv:
        index = argv.index("--out")
        if index + 1 >= len(argv):
            raise SystemExit("--out needs a directory")
        return Path(argv[index + 1]).resolve()
    return repo_root() / "test" / "fixtures" / "critic-calibration"


def render_case(case: dict, images_dir: Path) -> Path:
    # The builders run against the current scene, so the reset has to happen
    # before each one: a case that inherits the previous case's objects would
    # render two subjects and label the picture with one.
    scene = reset_scene()
    case["build"]()
    path = images_dir / f"{case['id']}.png"
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return path


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    out = output_dir(argv)
    images_dir = out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    for case in CASES:
        path = render_case(case, images_dir)
        entries.append(
            {
                "id": case["id"],
                "file": f"images/{path.name}",
                "sha256": sha256_of(path),
                "bytes": path.stat().st_size,
                "width": RESOLUTION[0],
                "height": RESOLUTION[1],
                "reference": case["reference"],
                "truth": {
                    "pass": case["pass"],
                    "defects": list(case["defects"]),
                    "expectedAxes": dict(case["expectedAxes"]),
                },
                "notes": case["notes"],
            }
        )

    manifest = {
        "version": 1,
        "generator": "scripts/generate-calibration-fixtures.py",
        "provenance": PROVENANCE,
        "license": LICENSE,
        "render": {
            "engine": "CYCLES",
            "device": "CPU",
            "samples": SAMPLES,
            "seed": SEED,
            "adaptiveSampling": False,
            "denoising": False,
            "resolution": list(RESOLUTION),
            "viewTransform": VIEW_TRANSFORM,
            "exposure": 0.0,
            "overexposedCaseEv": EXPOSE_OVERCLIPPED,
            "worldColor": list(WORLD_COLOR),
            "keyLightWatts": KEY_LIGHT_WATTS,
            "fillLightWatts": FILL_LIGHT_WATTS,
            "camera": {"type": "ORTHO", "orthoScale": 4.0, "location": [0.0, -8.0, 1.3], "rotation": [math.pi / 2, 0.0, 0.0]},
            "blenderVersion": bpy.app.version_string,
            "totalBytes": sum(entry["bytes"] for entry in entries),
        },
        "thresholds": THRESHOLDS,
        "images": entries,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(entries)} renders, {manifest['render']['totalBytes']} bytes total, to {out}")


main()
