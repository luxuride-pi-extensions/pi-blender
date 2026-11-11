---
name: blender-shade
description: Build deterministic procedural materials from a recipe, inspect what a material graph actually contains, and know what survives export.
---

# Blender Shade

Use this skill when the request is about how a surface looks — brushed metal,
glazed ceramic, painted wood, marble, fabric, emissive trim — rather than its
shape. Shading is written as a recipe, not clicked in the node editor: the same
recipe must rebuild the same graph, or the module digest stops meaning
anything.

The manager still never writes module code. Put the surface intent in the
worker's brief (preset, colour, roughness/metallic, pattern, scale, bump) and
let `blender-worker` author `modules/<name>/script.py`.

## Workflow

1. Inspect with `blender_scene_info` (`materials`, plus `uv` when the part will
   receive an image texture). A material's `graphDigest`, `procedural` and
   `uvDependent` tell you whether the current surface is already a graph and
   whether it needs texture coordinates.
2. Brief the worker to build the material with `build_material`, not by editing
   node sockets one at a time. Recipes are validated: an unknown preset, texture
   kind, target or coordinate space raises a `ValueError` naming the field.
3. Stage the module (`blender_branch_run`), then critic and loop as usual
   (`blender-modules`). The worker reports `graphDigest` and `nodeCount`; the
   critic judges the render.
4. Before delivery, check `procedural`. glTF and glb carry image textures, not
   procedural node graphs. A procedural material will arrive with only its
   Principled defaults, and `blender_export_asset` returns a warning naming it.
   Bake the graph to images before a glTF delivery.

## Recipe

```python
from shading import build_material

report = build_material("BrushedSteel", {
    "preset": "metal",                 # metal | dielectric | emission
    "baseColor": [0.55, 0.57, 0.60, 1.0],
    "roughness": 0.3,
    "coordinates": "Object",           # Object | Generated | UV
    "textures": [{
        "kind": "noise",               # noise | voronoi | brick | checker | wave | gradient
        "scale": 14.0,
        "detail": 4.0,
        "target": "roughness",         # base_color | roughness | metallic | emission | alpha
        "output": "fac",               # fac | color
        "ramp": {"stops": [
            {"position": 0.35, "color": [0.15, 0.15, 0.15, 1.0]},
            {"position": 0.80, "color": [0.60, 0.60, 0.60, 1.0]},
        ]},
    }],
    "bump": {"kind": "noise", "scale": 60.0, "strength": 0.15},
})
```

- `build_material` clears and rebuilds the material with that name. Re-running a
  module must produce the same `graphDigest`; that is what makes the material
  idempotent.
- Every node is named deterministically (`Texture0_Noise`, `Ramp0`, `Bump`),
  which keeps the digest stable across runs and Blender sessions.
- Textures share one `Mapping` node; `coordinates` chooses what drives it.
  `Generated` and `Object` do not need a UV layer; `UV` does. Pass `uvMap` when
  the mesh's active layer is not the one you mean; the default binds whatever
  the object has active.
- There are no random seeds: the noise/voronoi fields are inputs, so two runs
  with the same recipe cannot differ.
- Do not add `ShaderNodeTexImage` unless the image is already packed or on disk;
  a missing image exports as a material with no texture.

## Reading the report

`build_material` and `blender_scene_info` return the same material summary:

- `procedural` — any node glTF cannot carry (anything beyond Principled, image
  texture, normal map, mapping and coordinates). Bump nodes and colour ramps are
  not delivered either, so the flag is conservative: a bump-only material is
  reported procedural rather than silently flat;
- `uvDependent` — the graph reads image or UV data;
- `graphDigest` — SHA-256 over sorted node inputs and links; compare it, not the
  node count, when asking "is this the same material?";
- `baseColor`, `roughness`, `metallic`, `emissionStrength` — the Principled
  values, including the preset defaults.
