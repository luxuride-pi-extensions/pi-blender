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
bpy.ops.mesh.primitive_cube_add(size=1)
low = bpy.context.object
low.name = "LowCage"
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.7, segments=16, ring_count=8)
high = bpy.context.object
high.name = "HighSculpt"

output = os.path.join(tempfile.mkdtemp(prefix="pi-bake-"), "low_normal.png")
report = bake_module.bake_normal(low, high, output, resolution=64, samples=1)

check(os.path.exists(output) and os.path.getsize(output) > 0, "the normal map is written")
check(report["resolution"] == 64 and report["samples"] == 1, "the report names the resolution and samples used")
check(report["lowTriangles"] < report["highTriangles"], "the cage has fewer triangles than the sculpt")
check(0.0 <= report["triangleReduction"] <= 1.0, "the triangle reduction is a fraction")
check(report["elapsedSeconds"] >= 0, "elapsed time is reported")
material = bpy.data.materials.get(report["materialName"])
assert material is not None and material.node_tree is not None
check(material.use_nodes, "the low-poly material was created")
image_node = material.node_tree.nodes.get("BakeTarget")
assert image_node is not None and image_node.image is not None
check(True, "the material references the baked image")
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
check(os.path.exists(export_path) and os.path.getsize(export_path) > 1000, "the cage exports with the baked material")

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
