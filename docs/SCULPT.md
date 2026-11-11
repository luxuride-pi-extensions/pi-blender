# Sculpt detail: normal-map bake

A sculpt exported as-is is a high-poly mesh; glTF has no multires level. Bake
the surface into a normal map on a low-poly cage before export:

```python
import os
from bake import bake_normal

report = bake_normal(
    low=bpy.data.objects["HandleCage"],
    high=bpy.data.objects["HandleSculpt"],
    output_path=os.path.join(WORKSPACE_PATH, "bakes", "handle_normal.png"),
    resolution=1024,   # keep 512–1024 for a runtime asset
    samples=32,
)
print(report)
```

The helper adds a UV layer to the cage when it has none, creates/reuses a
material with a `BakeTarget` image node, links the result through a Normal Map
node into the Principled BSDF, writes and packs the PNG, and returns
`{imagePath, imageName, materialName, resolution, samples, elapsedSeconds,
lowTriangles, highTriangles, triangleReduction, uvCreated, cageExtrusion, margin}`.
It restores the scene's previous engine, sample count, bake settings and
selection on success and on failure.

Cost is a render, not a stroke: 2048² with 64 samples can outlast the module
budget. Start at 512²/16 samples to prove the cage, then raise. A failure names
the resolution and samples it used, because the first question is always what it
was asked to do. `blender_export_asset {format: "glb"}` on the cage then embeds
the packed image.
