"""
Export the open blend to an interchange format.

glTF/GLB is the target, because it is what 3D-native training pipelines read
and what keeps materials and the scene graph. OBJ is here because it is the
universal fallback: geometry only, no scene graph, no textures, and every mesh
tool on earth opens it. USD is deliberately absent -- no exporter is guaranteed
present in a stock Blender build, and a format that silently fails on one
machine is worse than one that is not offered at all.

Lives in the bridge rather than in a standalone script so it runs the same way
windowed and headless, and so it inherits the read-only guarantee: nothing here
saves back into the blend, so a failed export cannot damage the asset.

The caller, not this module, opens the blend, and the opener is passed IN rather
than imported: opening the blend is a property of the session the bridge owns, so
taking it as an argument keeps that ownership visible instead of hiding it
behind an import that only works from inside live-bridge.py.
"""

import os
import re
from urllib.parse import unquote

# Provided by Blender's own runtime, not by anything installed here.
# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]
from shading import SAFE_GLTF_NODES, material_summary

# Blender's operator name for each supported format, and its extension.
EXPORT_FORMATS = {
    "glb": ("export_scene.gltf", "glb"),
    "gltf": ("export_scene.gltf", "gltf"),
    "obj": ("wm.obj_export", "obj"),
    "stl": ("wm.stl_export", "stl"),
}


def _run_export(fmt, export_path, selection_given, animations):
    """Dispatch to whichever operator this format needs.

    Written as separate calls rather than a chained conditional: each exporter
    takes a different set of arguments, and a chain of conditionals hiding three
    different signatures is the kind of thing that reads correctly and does not
    work.
    """
    if fmt in ("glb", "gltf"):
        return bpy.ops.export_scene.gltf(
            filepath=export_path,
            export_format={
                "glb": "GLB",
                "gltf": "GLTF_SEPARATE",
            }[fmt],
            use_selection=selection_given,
            # Applies modifiers on export. The dataset case wants the evaluated
            # result: a model carrying an unapplied subdivision surface is a
            # model whose training geometry differs from its rendered geometry.
            export_apply=True,
            export_animations=animations,
            export_image_format="AUTO",
        )

    if fmt == "obj":
        return bpy.ops.wm.obj_export(
            filepath=export_path,
            export_selected_objects=selection_given,
            export_materials=True,
            export_uv=True,
            apply_modifiers=True,
        )

    return bpy.ops.wm.stl_export(
        filepath=export_path,
        export_selected_objects=selection_given,
        apply_modifiers=True,
    )


def _open_binary(path):
    try:
        return open(path, "rb")
    except OSError as error:
        raise RuntimeError(f"the exported glb could not be read: {error}") from error


