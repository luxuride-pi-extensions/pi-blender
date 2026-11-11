"""Headless coverage for the studio rig, PBR baking and export verification."""

import json
import math
import os
import sys
import tempfile

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender)
# pyright: reportMissingImports=false
import bpy  # pyright: ignore[reportMissingImports]

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "blender"))

from bake import bake_textures  # noqa: E402
from export_asset import handle_export  # noqa: E402
from lighting import STUDIO_COLLECTION, apply_studio_rig  # noqa: E402
from shading import material_summary  # noqa: E402

checks = {}


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)


def mean_luma(scene):
    scene.render.filepath = os.path.join(tempfile.mkdtemp(prefix="luma-"), "luma.png")
    bpy.ops.render.render(write_still=True)
    rendered = bpy.data.images.load(scene.render.filepath, check_existing=False)
    pixels = list(rendered.pixels)
    values = [0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] for i in range(0, len(pixels), 4)]
    return sum(values) / len(values)


def studio_camera(scene, target=(0.0, 0.0, 0.0)):
    camera_data = bpy.data.cameras.new("ReviewCamera")
    camera = bpy.data.objects.new("ReviewCamera", camera_data)
    scene.collection.objects.link(camera)
    camera.location = (0.0, -6.0, 1.0)
    # pi-lens-ignore: ast-grep:unresolved-import-python (mathutils is Blender's)
    from mathutils import Vector  # pyright: ignore[reportMissingImports]

    camera.rotation_euler = (Vector(target) - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.camera = camera


clear_scene()
user_light_data = bpy.data.lights.new("UserLamp", type="POINT")
user_light_data.energy = 10.0
user_light = bpy.data.objects.new("UserLamp", user_light_data)
bpy.context.scene.collection.objects.link(user_light)

first = apply_studio_rig("studio")
studio = bpy.data.collections[STUDIO_COLLECTION]
for name in ("StudioKey", "StudioFill", "StudioRim"):
    data = bpy.data.lights.new(name, "SUN")
    lamp = bpy.data.objects.new(name, data)
    studio.objects.link(lamp)
second = apply_studio_rig("studio")
scene = bpy.context.scene
rig_objects = [obj for obj in bpy.data.collections[STUDIO_COLLECTION].objects if obj.get("pi_studio_rig")]
checks["rig is idempotent"] = first["lightCount"] == second["lightCount"] == 3 and len(rig_objects) == 3
checks["user light survives rebuild"] = bpy.data.objects.get("UserLamp") is not None
checks["rebuild does not leak light data-blocks"] = len([light for light in bpy.data.lights if light.name.startswith("PI_")]) == 3
checks["rig sets view transform and exposure"] = scene.view_settings.view_transform == "Standard" and scene.view_settings.exposure == 0.0
checks["film transparency is explicit"] = scene.render.film_transparent is False

bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16)
subject = bpy.context.object
subject.name = "ReviewSubject"
for material in list(bpy.data.materials):
    bpy.data.materials.remove(material)
material = bpy.data.materials.new("CheckerBake")
material.use_nodes = True
subject.data.materials.append(material)
nodes = material.node_tree.nodes
bsdf = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
checker = nodes.new("ShaderNodeTexChecker")
checker.inputs["Scale"].default_value = 8.0
# A fully metallic surface has no diffuse pass; baking base colour through
# DIFFUSE would make this image uniformly black and the stddev check would fail.
bsdf.inputs["Metallic"].default_value = 1.0
material.node_tree.links.new(checker.outputs["Color"], bsdf.inputs["Base Color"])

studio_camera(scene)
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 8
scene.render.resolution_x = 64
scene.render.resolution_y = 64
scene.render.resolution_percentage = 100
for obj in list(bpy.data.collections[STUDIO_COLLECTION].objects):
    if obj.get("pi_studio_rig"):
        bpy.data.objects.remove(obj, do_unlink=True)
scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
dark = mean_luma(scene)
apply_studio_rig("studio")
lit = mean_luma(scene)
checks["rig moves mean luma in the expected direction"] = lit > dark + 0.02

