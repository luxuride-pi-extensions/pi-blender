"""
Import an external asset into the open workspace blend.

Supports obj, stl, gltf/glb, and probes fbx capability.
Provides checkpoint-safe ingress, path traversal guards, asset name sanitization,
and post-import reporting of non-uniform scale and principal axes.
"""

import math
import os
import re

# Provided by Blender's own runtime, not by anything installed here.
# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]

try:
    # pi-lens-ignore: ast-grep:unresolved-import-python
    from mathutils import Matrix, Vector  # pyright: ignore[reportMissingImports]
except ImportError:
    Matrix = None
    Vector = None


SUPPORTED_FORMATS = ("obj", "stl", "gltf", "glb", "fbx")


def _probe_format_and_addon(fmt):
    """Probe whether the requested format and its operator/add-on are available.

    Returns (is_available, status_string, error_message).
    """
    if fmt not in SUPPORTED_FORMATS:
        return (
            False,
            "unsupported_format",
            f'Unsupported import format "{fmt}". Supported: {", ".join(SUPPORTED_FORMATS)}.',
        )

    if fmt == "fbx":
        has_fbx = hasattr(bpy.ops, "import_scene") and hasattr(bpy.ops.import_scene, "fbx")
        if not has_fbx:
            return (
                False,
                "missing_addon",
                "FBX import operator is not available in this Blender installation (io_scene_fbx add-on is missing or disabled).",
            )
        return (True, None, None)

    if fmt == "obj":
        has_obj = hasattr(bpy.ops.wm, "obj_import") or (
            hasattr(bpy.ops, "import_scene") and hasattr(bpy.ops.import_scene, "obj")
        )
        if not has_obj:
            return (
                False,
                "missing_addon",
                "OBJ import operator is not available in this Blender installation.",
            )
        return (True, None, None)

    if fmt == "stl":
        has_stl = hasattr(bpy.ops.wm, "stl_import") or (
            hasattr(bpy.ops, "import_mesh") and hasattr(bpy.ops.import_mesh, "stl")
        )
        if not has_stl:
            return (
                False,
                "missing_addon",
                "STL import operator is not available in this Blender installation.",
            )
        return (True, None, None)

    if fmt in ("gltf", "glb"):
        has_gltf = hasattr(bpy.ops, "import_scene") and hasattr(bpy.ops.import_scene, "gltf")
        if not has_gltf:
            return (
                False,
                "missing_addon",
                "glTF/GLB import operator (bpy.ops.import_scene.gltf) is not available in this Blender installation.",
            )
        return (True, None, None)

    return (True, None, None)


def _run_import(fmt, filepath):
    """Dispatch to whichever operator this format needs."""
    if fmt in ("glb", "gltf"):
        return bpy.ops.import_scene.gltf(filepath=filepath)

    if fmt == "obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            return bpy.ops.wm.obj_import(filepath=filepath)
        return bpy.ops.import_scene.obj(filepath=filepath)

    if fmt == "stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            return bpy.ops.wm.stl_import(filepath=filepath)
        return bpy.ops.import_mesh.stl(filepath=filepath)

    if fmt == "fbx":
        return bpy.ops.import_scene.fbx(filepath=filepath)

    raise ValueError(f"Unknown format {fmt}")


