# ruff: noqa: E402, I001
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender"))

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender)
import bpy  # pyright: ignore[reportMissingImports]
from shading import build_material, material_summary  # pyright: ignore[reportMissingImports]

checks = {}

metal = {
    "preset": "metal",
    "baseColor": [0.55, 0.57, 0.6, 1.0],
    "roughness": 0.3,
    "coordinates": "Object",
    "textures": [
        {
            "kind": "noise",
            "scale": 14.0,
            "detail": 4.0,
            "target": "roughness",
            "output": "fac",
            "ramp": {"stops": [{"position": 0.35, "color": [0.15, 0.15, 0.15, 1.0]}, {"position": 0.8, "color": [0.6, 0.6, 0.6, 1.0]}]},
        }
    ],
    "bump": {"kind": "noise", "scale": 60.0, "strength": 0.15},
}

brick = {
    "preset": "dielectric",
    "baseColor": [0.45, 0.12, 0.08, 1.0],
    "coordinates": "Generated",
    "textures": [
        {
            "kind": "brick",
            "scale": 6.0,
            "mortarSize": 0.02,
            "target": "base_color",
            "ramp": [
                {"position": 0.0, "color": [0.2, 0.03, 0.02, 1.0]},
                {"position": 0.12, "color": [0.8, 0.75, 0.7, 1.0]},
            ],
        }
    ],
}

checker = {
    "preset": "emission",
    "baseColor": [0.02, 0.02, 0.02, 1.0],
    "emissionColor": [0.1, 0.6, 1.0, 1.0],
    "emissionStrength": 4.0,
    "coordinates": "UV",
    "textures": [{"kind": "checker", "scale": 20.0, "target": "base_color"}],
}

first = build_material("ReviewMetal", metal)
second = build_material("ReviewMetal", metal)
third = build_material("ReviewBrick", brick)
fourth = build_material("ReviewChecker", checker)

checks["rebuild is byte-identical"] = first["graphDigest"] == second["graphDigest"] and first["nodeCount"] == second["nodeCount"]
checks["three recipes differ"] = len({first["graphDigest"], third["graphDigest"], fourth["graphDigest"]}) == 3
checks["procedural reported"] = first["procedural"] is True and third["procedural"] is True
checks["object-space noise needs no UVs"] = first["uvDependent"] is False
checks["UV coordinate use reported"] = fourth["uvDependent"] is True
checks["principled values follow the recipe"] = abs(first["roughness"] - 0.3) < 1e-6 and abs(first["metallic"] - 1.0) < 1e-6
checks["emission preset sets strength"] = abs(fourth.get("emissionStrength", 0.0) - 4.0) < 1e-6
checks["all nodes preserved"] = first["nodeCount"] >= 6 and third["nodeCount"] >= 6

material = bpy.data.materials["ReviewMetal"]
checks["links target one principled node"] = sum(1 for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED") == 1
checks["digest is sha256"] = len(first["graphDigest"]) == 64
alt_ramp = dict(metal)
alt_ramp["textures"] = [dict(metal["textures"][0])]
alt_ramp["textures"][0]["ramp"] = {"stops": [{"position": 0.35, "color": [0.9, 0.1, 0.1, 1.0]}, {"position": 0.8, "color": [0.6, 0.6, 0.6, 1.0]}]}
fifth = build_material("ReviewMetalAlt", alt_ramp)
checks["ramp colours are part of the digest"] = fifth["graphDigest"] != first["graphDigest"]

voronoi_bump = dict(metal)
voronoi_bump["bump"] = {"kind": "voronoi", "scale": 30.0, "strength": 0.1}
try:
    voronoi = build_material("ReviewVoronoiBump", voronoi_bump)
    bump_link = bpy.data.materials["ReviewVoronoiBump"].node_tree.nodes["Bump"].inputs["Height"].links[0]
    checks["voronoi bump uses its distance output"] = (
        bump_link.from_socket.name == "Distance" and voronoi["nodeCount"] == first["nodeCount"]
    )
except KeyError:
    checks["voronoi bump uses its distance output"] = False

before_invalid = first["graphDigest"]
try:
    build_material("ReviewMetal", {"preset": "nope"})
    checks["unknown preset is rejected"] = False
except ValueError:
    checks["unknown preset is rejected"] = (
        material_summary(bpy.data.materials["ReviewMetal"])["graphDigest"] == before_invalid
    )

import tempfile  # noqa: E402

import export_asset  # noqa: E402  # pyright: ignore[reportMissingImports]

bpy.ops.mesh.primitive_cube_add()
review_object = bpy.context.object
review_object.name = "ReviewCube"
review_object.data.materials.append(material)
build_material("UnselectedMetal", metal)
bpy.ops.mesh.primitive_cube_add(location=(4.0, 0.0, 0.0))
unselected = bpy.context.object
unselected.name = "UnselectedCube"
unselected.data.materials.append(bpy.data.materials["UnselectedMetal"])
export_dir = tempfile.mkdtemp(prefix="shading-review-")
export_result = export_asset.handle_export(
    {"format": "glb", "objects": ["ReviewCube"], "name": "review", "outputDir": export_dir},
    lambda _request: None,
)
checks["export names the lost procedural material"] = "ReviewMetal" in export_result["proceduralMaterials"]
checks["export ignores materials outside the selection"] = "UnselectedMetal" not in export_result["proceduralMaterials"]
checks["export warns instead of claiming the graph survived"] = any(
    "procedural" in warning and "ReviewMetal" in warning for warning in export_result["warnings"]
)

all_ok = all(checks.values())
print(json.dumps({"ok": all_ok, "checks": checks}))
if not all_ok:
    raise SystemExit(1)
print("PASS: shading snippets")