scene.render.engine = "BLENDER_WORKBENCH"
output_dir = tempfile.mkdtemp(prefix="bake-review-")
baked = bake_textures(subject, ["base_color", "roughness", "metallic", "ao", "normal"], resolution=128, samples=8, output_dir=output_dir)
channels = {entry["channel"]: entry for entry in baked["channels"]}
checks["bake covers every channel"] = set(channels) == {"base_color", "roughness", "metallic", "ao", "normal"}
checks["base colour is sRGB and data maps are non-color"] = (
    channels["base_color"]["colorSpace"] == "sRGB" and channels["roughness"]["colorSpace"] == "Non-Color"
)
checks["baked files exist and are packed"] = all(
    os.path.exists(entry["imagePath"]) and bpy.data.images[entry["imageName"]].packed_file is not None
    for entry in baked["channels"]
)
base_image = bpy.data.images[channels["base_color"]["imageName"]]
samples = list(base_image.pixels)[::4]
mean = sum(samples) / len(samples)
stddev = math.sqrt(sum((value - mean) ** 2 for value in samples) / len(samples))
checks["base colour bake is non-uniform"] = stddev > 0.02
checks["baked material is no longer procedural"] = material_summary(material)["procedural"] is False
checks["baked channels are linked"] = all(entry["linked"] for entry in baked["channels"])
checks["ao ray distance follows the subject"] = (baked.get("aoDistance") or 0) > 0
checks["material receives the baked image node"] = material.node_tree.nodes.get("Baked_base_color") is not None
checks["bake switched to Cycles and restored the engine"] = baked["engineSwitched"] and baked["engineRestored"]

no_uv = bpy.data.meshes.new("NoUvMesh")
no_uv.from_pydata([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [], [(0, 1, 2)])
no_uv_object = bpy.data.objects.new("NoUvObject", no_uv)
scene.collection.objects.link(no_uv_object)
try:
    bake_textures(no_uv_object, ["base_color"], resolution=64, samples=4, output_dir=output_dir)
    checks["missing UVs is actionable"] = False
except ValueError as error:
    checks["missing UVs is actionable"] = "needs UVs" in str(error) and "unwrap" in str(error)
try:
    bake_textures(subject, ["base_color"], resolution=128, samples=8, output_dir=output_dir, time_budget_seconds=0.001)
    checks["impossible time budget is actionable"] = False
except ValueError as error:
    checks["impossible time budget is actionable"] = "budget" in str(error) and "resolution" in str(error)

export_dir = tempfile.mkdtemp(prefix="export-review-")
exported = handle_export({"format": "glb", "outputDir": export_dir, "name": "review"}, lambda request: None)
checks["export verifies embedded images"] = exported["images"] > 0 and exported["textures"] > 0 and exported["texturesVerified"] is True

subject.name = "Soup Bowl"
spaced = bpy.data.images[channels["base_color"]["imageName"]]
spaced.name = "Soup Bowl base"
spaced.filepath = "//Soup Bowl base.png"
separate_dir = os.path.join(os.path.dirname(__file__), "..", ".tmp-gltf")
separate = handle_export({"format": "gltf", "objects": [subject.name], "outputDir": separate_dir}, lambda request: None)
with open(separate["exportPath"], encoding="utf-8") as handle:
    uris = [image.get("uri", "") for image in json.load(handle).get("images", [])]
checks["gltf percent-encoded image names resolve"] = separate.get("texturesVerified") is True and any("%20" in uri for uri in uris)

broken = bpy.data.materials.new("BrokenSurface")
broken.use_nodes = True
broken.node_tree.links.remove(broken.node_tree.nodes["Principled BSDF"].outputs["BSDF"].links[0])
checks["a disconnected surface is still procedural"] = material_summary(broken)["procedural"] is True

ok = all(checks.values())
print(json.dumps({"ok": ok, "checks": checks}))
if not ok:
    raise SystemExit(1)
print("PASS: studio lighting and texture bake")