def _read_gltf_json(path):
    import json
    import struct

    if path.lower().endswith(".glb"):
        with _open_binary(path) as handle:
            header = handle.read(12)
            try:
                magic, version, _length = struct.unpack("<III", header)
            except struct.error as error:
                raise RuntimeError(f"the exporter wrote a truncated glb header: {error}") from error
            if magic != 0x46546C67 or version != 2:
                raise RuntimeError("the exporter wrote a file that is not a glTF 2.0 binary")
            while True:
                header = handle.read(8)
                if len(header) < 8:
                    break
                try:
                    chunk_length, chunk_type = struct.unpack("<II", header)
                except struct.error as error:
                    raise RuntimeError(f"the glb chunk header is truncated: {error}") from error
                payload = handle.read(chunk_length)
                if chunk_type == 0x4E4F534A:
                    try:
                        return json.loads(payload.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as error:
                        raise RuntimeError(f"the glb JSON chunk is unreadable: {error}") from error
        raise RuntimeError("the glb has no JSON chunk")
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as error:
        raise RuntimeError(f"the exported glTF could not be read: {error}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"the exported glTF is not valid JSON: {error}") from error


def _verify_textures(fmt, export_path, materials):
    """A GLB that silently drops its images must fail the tool, not the user."""
    # Only textures the exporter carries to a real texture slot count. A
    # texture behind Bump or a colour ramp, or driving Emission Strength,
    # is reported as procedural instead of being demanded in the file.
    texture_sockets = {
        "Base Color", "Metallic", "Roughness", "Normal", "Emission Color", "Alpha",
    }
    image_nodes = []
    for material in materials:
        if not material.use_nodes or material.node_tree is None:
            continue
        seeds = [
            socket
            for node in material.node_tree.nodes
            if node.type == "BSDF_PRINCIPLED"
            for socket in node.inputs
            if socket.name in texture_sockets
        ]
        seen = set()
        queue = [link.from_node for socket in seeds for link in socket.links]
        while queue:
            node = queue.pop()
            if node in seen or node.type not in SAFE_GLTF_NODES:
                continue
            seen.add(node)
            if node.type == "TEX_IMAGE" and node.image is not None:
                image_nodes.append(node)
            for socket in node.inputs:
                queue.extend(link.from_node for link in socket.links)
    uses_images = bool(image_nodes)
    if fmt not in {"glb", "gltf"}:
        return {"images": 0, "textures": 0, "verified": None}
    if os.path.getsize(export_path) < 12:
        raise RuntimeError("the exporter wrote an empty file, so no glTF JSON can be read")
    document = _read_gltf_json(export_path)
    images = document.get("images") or []
    textures = document.get("textures") or []
    materials_out = document.get("materials") or []
    if uses_images and not images:
        names = sorted({material.name for material in materials})
        raise RuntimeError(
            f"the exported glTF contains no images although {', '.join(names)} sample "
            "an image; the texture was dropped in export and the asset would arrive flat"
        )
    if uses_images and not textures:
        raise RuntimeError("the exported glTF has images but no textures referencing them")
    if images and fmt == "glb":
        for index, image in enumerate(images):
            if "bufferView" not in image or "uri" in image:
                raise RuntimeError(
                    f"the exported glb image {index} is not embedded; it has no bufferView "
                    "and would need an external file at load time"
                )
    for index, texture in enumerate(textures):
        source = texture.get("source")
        if source is not None and (source < 0 or source >= len(images)):
            raise RuntimeError(f"the exported glTF texture {index} points at image {source}, which does not exist")
    if uses_images:
        referenced = False
        for material in materials_out:
            pbr = material.get("pbrMetallicRoughness") or {}
            if any(
                key in pbr or key in material
                for key in ("baseColorTexture", "metallicRoughnessTexture", "normalTexture", "occlusionTexture", "emissiveTexture")
            ):
                referenced = True
                break
        if not referenced:
            raise RuntimeError("the exported glTF has textures but no material references any of them")
    if fmt == "gltf":
        base = os.path.dirname(export_path)
        for image in images:
            uri = image.get("uri")
            if uri and not uri.startswith("data:"):
                path = os.path.join(base, unquote(uri))
                if not os.path.exists(path):
                    raise RuntimeError(f"the exported glTF points at a missing image file: {uri}")
    return {"images": len(images), "textures": len(textures), "verified": True if uses_images else None}


def _check(name, status, detail):
    return {"name": name, "status": status, "detail": detail}


def _mesh_objects(objects):
    return [obj for obj in objects if obj.type == "MESH"]


def _print_checks(objects, scene):
    """Facts a slicer would reject, measured from the evaluated mesh.

    Non-manifold edges and self-intersections are hard failures because every
    slicer has to repair them differently. A non-unit scene scale is only a
    warning: STL carries no units, so the operator may intend millimetres.
    """
    # Provided by Blender's own runtime, not by anything installed here.
    # pi-lens-ignore: ast-grep:unresolved-import-python
    import bmesh  # pyright: ignore[reportMissingImports]
    from mathutils.bvhtree import BVHTree  # pyright: ignore[reportMissingImports]

    checks = []
    meshes = _mesh_objects(objects)
    if not meshes:
        return [_check("meshes", "fail", "the export contains no mesh objects")]

    depsgraph = bpy.context.evaluated_depsgraph_get()
    open_edges = 0
    non_manifold = 0
    folds = 0
    negative = []
    scaled = []
    triangles = 0
    trees = []
    face_verts = []
    for obj in meshes:
        if any(abs(value - 1.0) > 1e-4 for value in obj.scale):
            scaled.append(obj.name)
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            bm = bmesh.new()
            bm.from_mesh(mesh)
            bm.transform(obj.matrix_world)
            triangles += sum(max(0, len(face.verts) - 2) for face in bm.faces)
            open_edges += sum(1 for edge in bm.edges if edge.is_boundary)
            non_manifold += sum(1 for edge in bm.edges if not edge.is_manifold)
            if bm.faces and bm.calc_volume(signed=True) < 0:
                negative.append(obj.name)
            bm.faces.ensure_lookup_table()
            if bm.faces:
                trees.append(BVHTree.FromBMesh(bm))
                face_verts.append([{vert.index for vert in face.verts} for face in bm.faces])
            bm.free()
        finally:
            evaluated.to_mesh_clear()

    for index, tree in enumerate(trees):
        for other in trees[index + 1 :]:
            if tree.overlap(other):
                folds += 1
                break
        # A joined mesh hides two interpenetrating shells from the cross-object
        # loop. Adjacent faces share vertices and are not a fold; a pair with no
        # shared vertex and overlapping triangles is.
        for first, second in tree.overlap(tree):
            if first < second and face_verts[index][first].isdisjoint(face_verts[index][second]):
                folds += 1
                break

    checks.append(_check("manifold", "fail" if non_manifold else "pass",
        f"{non_manifold} non-manifold edge(s); {open_edges} boundary edge(s)"))
    checks.append(_check("selfIntersection", "fail" if folds else "pass",
        f"{folds} mesh(es) with overlapping faces"))
    checks.append(_check("winding", "fail" if negative else "pass",
        "negative volume on: " + ", ".join(negative) if negative else "all shells enclose positive volume"))
    checks.append(_check("scale", "warn" if scaled else "pass",
        "unapplied object scale on: " + ", ".join(scaled) if scaled else "object scales are unit"))
    unit = float(getattr(scene.unit_settings, "scale_length", 1.0))
    checks.append(_check("units", "warn" if abs(unit - 1.0) > 1e-6 else "pass",
        f"scene unit scale {unit}; STL carries no units, so state millimetres in the brief"))
    checks.append(_check("triangles", "warn" if triangles > 500_000 else "pass",
        f"{triangles} triangles"))
    return checks


def _gltf_checks(document, fmt, export_path, objects):
    checks = []
    meshes = document.get("meshes") or []
    nodes = document.get("nodes") or []
    materials = document.get("materials") or []
    images = document.get("images") or []
    accessors = document.get("accessors") or []
    checks.append(_check("nodes", "fail" if not nodes else "pass", f"{len(nodes)} node(s)"))
    checks.append(_check("meshes", "fail" if not meshes else "pass", f"{len(meshes)} mesh(es)"))
    checks.append(_check("materials", "pass", f"{len(materials)} material(s)"))
    checks.append(_check("images", "pass", f"{len(images)} image(s)"))
    if fmt == "gltf":
        for image in images:
            uri = image.get("uri")
            if uri and not uri.startswith("data:"):
                path = os.path.join(os.path.dirname(export_path), unquote(uri))
                checks.append(_check(f"image:{uri}", "pass" if os.path.exists(path) else "fail",
                    "sidecar exists" if os.path.exists(path) else "sidecar is missing"))
    else:
        for index, image in enumerate(images):
            if "bufferView" not in image:
                checks.append(_check(f"image:{index}", "fail", "glb image is not embedded"))
    if accessors:
        invalid = [i for i, accessor in enumerate(accessors)
                   if accessor.get("count", 0) < 0 or accessor.get("componentType") is None]
        checks.append(_check("accessors", "fail" if invalid else "pass",
            f"{len(accessors)} accessor(s)" if not invalid else f"invalid accessor(s): {invalid}"))
    return checks


def _engine_checks(objects, materials):
    checks = []
    textures = 0
    largest = 0
    for material in materials:
        if not material.use_nodes or material.node_tree is None:
            continue
        for node in material.node_tree.nodes:
            if node.type != "TEX_IMAGE" or node.image is None:
                continue
            textures += 1
            # `size` is (0, 0) until the image is loaded; reading one pixel
            # forces the load so an 8K map is not reported as 0 px.
            node.image.pixels[0]
            largest = max(largest, int(node.image.size[0]), int(node.image.size[1]))
    checks.append(_check("textures", "warn" if largest > 4096 else "pass",
        f"{textures} texture node(s); largest {largest}px"))
    checks.append(_check("materials", "warn" if len(materials) > 16 else "pass",
        f"{len(materials)} material(s)"))
    checks.append(_check("objects", "fail" if not _mesh_objects(objects) else "pass",
        f"{len(_mesh_objects(objects))} mesh(es)"))
    return checks


def _validate_export(profile, fmt, export_path, objects, materials):
    if profile == "none":
        return None
    if profile not in {"gltf", "print", "engine"}:
        raise RuntimeError(f'Unsupported validation profile "{profile}". Supported: gltf, print, engine, none.')
    if profile == "gltf" and fmt not in {"glb", "gltf"}:
        # A caller that leaves the default on an STL has not asked for glTF
        # checks; the format has no glTF to inspect.
        return None
    if profile == "print":
        checks = _print_checks(objects, bpy.context.scene)
    elif profile == "engine":
        checks = _engine_checks(objects, materials)
    else:
        checks = _gltf_checks(_read_gltf_json(export_path), fmt, export_path, objects)
    return {
        "profile": profile,
        "ok": all(check["status"] != "fail" for check in checks),
        "checks": checks,
    }


def handle_export(request, open_blend):
    """Write the blend's geometry to an interchange file.

    Read-only with respect to model.blend.
    """
    # Opening is what makes this meaningful headless: there is no session there,
    # so without it the exporter would write whatever --factory-startup left
    # behind and report it as the workspace asset.
    open_blend(request)

    fmt = str(request.get("format", "glb")).lower()
    if fmt not in EXPORT_FORMATS:
        raise RuntimeError(
            'Unsupported export format "{}". Supported: {}.'.format(
                fmt, ", ".join(sorted(EXPORT_FORMATS))
            )
        )

    output_dir = request.get("outputDir") or os.path.dirname(
        bpy.data.filepath or os.getcwd()
    )
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as error:
        raise RuntimeError(
            f"Cannot create the export directory {output_dir}: {error}."
        ) from error

    base = os.path.splitext(os.path.basename(bpy.data.filepath or "model.blend"))[0]
    if request.get("name"):
        # Sanitised because the name usually comes from a prompt, and a prompt
        # is not obliged to avoid slashes.
        base = re.sub(r"[^A-Za-z0-9._-]", "_", str(request["name"]))
    export_path = os.path.join(output_dir, f"{base}.{EXPORT_FORMATS[fmt][1]}")

    # Selection is an explicit list or "everything", never inferred: exporting
    # the studio rig alongside the asset is the commonest way a dataset ends up
    # full of default cameras, and it has to be asked for to happen.
    selection = request.get("objects")
    selection_given = selection is not None
    previously_selected = {obj.name for obj in bpy.context.selected_objects}
    try:
        if selection_given:
            wanted = {str(name) for name in selection}
            missing = wanted - {obj.name for obj in bpy.data.objects}
            if missing:
                raise RuntimeError(
                    "Export asked for objects that are not in this blend: {}.".format(
                        ", ".join(sorted(missing))
                    )
                )
            for obj in bpy.data.objects:
                obj.select_set(obj.name in wanted)

        try:
            _run_export(fmt, export_path, selection_given, bool(request.get("animations", False)))
        except Exception as error:
            raise RuntimeError(
                f"Blender's {fmt} exporter failed: {error}. This build may not ship "
                "that exporter; check whether the operator exists before relying on "
                "this format."
            ) from error
    finally:
        # Restored on both paths. An export that leaves every object selected
        # changes what the NEXT call in the same session selects, which is the
        # kind of state leak that only shows up two steps later.
        for obj in bpy.data.objects:
            obj.select_set(obj.name in previously_selected)

    if not os.path.exists(export_path):
        raise RuntimeError(
            f"Blender reported {fmt} exported but no file is at {export_path}. The "
            "exporter returned successfully and wrote nothing."
        )

    exported_names = None if not selection_given else {str(name) for name in selection}
    exported_materials = {
        slot.material
        for obj in bpy.data.objects
        if exported_names is None or obj.name in exported_names
        for slot in obj.material_slots
        if slot.material is not None
    }
    procedural_materials = sorted(
        {material.name for material in exported_materials if material_summary(material)["procedural"]}
    )
    texture_report = _verify_textures(fmt, export_path, exported_materials)
    exported_objects = [
        obj for obj in bpy.data.objects if exported_names is None or obj.name in exported_names
    ]
    default_profile = "print" if fmt in {"obj", "stl"} else "gltf"
    profile = str(request.get("validationProfile") or default_profile).lower()
    validation = _validate_export(profile, fmt, export_path, exported_objects, exported_materials)
    warnings = []
    if validation is not None and not validation["ok"]:
        failed = [check["name"] for check in validation["checks"] if check["status"] == "fail"]
        warnings.append("the export failed its " + profile + " validation: " + ", ".join(failed))
    if procedural_materials and fmt in {"glb", "gltf"}:
        warnings.append(
            "glTF exports image textures, not procedural nodes. These materials "
            "will arrive with only their Principled defaults: {}. Bake them to "
            "images before exporting.".format(", ".join(procedural_materials))
        )

    return {
        "format": fmt,
        "exportPath": export_path,
        "bytes": os.path.getsize(export_path),
        "meshCount": sum(
            1
            for obj in bpy.data.objects
            if obj.type == "MESH" and (exported_names is None or obj.name in exported_names)
        ),
        "blendPath": bpy.data.filepath if bpy.data.filepath else None,
        "proceduralMaterials": procedural_materials,
        "images": texture_report["images"],
        "textures": texture_report["textures"],
        "texturesVerified": texture_report["verified"],
        "validation": validation,
        "warnings": warnings,
    }
