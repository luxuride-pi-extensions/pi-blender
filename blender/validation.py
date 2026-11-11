"""Deterministic structural checks for a module's geometry.

The vision critic is asked to judge a render, and a render can hide an open
surface, an interpenetration or a wall thinner than the material it imitates.
These checks answer those questions from geometry instead, before a critic
context is spent.

`bpy` is passed in rather than imported at module scope so the thresholds and
the verdict can be tested outside Blender. Every number states its method and
its sample, because a confident number from an unexplained sample is worse than
no number: the caller has to be able to decide whether to trust it.
"""

import math

# Profiles are the same names the camera plans use: one declared use case should
# not have to be repeated in two vocabularies.
PROFILES = (
    "prop",
    "character",
    "hard_surface",
    "interior",
    "print",
    "paint",
    "asset_pack",
)

MIN_WALL_METRES = {
    "print": 0.0008,
    "character": 0.002,
}

# A check is critical only where the profile makes the defect disqualifying. A
# one-sided prop back is a style choice; the same face on a print is a hole.
CRITICAL = {
    "prop": {"empty", "unappliedScale", "bounds"},
    "character": {"empty", "unappliedScale", "bounds", "nonManifold", "wallThickness"},
    "hard_surface": {"empty", "unappliedScale", "bounds", "selfIntersections"},
    "interior": {"empty", "unappliedScale", "bounds"},
    "print": {"empty", "unappliedScale", "bounds", "nonManifold", "selfIntersections", "wallThickness"},
    "paint": {"empty", "unappliedScale", "bounds", "uv"},
    "asset_pack": {"empty", "unappliedScale", "bounds"},
}

SELF_INTERSECTION_FACE_LIMIT = 60000


def _round(value, digits=5):
    return round(float(value), digits) if value is not None else None


def _check(status, value=None, method=None, limit=None, sampled=False, reason=None):
    result = {"status": status}
    if value is not None:
        result["value"] = value
    if method is not None:
        result["method"] = method
    if limit is not None:
        result["limit"] = limit
    if sampled:
        result["sampled"] = True
    if reason is not None:
        result["reason"] = reason
    return result


def _mesh_objects(bpy, objects):
    found = []
    for name in objects:
        obj = bpy.data.objects.get(name)
        if obj is not None and obj.type == "MESH" and obj.data is not None:
            found.append(obj)
    return found


def _evaluated(obj, depsgraph):
    """The mesh Blender actually evaluates, with modifiers and shape keys applied.

    Reading obj.data measures the base mesh, which is not what the user sees or
    exports: a Solidify wall or a Mirror seam lives in the modifier stack.
    """
    return obj.evaluated_get(depsgraph).to_mesh()


def _bounds(bpy, meshes, depsgraph):
    low = [math.inf, math.inf, math.inf]
    high = [-math.inf, -math.inf, -math.inf]
    measured = False
    for obj in meshes:
        mesh = _evaluated(obj, depsgraph)
        try:
            matrix = obj.matrix_world
            for vertex in mesh.vertices:
                world = matrix @ vertex.co
                for axis in range(3):
                    low[axis] = min(low[axis], world[axis])
                    high[axis] = max(high[axis], world[axis])
                measured = True
        finally:
            obj.evaluated_get(depsgraph).to_mesh_clear()
    dimensions = [high[axis] - low[axis] for axis in range(3)] if measured else [0.0, 0.0, 0.0]
    return {
        "min": [_round(value, 4) for value in low] if measured else None,
        "max": [_round(value, 4) for value in high] if measured else None,
        "dimensions": [_round(value, 4) for value in dimensions],
        "unitScale": _round(getattr(bpy.context.scene.unit_settings, "scale_length", 1.0), 4),
    }


def _unapplied_scale(meshes):
    offenders = []
    for obj in meshes:
        if any(abs(float(value) - 1.0) > 1e-4 for value in obj.scale):
            offenders.append({"object": obj.name, "scale": [_round(value, 4) for value in obj.scale]})
    return offenders


def _topology(bpy, meshes, depsgraph):
    # pi-lens-ignore: ast-grep:unresolved-import-python
    import bmesh  # pyright: ignore[reportMissingImports]

    non_manifold = 0
    boundary = 0
    faces = 0
    for obj in meshes:
        bm = bmesh.new()
        try:
            bm.from_mesh(_evaluated(obj, depsgraph))
            faces += len(bm.faces)
            non_manifold += sum(1 for edge in bm.edges if not edge.is_manifold)
            boundary += sum(1 for edge in bm.edges if len(edge.link_faces) == 1)
        finally:
            bm.free()
            obj.evaluated_get(depsgraph).to_mesh_clear()
    return {"nonManifoldEdges": non_manifold, "boundaryEdges": boundary, "faces": faces}


