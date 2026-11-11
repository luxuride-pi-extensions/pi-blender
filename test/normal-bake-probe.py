#!/usr/bin/env python3
"""Bake a sculpted sphere onto a cube and verify the delivered map."""

import importlib.util
import os
import sys
import tempfile

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]

failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
    print(f"  {'ok  ' if condition else 'FAIL'}: {message}")
    sys.stdout.flush()


spec = importlib.util.spec_from_file_location(
    "bake",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender", "bake.py"),
)
assert spec is not None and spec.loader is not None
bake_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bake_module)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1, calc_uvs=False)
low = bpy.context.object
low.name = "LowCage"
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.7, segments=16, ring_count=8)
high = bpy.context.object
high.name = "HighSculpt"

scene = bpy.context.scene
engine_before = scene.render.engine
samples_before = scene.cycles.samples
device_before = scene.cycles.device
bake_before = (scene.render.bake.use_selected_to_active, scene.render.bake.cage_extrusion, scene.render.bake.margin)
active_before = bpy.context.view_layer.objects.active
selected_before = list(bpy.context.selected_objects)
output = os.path.join(tempfile.mkdtemp(prefix="pi-bake-"), "low_normal.png")
report = bake_module.bake_normal(low, high, output, resolution=64, samples=1, cage_extrusion=0.25)

check(os.path.exists(output) and os.path.getsize(output) > 0, "the normal map is written")
check(report["resolution"] == 64 and report["samples"] == 1, "the report names the resolution and samples used")
check(report["lowTriangles"] < report["highTriangles"], "the cage has fewer triangles than the sculpt")
check(0.0 <= report["triangleReduction"] <= 1.0, "the triangle reduction is a fraction")
check(report["elapsedSeconds"] >= 0, "elapsed time is reported")
check(len(low.data.uv_layers) > 0 and report["uvCreated"] is True, "a cage without UVs is unwrapped for the bake")
check(scene.render.engine == engine_before, "the previous engine is restored after the bake")
check(list(bpy.context.selected_objects) == selected_before, "the previous selection is restored after the bake")
check(bpy.context.view_layer.objects.active == active_before, "the previous active object is restored after the bake")
check(scene.cycles.samples == samples_before and scene.cycles.device == device_before, "the sample count and device are restored after the bake")
check((scene.render.bake.use_selected_to_active, scene.render.bake.cage_extrusion, scene.render.bake.margin) == bake_before, "the bake settings are restored after the bake")
material = bpy.data.materials.get(report["materialName"])
assert material is not None and material.node_tree is not None
check(material.use_nodes, "the low-poly material was created")
image_node = material.node_tree.nodes.get("BakeTarget")
assert image_node is not None and image_node.image is not None
pixels = image_node.image.pixels[:]
check(
    max(pixels[0::4]) - min(pixels[0::4]) > 0.02 and max(pixels[1::4]) - min(pixels[1::4]) > 0.02,
    "the baked image is not a flat colour",
)
check(image_node.image.packed_file is not None, "the image is packed so a glTF export embeds it")
normal_map = material.node_tree.nodes.get("BakedNormalMap")
assert normal_map is not None
links = material.node_tree.links
for link in links:
    print(f"  link: {link.from_node.name}.{link.from_socket.name} -> {link.to_node.name}.{link.to_socket.name}")
check(any(link.to_node == normal_map for link in links), "the baked image feeds a Normal Map node")
check(
    any(link.from_node == normal_map and link.to_socket.name == "Normal" for link in links),
    "the Normal Map drives the Principled normal input",
)

export_path = os.path.join(os.path.dirname(output), "asset.glb")
bpy.ops.object.select_all(action="DESELECT")
low.select_set(True)
bpy.context.view_layer.objects.active = low
bpy.ops.export_scene.gltf(filepath=export_path, export_format="GLB", use_selection=True)
with open(export_path, "rb") as handle:
    raw = handle.read()
length = int.from_bytes(raw[12:16], "little")
document = raw[20 : 20 + length].decode("utf-8")
check(
    os.path.getsize(export_path) > 1000 and "normalTexture" in document and '"images"' in document,
    "the cage exports with the baked normal texture",
)

try:
    bake_module.bake_normal(low, high, output, resolution=8, samples=1)
    check(False, "a resolution below 16 is rejected")
except ValueError:
    check(True, "a resolution below 16 is rejected")

if failures:
    print("FAIL: normal bake")
    sys.stdout.flush()
    os._exit(1)
print("PASS: normal bake writes a packed map and exports it")
sys.stdout.flush()
os._exit(0)
