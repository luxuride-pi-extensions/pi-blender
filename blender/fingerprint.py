"""Content fingerprints of the scene, shared by the live bridge and branch runs.

These exist because Blender gives no reliable "did this script change anything"
signal. `bpy.data.is_dirty` is documented as a UI-facing flag and reads False in
background mode, so a before/after dirty check silently reports every real edit
as no change. Content hashing inside Blender is the only answer that works
headless, and both execution paths need the same one to agree.
"""

import contextlib
import hashlib


def _floats(values):
    return ",".join(f"{float(value):.6f}" for value in values)


def _image_digest(image):
    """Identity and pixels, because a paint module edits pixels in place.

    A path and a size only say which file was loaded. The pixels are what the
    user sees, so a packed, generated or in-place-painted image has to
    contribute its content. Reading every pixel of a 4K texture on every run
    costs more than the render the fingerprint exists to avoid, so above the cap
    the digest takes an even sample and records that it did.
    """
    digest = hashlib.sha256()
    digest.update(f"{image.name}|{image.filepath}|{image.source}|".encode())
    with contextlib.suppress(AttributeError, TypeError, ValueError):
        digest.update(f"{image.size[0]}x{image.size[1]}|".encode())
    if not getattr(image, "has_data", False):
        return digest.hexdigest()
    try:
        pixels = image.pixels[:]
    except (AttributeError, RuntimeError):
        return digest.hexdigest()
    cap = 4_000_000
    step = max(1, len(pixels) // cap)
    digest.update(f"n={len(pixels)};step={step};".encode())
    for index in range(0, len(pixels), step):
        digest.update(f"{pixels[index]:.5f},".encode())
    return digest.hexdigest()


def _vertex_groups(obj):
    groups = []
    for vertex in getattr(obj.data, "vertices", []):
        for membership in getattr(vertex, "groups", []):
            groups.append(f"{membership.group}:{membership.weight:.6f}")
    return "|".join(groups)


def _pose(obj):
    bones = getattr(obj, "pose", None)
    if bones is None:
        return ""
    parts = []
    for bone in bones.bones:
        parts.append(bone.name + ":" + _floats(value for row in bone.matrix_basis for value in row))
    return "|".join(parts)


def _mesh_digest(data):
    mesh = hashlib.sha256()
    for vert in data.vertices:
        mesh.update(f"{vert.co.x:.6f},{vert.co.y:.6f},{vert.co.z:.6f}\n".encode())
    for poly in data.polygons:
        mesh.update(f"{poly.loop_start}/{poly.loop_total}\n".encode())
    mesh.update(b"uv;")
    for layer in data.uv_layers:
        mesh.update(layer.name.encode())
        for loop in layer.data:
            mesh.update(f"{loop.uv.x:.6f},{loop.uv.y:.6f}\n".encode())
    mesh.update(b"colour;")
    for attribute in data.color_attributes:
        mesh.update(attribute.name.encode())
        for value in attribute.data:
            colour = value.color
            if isinstance(colour, (int, float)):
                mesh.update(f"{float(colour):.6f}\n".encode())
            else:
                mesh.update(_floats(colour).encode())
    return mesh.hexdigest()


def _rna_state(idblock):
    """Scalar RNA settings, sorted by identifier.

    A modifier's identity is its type, and its content is every setting that can
    change geometry. Hashing only the type made a bevel-width edit invisible.
    """
    parts = []
    # Runtime identity and UI state are not content: persistent_uid is assigned
    # per datablock, execution_time is a measurement, and show_expanded is a
    # panel toggle. Including them made a freshly created modifier fingerprint
    # differently on every run.
    ignored = {"rna_type", "persistent_uid", "execution_time", "show_expanded", "is_active", "is_override_data"}
    for prop in sorted(idblock.bl_rna.properties, key=lambda item: item.identifier):
        if prop.identifier in ignored or prop.type in {"POINTER", "COLLECTION"}:
            continue
        try:
            value = getattr(idblock, prop.identifier)
        except (AttributeError, TypeError, RuntimeError):
            continue
        if isinstance(value, (bool, int, float, str)):
            parts.append(f"{prop.identifier}={value}")
        elif hasattr(value, "__len__") and not isinstance(value, str):
            try:
                parts.append(f"{prop.identifier}=" + ",".join(f"{float(item):.6f}" for item in value))
            except (TypeError, ValueError):
                continue
    pointer = getattr(idblock, "object", None)
    if pointer is not None:
        parts.append(f"object={pointer.name}")
    target = getattr(idblock, "target", None)
    if target is not None:
        parts.append(f"target={target.name}")
    return "|".join(parts)


def _animation_state(idblock):
    animation = getattr(idblock, "animation_data", None)
    action = getattr(animation, "action", None) if animation is not None else None
    if action is None:
        return "action="
    parts = [f"action={action.name}", f"slot={getattr(animation, 'action_slot', None)}"]
    for curve in sorted(action.fcurves, key=lambda item: (item.data_path, item.array_index)):
        points = ";".join(f"{point.co[0]:.3f}:{point.co[1]:.6f}" for point in curve.keyframe_points)
        parts.append(f"{curve.data_path}[{curve.array_index}]={points}")
    return "|".join(parts)


def fingerprint_object(obj):
    """A content hash of one object.

    Content, not identity: the NAME is excluded, because a rename shows up as a
    remove plus an add and would otherwise double-count as a modification of
    two objects.
    """
    parts = [obj.type]
    parts.append(obj.parent.name if obj.parent is not None else "")
    parts.append("|".join(f"{value:.6f}" for row in obj.matrix_world for value in row))
    parts.append("|".join(f"{mod.type}:{_rna_state(mod)}" for mod in obj.modifiers))
    parts.append("|".join(f"{cons.type}:{_rna_state(cons)}" for cons in obj.constraints))
    parts.append("anim=" + _animation_state(obj))
    if obj.type in {"LIGHT", "CAMERA"}:
        parts.append("data=" + _rna_state(obj.data))
        parts.append("animData=" + _animation_state(obj.data))
    parts.append(";".join(f"{group.index:.6f}" for group in obj.vertex_groups))
    parts.append("weights=" + _vertex_groups(obj))
    parts.append("pose=" + _pose(obj))

    data = getattr(obj, "data", None)
    if data is not None and hasattr(data, "vertices"):
        try:
            parts.append(f"verts={len(data.vertices)}")
            parts.append(f"polys={len(data.polygons)}")
            parts.append("mesh=" + _mesh_digest(data))
            shape_keys = getattr(data, "shape_keys", None)
            if shape_keys is not None:
                keys = getattr(shape_keys, "key_blocks", [])
                parts.append("shape=" + "|".join(f"{key.name}:{key.value:.6f}" for key in keys))
                parts.append("shapeAnim=" + _animation_state(shape_keys))
        except (AttributeError, TypeError, RuntimeError):
            pass

    # Material NAMES, not material content: the material itself is a tracked
    # datablock in its own right, and hashing it here as well would make every
    # object that merely references it look touched by a paint module.
    parts.append("slots=" + "|".join(slot.material.name if slot.material else "" for slot in obj.material_slots))
    return hashlib.sha256("\x00".join(parts).encode()).hexdigest()


def fingerprint_material(material):
    """A content hash of one material's node tree, or its flat settings."""
    if getattr(material, "node_tree", None) is None:
        return hashlib.sha256(
            f"{material.name}|{material.diffuse_color[0]:.6f}|{material.diffuse_color[3]:.6f}".encode()
        ).hexdigest()
    tree = material.node_tree
    digest = hashlib.sha256()
    for node in sorted(tree.nodes, key=lambda item: item.name):
        digest.update(f"{node.name}|{node.type}".encode())
        for socket in node.inputs:
            try:
                value = socket.default_value
            except (AttributeError, TypeError):
                continue
            if hasattr(value, "__len__"):
                digest.update(_floats(value).encode())
            else:
                digest.update(str(value).encode())
        image = getattr(node, "image", None)
        if image is not None:
            # A TEX_IMAGE node can be rewired to a different image without any
            # socket value changing; the image is the content here.
            digest.update(("image=" + _image_digest(image)).encode())
    for link in sorted(
        tree.links,
        key=lambda item: (item.from_node.name, item.from_socket.name, item.to_node.name, item.to_socket.name),
    ):
        digest.update(
            f"{link.from_node.name}.{link.from_socket.name}>{link.to_node.name}.{link.to_socket.name};".encode()
        )
    return digest.hexdigest()


def snapshot(bpy):
    """Hash every object, material and image in the current file."""
    # The depsgraph update is what makes the fingerprints below truthful. A script
    # that sets obj.location has changed matrix_world only lazily, so reading it
    # without this returns the PREVIOUS transform -- and a moved object then
    # fingerprints identical to a stationary one, which reports as a module that
    # touched nothing and silently drops its work at apply time. This used to be
    # masked by the save that ran before the snapshot; framing moved the save
    # after it, and the masking went with it.
    bpy.context.view_layer.update()
    return {
        "objects": {obj.name: fingerprint_object(obj) for obj in bpy.data.objects},
        "materials": {mat.name: fingerprint_material(mat) for mat in bpy.data.materials},
        # Paint writes pixels in place, and those pixels are not reachable from
        # an object or a material hash by themselves.
        "images": {image.name: _image_digest(image) for image in bpy.data.images},
    }


def content_changed(before, after):
    """Whether two snapshots describe different scene content.

    Additions, removals and edits all count: a script that only deletes an object
    changed the file just as much as one that builds a new one.
    """
    if before is None or after is None:
        return False
    for kind in ("objects", "materials", "images"):
        before_map = before.get(kind, {})
        after_map = after.get(kind, {})
        if set(before_map) != set(after_map):
            return True
        for name, fingerprint in before_map.items():
            if after_map.get(name) != fingerprint:
                return True
    return False