def _self_intersections(bpy, meshes, faces, depsgraph):
    if faces > SELF_INTERSECTION_FACE_LIMIT:
        return None, f"skipped: {faces} faces exceeds the {SELF_INTERSECTION_FACE_LIMIT}-face scan limit"
    from mathutils.bvhtree import BVHTree  # pyright: ignore[reportMissingImports]

    vertices = []
    triangles = []
    owners = []
    for obj in meshes:
        mesh = _evaluated(obj, depsgraph)
        try:
            offset = len(vertices)
            matrix = obj.matrix_world
            vertices.extend(matrix @ vertex.co for vertex in mesh.vertices)
            for polygon in mesh.polygons:
                corners = [offset + index for index in polygon.vertices]
                for index in range(1, len(corners) - 1):
                    triangles.append([corners[0], corners[index], corners[index + 1]])
                    owners.append(polygon.index)
        finally:
            obj.evaluated_get(depsgraph).to_mesh_clear()
    if not triangles:
        return {"pairs": 0, "adjacentPairs": 0}, None
    tree = BVHTree.FromPolygons(vertices, triangles, all_triangles=True, epsilon=1e-6)
    pairs = 0
    adjacent_checked = 0
    for first, second in tree.overlap(tree):
        if first >= second:
            continue
        adjacent_checked += 1
        if owners[first] == owners[second] or set(triangles[first]) & set(triangles[second]):
            continue
        pairs += 1
    return {"pairs": pairs, "adjacentPairs": adjacent_checked}, None


