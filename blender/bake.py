"""Bake sculpted detail into a normal map the low-poly export can carry.

A sculpt exported as-is is a multi-million-triangle mesh no runtime wants, and
a decimated mesh has lost the polish. A normal-map bake is the step between:
the cage keeps its cheap topology, the image carries the surface. This is a
render-device operation, not a bmesh one -- Cycles needs UVs, a bake target
image and selected-to-active -- so it lives beside the render helpers.
"""

import os
import time

# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]


def _triangle_count(obj):
    if obj.type != "MESH":
        return 0
    return sum(max(0, len(poly.vertices) - 2) for poly in obj.data.polygons)


def _ensure_uv(obj):
    if obj.data.uv_layers:
        return False
    bpy.context.view_layer.objects.active = obj
    for other in bpy.context.selected_objects:
        other.select_set(False)
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project()
    bpy.ops.object.mode_set(mode="OBJECT")
    return True


def _bake_target(low, image_name, resolution):
    material = low.data.materials[0] if low.data.materials else None
    if material is None:
        material = bpy.data.materials.new(f"{low.name}_baked")
        material.use_nodes = True
        low.data.materials.append(material)
    if not material.use_nodes:
        material.use_nodes = True
    nodes = material.node_tree.nodes
    target = nodes.get("BakeTarget")
    if target is None:
        target = nodes.new("ShaderNodeTexImage")
        target.name = "BakeTarget"
        target.location = (-420, 320)
    image = bpy.data.images.get(image_name)
    if image is not None:
        bpy.data.images.remove(image)
    image = bpy.data.images.new(image_name, width=resolution, height=resolution, alpha=False)
    image.colorspace_settings.name = "Non-Color"
    target.image = image
    nodes.active = target

    # The bake writes the pixels; without this link the exported material still
    # has a flat normal and the detail exists only in the image.
    normal_map = nodes.get("BakedNormalMap")
    if normal_map is None:
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.name = "BakedNormalMap"
    bsdf = next((node for node in nodes if node.type == "BSDF_PRINCIPLED"), None)
    if bsdf is not None:
        material.node_tree.links.new(normal_map.outputs["Normal"], bsdf.inputs["Normal"])
    material.node_tree.links.new(target.outputs["Color"], normal_map.inputs["Color"])
    return material, image


def bake_normal(
    low,
    high,
    output_path,
    resolution=1024,
    samples=64,
    cage_extrusion=None,
    margin=16,
):
    """Bake `high`'s surface into a normal map on `low`.

    Returns the measurements a critic needs: face counts on both sides, the
    actual resolution and sample count, and how long it took. Raises with those
    same numbers in the message, because the common failure is a bake that ran
    past the caller's budget and the first question is what it was asked to do.
    """
    if low is None or high is None:
        raise ValueError("bake_normal needs both a low-poly cage and a high-poly source")
    if low.type != "MESH" or high.type != "MESH":
        raise ValueError(f"bake_normal needs meshes; got {low.type} and {high.type}")
    if resolution < 16 or resolution > 8192:
        raise ValueError(f"resolution {resolution} is outside 16..8192")
    if samples < 1 or samples > 4096:
        raise ValueError(f"samples {samples} is outside 1..4096")

    output_path = os.path.abspath(output_path)
    try:
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
    except OSError as error:
        raise RuntimeError(f"Cannot create the bake output directory for {output_path}: {error}") from error
    low_triangles = _triangle_count(low)
    high_triangles = _triangle_count(high)
    created_uv = _ensure_uv(low)
    material, image = _bake_target(low, f"{low.name}_normal", resolution)

    scene = bpy.context.scene
    previous_engine = scene.render.engine
    previous_samples = getattr(scene.cycles, "samples", None)
    previous_device = getattr(scene.cycles, "device", None)
    bake = scene.render.bake
    previous_bake = {
        "use_selected_to_active": bake.use_selected_to_active,
        "cage_extrusion": bake.cage_extrusion,
        "margin": bake.margin,
    }

    for other in bpy.context.selected_objects:
        other.select_set(False)
    low.select_set(True)
    high.select_set(True)
    bpy.context.view_layer.objects.active = low
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    bake.use_selected_to_active = True
    used_cage = cage_extrusion if cage_extrusion is not None else max(0.001, low.dimensions.length * 0.02)
    bake.cage_extrusion = used_cage
    bake.margin = margin

    started = time.monotonic()
    try:
        bpy.ops.object.bake(type="NORMAL")
    except RuntimeError as error:
        raise RuntimeError(
            f"Normal bake failed at {resolution}x{resolution} with {samples} samples "
            f"({low_triangles} -> {high_triangles} triangles): {error}. "
            "Lower resolution or samples, or widen cage_extrusion."
        ) from error
    elapsed = time.monotonic() - started

    image.filepath_raw = output_path
    image.file_format = "PNG"
    image.save()
    image.pack()

    try:
        scene.render.engine = previous_engine
        if previous_samples is not None:
            scene.cycles.samples = previous_samples
        if previous_device is not None:
            scene.cycles.device = previous_device
        bake.use_selected_to_active = previous_bake["use_selected_to_active"]
        bake.cage_extrusion = previous_bake["cage_extrusion"]
        bake.margin = previous_bake["margin"]
    except (AttributeError, TypeError):
        # A build without Cycles leaves nothing to restore; the bake itself
        # already failed above if that mattered.
        pass

    return {
        "imagePath": output_path,
        "imageName": image.name,
        "materialName": material.name,
        "resolution": resolution,
        "samples": samples,
        "elapsedSeconds": round(elapsed, 2),
        "lowTriangles": low_triangles,
        "highTriangles": high_triangles,
        "triangleReduction": (
            round(1.0 - low_triangles / high_triangles, 4) if high_triangles else 0.0
        ),
        "uvCreated": created_uv,
        "cageExtrusion": round(used_cage, 5),
        "margin": margin,
    }
