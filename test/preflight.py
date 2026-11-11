"""Real-Blender fixtures for the deterministic preflight checks.

Run by test/blender-probes.test.mjs (needs `import bpy` and a PASS line).
"""

import os
import sys
import time

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender)
import bmesh  # pyright: ignore[reportMissingImports]
import bpy  # pyright: ignore[reportMissingImports]

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from blender.validation import validate  # noqa: E402


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def cube(name="Cube", size=2.0, location=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location)
    obj = bpy.context.object
    obj.name = name
    return obj


def open_cube():
    reset()
    obj = cube()
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.faces[0]], context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    return obj


def main():
    checks = {}

    obj = open_cube()
    verdict = validate(bpy, [obj.name], profile="print")
    checks["open boundary is blocking"] = (
        verdict["checks"]["nonManifold"]["value"]["boundaryEdges"] > 0
        and "nonManifold" in verdict["blockers"]
    )

    reset()
    first = cube("First")
    second = cube("Second", location=(0.6, 0, 0))
    verdict = validate(bpy, [first.name, second.name], profile="print")
    checks["interpenetration is counted"] = (
        verdict["checks"]["selfIntersections"]["value"]["pairs"] > 0
        and "selfIntersections" in verdict["blockers"]
    )

    reset()
    first = cube("First")
    second = cube("Second", location=(0.6, 0, 0))
    verdict = validate(bpy, [first.name, second.name], profile="hard_surface")
    checks["hard surface blocks interpenetration"] = "selfIntersections" in verdict["blockers"]

    reset()
    first = cube("First")
    second = cube("Second")
    verdict = validate(bpy, [first.name, second.name], profile="print")
    checks["coincident duplicates are counted"] = (
        verdict["checks"]["selfIntersections"]["value"]["pairs"] > 0
    )

    reset()
    first = cube("First")
    second = cube("Second", location=(2.0, 0, 0))
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = first
    bpy.ops.object.join()
    verdict = validate(bpy, [first.name], profile="print")
    checks["a joined pair of touching shells is not a fold"] = (
        verdict["checks"]["selfIntersections"]["value"]["pairs"] == 0
    )

    reset()
    first = cube("First")
    second = cube("Second", location=(0.6, 0, 0))
    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = first
    bpy.ops.object.join()
    verdict = validate(bpy, [first.name], profile="print")
    checks["a joined interpenetration is a fold"] = (
        verdict["checks"]["selfIntersections"]["value"]["pairs"] > 0
    )

    reset()
    obj = cube()
    obj.scale = (0.5, 0.5, 0.5)
    verdict = validate(bpy, [obj.name], profile="prop")
    checks["unapplied scale is reported"] = (
        verdict["checks"]["unappliedScale"]["value"][0]["scale"] == [0.5, 0.5, 0.5]
        and "unappliedScale" not in verdict["blockers"]
        and "unappliedScale" in verdict["warnings"]
    )

    reset()
    first = cube("First")
    second = cube("Second", location=(2.0, 0, 0))
    verdict = validate(bpy, [first.name, second.name], profile="print")
    checks["touching faces are not an interpenetration"] = (
        verdict["checks"]["selfIntersections"]["value"]["pairs"] == 0
    )

    reset()
    obj = cube()
    obj.scale = (0.2, 0.2, 0.0002)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    verdict = validate(bpy, [obj.name], profile="print")
    thickness = verdict["checks"]["wallThickness"]["value"]["distance"]
    checks["thin wall is measured"] = (
        thickness is not None and 0.0003 < thickness < 0.0005 and "wallThickness" in verdict["blockers"]
    )

    reset()
    obj = cube()
    obj.scale = (1.0, 1.0, 0.2)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.context.scene.unit_settings.scale_length = 0.001
    verdict = validate(bpy, [obj.name], profile="print")
    thickness = verdict["checks"]["wallThickness"]["value"]["distance"]
    checks["millimetre scenes compare against metres"] = (
        thickness is not None and 0.0003 < thickness < 0.0005 and "wallThickness" in verdict["blockers"]
    )
    bpy.context.scene.unit_settings.scale_length = 1.0

    reset()
    bpy.ops.mesh.primitive_plane_add(size=2)
    panel = bpy.context.object
    verdict = validate(bpy, [panel.name], profile="paint")
    checks["a flat subject is not an empty scene"] = verdict["blocking"] is False
    printed = validate(bpy, [panel.name], profile="print")
    checks["an unmeasurable wall is a warning, not a pass"] = (
        printed["checks"]["wallThickness"]["status"] == "warn"
    )

    reset()
    bpy.ops.mesh.primitive_plane_add(size=2)
    shell = bpy.context.object
    solidify = shell.modifiers.new("Wall", "SOLIDIFY")
    solidify.thickness = 0.0005
    verdict = validate(bpy, [shell.name], profile="print")
    checks["a modifier wall is measured"] = (
        verdict["checks"]["wallThickness"]["value"]["distance"] is not None
        and verdict["checks"]["wallThickness"]["value"]["distance"] < 0.0008
    )

    reset()
    obj = cube()
    while obj.data.uv_layers:
        obj.data.uv_layers.remove(obj.data.uv_layers[0])
    verdict = validate(bpy, [obj.name], profile="paint")
    checks["missing UV is blocking for paint"] = "uv" in verdict["blockers"]

    reset()
    obj = cube()
    verdict = validate(bpy, [obj.name], profile="prop")
    checks["a clean cube is not blocking"] = verdict["blocking"] is False
    checks["digest subject can be the clean cube"] = verdict["checks"]["empty"]["status"] == "ok"

    # A heavy grid must stay bounded: the scan is skipped, not attempted.
    reset()
    bpy.ops.mesh.primitive_grid_add(x_subdivisions=320, y_subdivisions=320, size=2)
    heavy = bpy.context.object
    started = time.time()
    verdict = validate(bpy, [heavy.name], profile="prop")
    elapsed = time.time() - started
    checks["a heavy mesh is bounded"] = (
        verdict["checks"]["selfIntersections"]["status"] == "warn"
        and "exceeds" in str(verdict["checks"]["selfIntersections"].get("reason"))
        and elapsed < 20
    )

    for name, passed in checks.items():
        print(f"{'ok' if passed else 'FAIL'}: {name}")
    if not all(checks.values()):
        raise SystemExit(1)
    print("PASS: deterministic preflight")


if __name__ == "__main__":
    main()