def _wall_thickness(bpy, meshes, depsgraph):
    # pi-lens-ignore: ast-grep:unresolved-import-python
    import bmesh  # pyright: ignore[reportMissingImports]
    from mathutils.bvhtree import BVHTree  # pyright: ignore[reportMissingImports]

    thinnest = None
    sampled_faces = 0
    open_faces = 0
    for obj in meshes:
        bm = bmesh.new()
        try:
            mesh = _evaluated(obj, depsgraph)
            bm.from_mesh(mesh)
            bm.transform(obj.matrix_world)
            bm.normal_update()
            bm.faces.ensure_lookup_table()
            if not bm.faces:
                continue
            tree = BVHTree.FromBMesh(bm)
            extent = max((obj.matrix_world @ vertex.co).length for vertex in mesh.vertices) if mesh.vertices else 1.0
            step = max(1, len(bm.faces) // 300)
            for index, face in enumerate(bm.faces):
                if index % step:
                    continue
                if any(len(edge.link_faces) == 1 for edge in face.edges):
                    open_faces += 1
                    continue
                sampled_faces += 1
                origin = face.calc_center_median() - face.normal * 1e-5
                hit = tree.ray_cast(origin, -face.normal, max(extent * 2.0, 1.0))
                if hit[0] is None or hit[3] is None:
                    open_faces += 1
                    continue
                distance = hit[3]
                if distance > 1e-7:
                    thinnest = distance if thinnest is None else min(thinnest, distance)
        finally:
            bm.free()
            obj.evaluated_get(depsgraph).to_mesh_clear()
    return {"distance": _round(thinnest), "sampledFaces": sampled_faces, "openFaces": open_faces}, None


def _symmetry(bpy, meshes, axis_name, depsgraph):
    # pi-lens-ignore: ast-grep:unresolved-import-python
    import bmesh  # pyright: ignore[reportMissingImports]
    from mathutils.kdtree import KDTree  # pyright: ignore[reportMissingImports]

    axis = {"x": 0, "y": 1, "z": 2}.get(axis_name, 0)
    verts = []
    for obj in meshes:
        bm = bmesh.new()
        try:
            bm.from_mesh(_evaluated(obj, depsgraph))
            matrix = obj.matrix_world
            verts.extend(matrix @ vert.co for vert in bm.verts)
        finally:
            bm.free()
            obj.evaluated_get(depsgraph).to_mesh_clear()
    if not verts:
        return {"rms": None, "max": None, "sampled": 0, "vertices": 0}, None
    # A KD-tree over a multi-million-vertex scene is itself the cost this guard
    # exists to bound, so measure the sampled set rather than every vertex.
    step = max(1, len(verts) // 20000)
    sampled_verts = verts[::step]
    verts = sampled_verts
    plane = (min(co[axis] for co in verts) + max(co[axis] for co in verts)) * 0.5
    tree = KDTree(len(verts))
    for index, co in enumerate(verts):
        tree.insert(co, index)
    tree.balance()
    step = max(1, len(verts) // 3000)
    total = 0.0
    worst = 0.0
    measured = 0
    for index in range(0, len(verts), step):
        co = verts[index].copy()
        co[axis] = 2.0 * plane - co[axis]
        _, _, distance = tree.find(co)
        if distance is None:
            continue
        total += distance * distance
        worst = max(worst, distance)
        measured += 1
    return {"rms": _round(math.sqrt(total / measured) if measured else 0.0), "max": _round(worst), "sampled": measured, "vertices": len(verts)}, None


def _uv(meshes, depsgraph):
    """UV data lives on the mesh, not the modifier result.

    An evaluated mesh can carry a generated UV layer the base data does not have,
    so measuring the modifier result here would report a UV-less asset as ready
    to paint.
    """
    missing = []
    for obj in meshes:
        layers = getattr(obj.data, "uv_layers", None)
        if not layers or len(layers) == 0:
            missing.append(obj.name)
    return missing


def _materials(bpy, meshes):
    procedural = []
    seen = set()
    for obj in meshes:
        for slot in obj.material_slots:
            material = slot.material
            if material is None or material.name in seen:
                continue
            seen.add(material.name)
            nodes = getattr(material, "node_tree", None)
            if nodes is None:
                continue
            if any(node.type not in {"OUTPUT_MATERIAL", "BSDF_PRINCIPLED", "TEX_IMAGE", "NORMAL_MAP", "UVMAP", "MAPPING"} for node in nodes.nodes):
                procedural.append(material.name)
    return procedural


def validate(bpy, objects, profile="prop", symmetry_axis="x"):
    """Return the preflight verdict for the objects a module wrote.

    `objects` are datablock names, because that is what ownership carries and
    what survives a reload. The caller decides whether a blocking verdict stops
    the critic; this function only measures and applies profile thresholds.
    """
    profile = str(profile or "prop")
    critical = CRITICAL.get(profile, CRITICAL["prop"])
    meshes = _mesh_objects(bpy, objects or [])
    depsgraph = bpy.context.evaluated_depsgraph_get()
    checks = {}
    blockers = []
    warnings = []

    def record(check_id, result, is_critical):
        checks[check_id] = result
        if result["status"] == "block":
            if is_critical:
                blockers.append(check_id)
            else:
                warnings.append(check_id)
        elif result["status"] in {"warn", "skipped"}:
            warnings.append(check_id)

    bounds = _bounds(bpy, meshes, depsgraph)
    flat = bool(meshes) and any(value <= 1e-6 for value in bounds["dimensions"])
    tiny = not meshes or all(value <= 1e-6 for value in bounds["dimensions"])
    record("bounds", _check("block" if tiny else "warn" if flat else "ok", bounds, "evaluated object bounds; unit scale reported", reason="no measurable extent" if tiny else "one dimension is flat" if flat else None), "bounds" in critical)
    record("empty", _check("block" if not meshes else "ok", {"objects": len(meshes)}, "mesh datablocks named by ownership"), "empty" in critical)

    scales = _unapplied_scale(meshes)
    record("unappliedScale", _check("block" if scales else "ok", scales or None, "object.scale compared with 1.0, tolerance 1e-4"), "unappliedScale" in critical)

    topology = _topology(bpy, meshes, depsgraph)
    non_manifold_status = "block" if topology["nonManifoldEdges"] else "ok"
    record("nonManifold", _check(non_manifold_status, topology, "BMEdge.is_manifold and boundary edge count"), "nonManifold" in critical or "boundary" in critical)
    if topology["boundaryEdges"] and "boundary" in critical:
        checks["nonManifold"]["status"] = "block"
        if "nonManifold" not in blockers:
            blockers.append("nonManifold")

    pairs, skipped = _self_intersections(bpy, meshes, topology["faces"], depsgraph)
    if skipped or pairs is None:
        record("selfIntersections", _check("warn", None, "BVHTree.overlap with shared-vertex exclusion", reason=skipped or "not measured"), False)
    else:
        record("selfIntersections", _check("block" if pairs["pairs"] else "ok", pairs, "BVHTree.overlap with shared-vertex exclusion"), "selfIntersections" in critical)

    wall_limit = MIN_WALL_METRES.get(profile)
    wall, _ = _wall_thickness(bpy, meshes, depsgraph)
    wall_status = "ok"
    if wall_limit is not None and wall["distance"] is not None and wall["distance"] < wall_limit:
        wall_status = "block"
    wall["limit"] = wall_limit
    record("wallThickness", _check(wall_status, wall, "ray from sampled face centres along the inverted normal", limit=wall_limit), "wallThickness" in critical)

    symmetry, _ = _symmetry(bpy, meshes, symmetry_axis, depsgraph)
    record("symmetry", _check("warn" if symmetry["rms"] and symmetry["rms"] > 1e-3 else "ok", symmetry, "KD-tree nearest mirrored vertex about the bounds centre"), False)

    missing_uv = _uv(meshes, depsgraph)
    record("uv", _check("block" if missing_uv else "ok", {"missing": missing_uv} if missing_uv else {"missing": []}, "mesh.uv_layers plus polygon loop indices"), "uv" in critical)

    procedural = _materials(bpy, meshes)
    record("materials", _check("warn" if procedural else "ok", {"procedural": procedural} if procedural else {"procedural": []}, "node types outside the glTF-safe set"), "materials" in critical)

    return {
        "profile": profile,
        "blocking": bool(blockers),
        "blockers": blockers,
        "warnings": warnings,
        "checks": checks,
    }
