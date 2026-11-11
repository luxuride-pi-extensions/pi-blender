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

# Provided by Blender's own runtime, not by anything installed here.
# pi-lens-ignore: ast-grep:unresolved-import-python
import bpy  # pyright: ignore[reportMissingImports]
from shading import material_summary

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


def _read_gltf_json(path):
    import json
    import struct

    if path.lower().endswith(".glb"):
        with open(path, "rb") as handle:
            magic, version, _length = struct.unpack("<III", handle.read(12))
            if magic != 0x46546C67 or version != 2:
                raise RuntimeError("the exporter wrote a file that is not a glTF 2.0 binary")
            while True:
                header = handle.read(8)
                if len(header) < 8:
                    break
                chunk_length, chunk_type = struct.unpack("<II", header)
                payload = handle.read(chunk_length)
                if chunk_type == 0x4E4F534A:
                    return json.loads(payload.decode("utf-8"))
        raise RuntimeError("the glb has no JSON chunk")
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def _verify_textures(fmt, export_path, materials):
    """A GLB that silently drops its images must fail the tool, not the user."""
    image_nodes = [
        node
        for material in materials
        if material.use_nodes and material.node_tree is not None
        for node in material.node_tree.nodes
        if node.type == "TEX_IMAGE" and node.image is not None
    ]
    uses_images = any(any(output.is_linked for output in node.outputs) for node in image_nodes)
    if fmt not in {"glb", "gltf"}:
        return {"images": 0, "textures": 0, "verified": None}
    if os.path.getsize(export_path) < 12:
        raise RuntimeError("the exporter wrote an empty file, so no glTF JSON can be read")
    document = _read_gltf_json(export_path)
    images = document.get("images") or []
    textures = document.get("textures") or []
    materials_out = document.get("materials") or []
    if uses_images and not images:
        raise RuntimeError(
            "the exported glTF contains no images although the material samples an "
            "image; the texture was dropped in export and the asset would arrive flat"
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
            if uri and not os.path.exists(os.path.join(base, uri)):
                raise RuntimeError(f"the exported glTF points at a missing image file: {uri}")
    return {"images": len(images), "textures": len(textures), "verified": True if uses_images else None}


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
    export_path = os.path.join(output_dir, "{}.{}".format(base, EXPORT_FORMATS[fmt][1]))

    # Selection is an explicit list or "everything", never inferred: exporting
    # the studio rig alongside the asset is the commonest way a dataset ends up
    # full of default cameras, and it has to be asked for to happen.
    selection = request.get("objects")
    selection_given = selection is not None
    previously_selected = set(obj.name for obj in bpy.context.selected_objects)
    try:
        if selection_given:
            wanted = {str(name) for name in selection}
            missing = wanted - set(obj.name for obj in bpy.data.objects)
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
                "Blender's {} exporter failed: {}. This build may not ship that "
                "exporter; check whether the operator exists before relying on "
                "this format.".format(fmt, error)
            )
    finally:
        # Restored on both paths. An export that leaves every object selected
        # changes what the NEXT call in the same session selects, which is the
        # kind of state leak that only shows up two steps later.
        for obj in bpy.data.objects:
            obj.select_set(obj.name in previously_selected)

    if not os.path.exists(export_path):
        raise RuntimeError(
            "Blender reported {} exported but no file is at {}. The exporter "
            "returned successfully and wrote nothing.".format(fmt, export_path)
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
    warnings = []
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
        "warnings": warnings,
    }