def compute_principal_axes(obj):
    """Compute principal axes from vertex coordinates of a mesh object."""
    if obj.type != "MESH" or not hasattr(obj.data, "vertices") or len(obj.data.vertices) < 3 or Vector is None:
        return {
            "available": False,
            "reason": "Object is not a mesh or has fewer than 3 vertices",
        }

    vertices = obj.data.vertices
    count = len(vertices)
    limit = 2000
    stride = max(1, count // limit)
    points = [obj.matrix_world @ v.co for v in vertices[::stride]]
    if len(points) < 3:
        return {"available": False, "reason": "Fewer than 3 sampled vertices"}

    n = len(points)
    center = Vector((
        sum(p.x for p in points) / n,
        sum(p.y for p in points) / n,
        sum(p.z for p in points) / n,
    ))
    centered = [p - center for p in points]

    cov = [
        [sum(p[i] * p[j] for p in centered) / n for j in range(3)]
        for i in range(3)
    ]

    v1 = Vector((1.0, 0.0, 0.0))
    for _ in range(64):
        pv = Vector((
            cov[0][0] * v1.x + cov[0][1] * v1.y + cov[0][2] * v1.z,
            cov[1][0] * v1.x + cov[1][1] * v1.y + cov[1][2] * v1.z,
            cov[2][0] * v1.x + cov[2][1] * v1.y + cov[2][2] * v1.z,
        ))
        if pv.length < 1e-12:
            pv = Vector((0.0, 1.0, 0.0))
        v1 = pv.normalized()

    temp = Vector((0.0, 1.0, 0.0)) if abs(v1.dot(Vector((0.0, 1.0, 0.0)))) < 0.9 else Vector((0.0, 0.0, 1.0))
    v2_proj = temp - (temp.dot(v1) * v1)
    v2 = v2_proj.normalized()

    for _ in range(32):
        pv = Vector((
            cov[0][0] * v2.x + cov[0][1] * v2.y + cov[0][2] * v2.z,
            cov[1][0] * v2.x + cov[1][1] * v2.y + cov[1][2] * v2.z,
            cov[2][0] * v2.x + cov[2][1] * v2.y + cov[2][2] * v2.z,
        ))
        pv = pv - (pv.dot(v1) * v1)
        if pv.length < 1e-12:
            break
        v2 = pv.normalized()

    v3 = v1.cross(v2).normalized()

    def variance(axis):
        p_axis = Vector((
            cov[0][0] * axis.x + cov[0][1] * axis.y + cov[0][2] * axis.z,
            cov[1][0] * axis.x + cov[1][1] * axis.y + cov[1][2] * axis.z,
            cov[2][0] * axis.x + cov[2][1] * axis.y + cov[2][2] * axis.z,
        ))
        return max(0.0, float(p_axis.dot(axis)))

    axes_data = sorted([
        ("primary", v1, variance(v1)),
        ("secondary", v2, variance(v2)),
        ("tertiary", v3, variance(v3)),
    ], key=lambda x: x[2], reverse=True)

    return {
        "available": True,
        "center": [round(float(c), 4) for c in center],
        "primaryAxis": [round(float(c), 4) for c in axes_data[0][1]],
        "secondaryAxis": [round(float(c), 4) for c in axes_data[1][1]],
        "tertiaryAxis": [round(float(c), 4) for c in axes_data[2][1]],
        "variances": [round(float(x[2]), 6) for x in axes_data],
        "extents": [round(float(math.sqrt(x[2])), 4) for x in axes_data],
    }


def _build_post_import_report(imported_objects):
    """Generate report on scale uniformity and principal axes for imported objects."""
    objects_report = {}
    non_uniform_objects = []

    for obj in imported_objects:
        matrix = obj.matrix_world
        basis = matrix.to_3x3()
        world_col_scales = [basis.col[i].length for i in range(3)]
        local_scale = [float(s) for s in obj.scale]

        # Non-uniform if either local or world scale shows variation across axes
        local_diff = max(local_scale) - min(local_scale)
        world_diff = max(world_col_scales) - min(world_col_scales)
        is_non_uniform = (local_diff > 1e-4) or (world_diff > 1e-4)

        if is_non_uniform:
            non_uniform_objects.append(obj.name)

        dimensions = [round(float(d), 4) for d in obj.dimensions]
        axes_info = compute_principal_axes(obj)

        objects_report[obj.name] = {
            "name": obj.name,
            "scale": [round(float(s), 4) for s in local_scale],
            "worldScale": [round(float(s), 4) for s in world_col_scales],
            "isNonUniform": is_non_uniform,
            "dimensions": dimensions,
            "principalAxes": axes_info,
        }

    return {
        "hasNonUniformScale": len(non_uniform_objects) > 0,
        "nonUniformScaleObjects": non_uniform_objects,
        "objects": objects_report,
    }


def handle_import(request, open_blend):
    """Import an external 3D asset into the workspace blend.

    Saves the mutated blend back to disk upon successful import.
    Reports unsupported format or missing add-ons as explicit result objects.
    """
    open_blend(request)

    source_path = request.get("sourcePath")
    if not source_path or not os.path.exists(source_path):
        return {
            "success": False,
            "status": "file_not_found",
            "error": f"Source asset does not exist: {source_path}",
            "importedObjects": [],
        }

    fmt = str(request.get("format") or os.path.splitext(source_path)[1].lstrip(".")).lower()

    # Asset name sanitization
    raw_name = request.get("name") or os.path.splitext(os.path.basename(source_path))[0]
    asset_name = re.sub(r"^[./\\]+", "", str(raw_name))
    asset_name = re.sub(r"[./\\]+", "_", asset_name)
    asset_name = re.sub(r"[^A-Za-z0-9_-]", "_", asset_name)
    asset_name = re.sub(r"_{2,}", "_", asset_name).strip("._-") or "asset"

    # Capability probing
    supported, status, err = _probe_format_and_addon(fmt)
    if not supported:
        return {
            "success": False,
            "status": status,
            "format": fmt,
            "assetName": asset_name,
            "error": err,
            "importedObjects": [],
        }

    # Snapshot existing objects so we know which ones were added
    existing_names = set(bpy.data.objects.keys())

    try:
        _run_import(fmt, source_path)
    except Exception as error:
        return {
            "success": False,
            "status": "import_failed",
            "format": fmt,
            "assetName": asset_name,
            "error": f"Blender {fmt} import failed: {error}",
            "importedObjects": [],
        }

    new_objects = [obj for name, obj in bpy.data.objects.items() if name not in existing_names]
    if not new_objects:
        new_objects = list(bpy.context.selected_objects)

    imported_names = [obj.name for obj in new_objects]
    report = _build_post_import_report(new_objects)

    # Save mutated blend to disk
    bpy.ops.wm.save_mainfile()

    return {
        "success": True,
        "status": "imported",
        "format": fmt,
        "sourcePath": source_path,
        "assetName": asset_name,
        "blendPath": bpy.data.filepath or None,
        "importedObjects": imported_names,
        "report": report,
    }
