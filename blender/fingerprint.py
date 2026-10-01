"""Content fingerprints of the scene, shared by the live bridge and branch runs.

These exist because Blender gives no reliable "did this script change anything"
signal. `bpy.data.is_dirty` is documented as a UI-facing flag and reads False in
background mode, so a before/after dirty check silently reports every real edit
as no change. Content hashing inside Blender is the only answer that works
headless, and both execution paths need the same one to agree.
"""

import hashlib


def fingerprint_object(obj):
    """A content hash of one object.

    Content, not identity: the NAME is excluded, because a rename shows up as
    a remove plus an add and would otherwise double-count as a modification of
    two objects.
    """
    parts = [obj.type]
    parts.append(obj.parent.name if obj.parent is not None else "")
    parts.append("|".join("%.6f" % value for row in obj.matrix_world for value in row))
    parts.append(",".join(mod.type for mod in obj.modifiers))
    parts.append(str(len(obj.constraints)))
    parts.append(";".join("%.6f" % value for group in obj.vertex_groups for value in (group.index,)))

    data = getattr(obj, "data", None)
    if data is not None and hasattr(data, "vertices"):
        try:
            parts.append("verts=%d" % len(data.vertices))
            parts.append("polys=%d" % len(data.polygons))
            digest = hashlib.md5()
            for vert in data.vertices:
                digest.update(("%.6f,%.6f,%.6f\n" % (vert.co.x, vert.co.y, vert.co.z)).encode())
            for poly in data.polygons:
                digest.update(("%d/%d\n" % (poly.loop_start, poly.loop_total)).encode())
            parts.append("mesh=" + digest.hexdigest())
        except (AttributeError, TypeError, RuntimeError):
            pass

    # Material NAMES, not material content: the material itself is a tracked
    # datablock in its own right, and hashing it here as well would make every
    # object that merely references it look touched by a paint module.
    parts.append("slots=" + "|".join(slot.material.name if slot.material else "" for slot in obj.material_slots))
    return hashlib.md5("\x00".join(parts).encode()).hexdigest()


def fingerprint_material(material):
    """A content hash of one material's node tree, or its flat settings."""
    if getattr(material, "node_tree", None) is None:
        return hashlib.md5(
            ("%s|%s|%.6f" % (material.name, material.diffuse_color[0], material.diffuse_color[3])).encode()
        ).hexdigest()
    digest = hashlib.md5()
    for node in sorted(material.node_tree.nodes, key=lambda n: n.name):
        digest.update((node.name + "|" + node.type).encode())
        for socket in node.inputs:
            try:
                value = socket.default_value
            except (AttributeError, TypeError):
                continue
            if hasattr(value, "__len__"):
                digest.update(",".join("%.6f" % float(component) for component in value).encode())
            else:
                digest.update(str(value).encode())
    return digest.hexdigest()


def snapshot(bpy):
    """Hash every object and material in the current file."""
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
    }


def content_changed(before, after):
    """Whether two snapshots describe different scene content.

    Additions, removals and edits all count: a script that only deletes an object
    changed the file just as much as one that builds a new one.
    """
    if before is None or after is None:
        return False
    for kind in ("objects", "materials"):
        before_map = before.get(kind, {})
        after_map = after.get(kind, {})
        if set(before_map) != set(after_map):
            return True
        for name, fingerprint in before_map.items():
            if after_map.get(name) != fingerprint:
                return True
    return False
