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

## Order: build → light → render → bake → export → verify

1. Build the material with `build_material` (or hand-author nodes).
2. Blueprint the scene with `apply_studio_rig(kind)` before rendering; the rig is
   deterministic, rebuilds the `Studio` collection's rig lights (including the
   bootstrap `StudioKey`/`StudioFill`/`StudioRim`) and scales energy, size and
   distance with the subject, so a prop and a 60 m set get the same exposure.
   Pass
   `film_transparent` and `world_strength` deliberately: a montage and an export
   preview want different answers, and `scene_info` reports both.
3. Render. The same blend order is what makes two modules comparable.
4. Bake procedural detail with `bake_textures(target, channels, resolution,
   samples, margin, output_dir)`. It refuses without UVs, sets `sRGB` for base
   colour/emission and `Non-Color` for roughness/metallic/AO/normal, packs every
   image and links it back into the material. A normal bake uses the
   `bake_normal` cage path instead. AO distance is 0.1× the target's largest
   dimension and is reported as `aoDistance`. A rig replaces a linked HDRI;
   read the returned `world.replacedEnvironment`/`world.previousStrength`
   before accepting that change on a `sourceBlend` workspace.
5. Export `glb`. The exporter verifies the JSON chunk contains `images` and
   `textures`; a material that samples an image but exports without one fails
   the tool rather than arriving flat.
6. Read `scene_info` (`lights`, `renderSettings`, `textures`) to confirm colour
   space, packed state, film transparency, view transform and exposure.

glTF carries images and factors, never node graphs. A procedural material that
is not baked will arrive with Principled defaults; `blender_export_asset`
reports it as `proceduralMaterials` with a warning, and `blender_scene_info`
reports every image's colour space and packed state.
