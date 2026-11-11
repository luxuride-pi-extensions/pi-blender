"""Deterministic, data-driven sculpt strokes for module scripts.

Interactive brush strokes cannot be replayed: `bpy.ops.sculpt.brush_stroke`
depends on a viewport, a brush cursor and a depsgraph state, so the same call
twice does not produce the same mesh, and the content digest in
`fingerprint.py` becomes meaningless. These helpers are pure `bmesh` and
`mathutils` math over a stroke table, so an identical table produces identical
vertex positions on every machine, headless, with no window.

Import from a module script (Blender puts the assets dir on `sys.path`):

    from sculpt import apply_strokes
    apply_strokes(bpy.context.object, [
        {"op": "displace", "center": [0, 0, 1], "radius": 0.4, "strength": 0.08},
        {"op": "flatten", "center": [0, 0, 1], "radius": 0.4, "strength": 0.5},
        {"op": "mirror", "axis": "x"},
    ])

Coordinates are object-local. A stroke without `center` uses the mesh bounding
-box centre, which makes a table independent of the object's world transform.
"""

import bmesh  # pyright: ignore[reportMissingImports]
from mathutils import Vector  # pyright: ignore[reportMissingImports]
from mathutils.kdtree import KDTree  # pyright: ignore[reportMissingImports]


def _smoothstep(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def _falloff(distance, radius):
    if radius <= 0:
        return 1.0 if distance == 0 else 0.0
    return 1.0 - _smoothstep(distance / radius)


def _center(bm, stroke):
    if "center" in stroke:
        return Vector(stroke["center"])
    low = Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))
    high = Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))
    return (low + high) * 0.5


def _displace(bm, stroke):
    center = _center(bm, stroke)
    radius = float(stroke.get("radius", 1.0))
    strength = float(stroke.get("strength", 0.1))
    direction = Vector(stroke["direction"]) if "direction" in stroke else None
    bm.normal_update()
    for vert in bm.verts:
        weight = _falloff((vert.co - center).length, radius)
        if weight == 0:
            continue
        normal = vert.normal if direction is None else direction
        vert.co += normal * (strength * weight)


def _grab(bm, stroke):
    center = _center(bm, stroke)
    radius = float(stroke.get("radius", 1.0))
    strength = float(stroke.get("strength", 0.1))
    offset = Vector(stroke.get("offset", [0, 0, 0]))
    for vert in bm.verts:
        vert.co += offset * (strength * _falloff((vert.co - center).length, radius))


def _crease(bm, stroke, pinch=False):
    center = _center(bm, stroke)
    radius = float(stroke.get("radius", 1.0))
    strength = float(stroke.get("strength", 0.1))
    axis = Vector(stroke.get("axis", [0, 0, 1]))
    axis.normalize()
    bm.normal_update()
    for vert in bm.verts:
        delta = vert.co - center
        weight = _falloff(delta.length, radius)
        if weight == 0:
            continue
        normal = vert.normal * (strength * weight)
        tangential = delta - axis * delta.dot(axis)
        if tangential.length > 1e-9:
            normal -= tangential.normalized() * (strength * weight * (0.5 if pinch else 0.15))
        vert.co += normal


def _flatten(bm, stroke):
    center = _center(bm, stroke)
    radius = float(stroke.get("radius", 1.0))
    strength = float(stroke.get("strength", 0.5))
    normal = Vector(stroke.get("normal", [0, 0, 1])).normalized()
    bm.normal_update()
    for vert in bm.verts:
        weight = _falloff((vert.co - center).length, radius)
        if weight == 0:
            continue
        distance = (vert.co - center).dot(normal)
        vert.co -= normal * (distance * strength * weight)


def _smooth(bm, stroke):
    center = _center(bm, stroke)
    radius = float(stroke.get("radius", 1.0))
    strength = float(stroke.get("strength", 0.5))
    iterations = int(stroke.get("iterations", 1))
    for _ in range(max(0, iterations)):
        averaged = {}
        for vert in bm.verts:
            weight = _falloff((vert.co - center).length, radius)
            if weight == 0 or not vert.link_edges:
                continue
            neighbour = Vector((0, 0, 0))
            for edge in vert.link_edges:
                other = edge.other_vert(vert)
                neighbour += other.co
            neighbour /= len(vert.link_edges)
            averaged[vert] = vert.co.lerp(neighbour, strength * weight)
        for vert, position in averaged.items():
            vert.co = position


def _mirror(bm, stroke):
    axis = str(stroke.get("axis", "x")).lower()
    index = {"x": 0, "y": 1, "z": 2}[axis]
    tolerance = float(stroke.get("tolerance", 1e-5))
    candidates = [vert for vert in bm.verts if abs(vert.co[index]) > tolerance]
    if not candidates:
        return
    tree = KDTree(len(candidates))
    for position, vert in enumerate(candidates):
        tree.insert(vert.co, position)
    tree.balance()
    # Averaging with the partner's raw position would pull both sides onto the
    # mirror plane. The partner is mirrored into this side first, and every
    # write is deferred so later pairs still see the original surface.
    averaged = {}
    for vert in candidates:
        query = vert.co.copy()
        query[index] = -query[index]
        _, position, distance = tree.find(query)
        if distance > tolerance * 10:
            continue
        partner = candidates[position].co.copy()
        partner[index] = -partner[index]
        averaged[vert] = (vert.co + partner) * 0.5
    for vert, position in averaged.items():
        vert.co = position


_OPS = {
    "displace": _displace,
    "inflate": _displace,
    "grab": _grab,
    "crease": _crease,
    "pinch": lambda bm, stroke: _crease(bm, stroke, pinch=True),
    "flatten": _flatten,
    "smooth": _smooth,
    "smooth_laplacian": _smooth,
    "mirror": _mirror,
}


def apply_strokes(obj, strokes):
    """Apply a stroke table to `obj.data` in place and return a small report.

    The mesh is written back once with `bm.to_mesh`, not vertex by vertex, and
    normals are recomputed before the caller fingerprints it.
    """
    if obj is None or obj.type != "MESH":
        raise ValueError("sculpt strokes need a mesh object")
    if obj.mode != "OBJECT":
        raise ValueError("sculpt strokes need object mode; switch out of edit or sculpt first")
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    try:
        for stroke in strokes:
            op = str(stroke.get("op", ""))
            if op not in _OPS:
                raise ValueError(f"unknown sculpt stroke {op!r}; known: {', '.join(sorted(_OPS))}")
            _OPS[op](bm, stroke)
        bm.normal_update()
        bm.to_mesh(obj.data)
    finally:
        bm.free()
    obj.data.update()
    return {"strokes": len(strokes), "vertices": len(obj.data.vertices), "polygons": len(obj.data.polygons)}
