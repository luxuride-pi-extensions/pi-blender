"""One deterministic density pass before and after sculpt strokes.

A falloff stroke only moves vertices that exist: a six-face cube has nowhere to
round a shoulder. This module derives a resolution from the strokes' own radius,
subdivides to it, optionally voxel-remeshes, and optionally decimates to a face
budget. Everything is applied geometry, not a live modifier stack, because an
unapplied subdivision makes the exported mesh differ from the rendered one.

    from sculpt_topology import ensure_density
    report = ensure_density(obj, strokes, max_faces=200_000, voxel_size=0.01,
                            decimate_to=40_000)
"""

import math

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender)
import bmesh  # pyright: ignore[reportMissingImports]
import bpy  # pyright: ignore[reportMissingImports]


def _apply_modifier(obj, modifier):
    if obj.mode != "OBJECT":
        raise ValueError("density pass needs object mode; switch out of edit or sculpt first")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    baked = bpy.data.meshes.new_from_object(evaluated)
    previous = obj.data
    obj.data = baked
    obj.modifiers.remove(modifier)
    if previous.users == 0:
        bpy.data.meshes.remove(previous)


def _median_edge(obj):
    vertices = obj.data.vertices
    lengths = sorted(
        (vertices[edge.vertices[0]].co - vertices[edge.vertices[1]].co).length for edge in obj.data.edges
    )
    lengths = [length for length in lengths if length > 0]
    if not lengths:
        return 0.0
    return lengths[len(lengths) // 2]


def _subdivide(obj, cuts):
    if cuts <= 0:
        return
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        bmesh.ops.subdivide_edges(bm, edges=bm.edges[:], cuts=cuts, use_grid_fill=True)
        bm.to_mesh(obj.data)
    finally:
        bm.free()
    obj.data.update()


def ensure_density(obj, strokes, *, max_faces=500_000, subdivide="auto", voxel_size=None, decimate_to=None):
    """Densify before a stroke table and reduce afterwards, inside the cap.

    Returns the before/after counts, whether UV data survived, whether the cap
    clamped the request, and a reason a caller can put in front of a critic.
    """
    if obj is None or obj.type != "MESH":
        raise ValueError("density pass needs a mesh object")
    before = {"vertices": len(obj.data.vertices), "faces": len(obj.data.polygons)}
    had_uvs = len(obj.data.uv_layers) > 0
    reasons = []
    clamped = False

    radius = max((float(stroke.get("radius", 0.0)) for stroke in strokes), default=0.0)
    target_edge = radius / 6.0 if radius > 0 else 0.0
    edge = _median_edge(obj)
    cuts = 0
    if subdivide == "auto" and target_edge > 0 and edge > 0 and edge > target_edge:
        # subdivide_edges(cuts=n) splits every edge into n+1 segments.
        cuts = min(6, max(0, int(math.ceil(edge / target_edge)) - 1))
    elif isinstance(subdivide, int):
        cuts = max(0, subdivide)

    projected = before["faces"] * (cuts + 1) ** 2
    if projected > max_faces:
        # Clamp to the largest cut count that stays inside the cap. A refusal
        # would leave a primitive too coarse to sculpt; a silent overshoot
        # would spend every later stage on geometry the caller never asked for.
        while cuts > 0 and before["faces"] * (cuts + 1) ** 2 > max_faces:
            cuts -= 1
        clamped = True
        reasons.append(
            f"subdivision clamped to {cuts} cut(s): {projected} faces would exceed the {max_faces} face cap"
        )
    _subdivide(obj, cuts)

    uv_survived = had_uvs and len(obj.data.uv_layers) > 0
    if voxel_size is not None:
        remesh = obj.modifiers.new(name="sculpt-density-remesh", type="REMESH")
        remesh.mode = "VOXEL"
        remesh.voxel_size = float(voxel_size)
        remesh.use_smooth_shade = False
        _apply_modifier(obj, remesh)
        reasons.append("voxel remesh replaced the mesh; UV coordinates do not survive it")
        uv_survived = False

    if decimate_to is not None:
        # A ratio is not an exact face count: decimation counts triangles while
        # the target is faces, so one pass can land above it. Extra passes are
        # bounded and still deterministic; the result is reported, not assumed.
        for _ in range(3):
            if len(obj.data.polygons) <= int(decimate_to):
                break
            ratio = max(0.01, min(1.0, float(decimate_to) / max(1, len(obj.data.polygons)) * 0.95))
            decimate = obj.modifiers.new(name="sculpt-density-decimate", type="DECIMATE")
            decimate.ratio = ratio
            _apply_modifier(obj, decimate)
            uv_survived = uv_survived and len(obj.data.uv_layers) > 0
        reasons.append(f"decimated to {len(obj.data.polygons)} faces against a {int(decimate_to)} face target")

    after = {"vertices": len(obj.data.vertices), "faces": len(obj.data.polygons)}
    if after["faces"] > max_faces:
        raise ValueError(
            f"density pass produced {after['faces']} faces, above the {max_faces} cap; "
            "lower voxel_size resolution or pass decimate_to"
        )
    return {
        "before": before,
        "after": after,
        "cuts": cuts,
        "hadUvs": had_uvs,
        "uvsSurvived": uv_survived,
        "clamped": clamped,
        "reasons": reasons,
    }
