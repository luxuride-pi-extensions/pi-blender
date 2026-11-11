"""Post-run scene accounting shared by the branch runner and the live bridge.

Both execution paths answer the same three questions after a module script: what
did it touch, what must the apply move, and what does the module own so a later
run can be compared against it. The answers were written twice and drifted —
the live path could not report ownership at all, so a module built in a live
session restarted its digest from an empty subject on the next headless run.
Keeping them here also keeps the digest's empty-subject rule in one place.

`bpy` is never imported at module scope: the helpers that need it take it as an
argument, so this file can be imported and unit-tested outside Blender.
"""

import hashlib

CAMERA_SUFFIX = "Cam"
FRAMING_DATABLOCK_SUFFIXES = (CAMERA_SUFFIX, CAMERA_SUFFIX + "Target")


def diff_snapshots(before, after):
    """What changed between two `fingerprint.snapshot` maps.

    Additions, removals and edits all count as touched: a script that only
    deletes an object changed the file as much as one that builds a new one.
    """
    before_objects = before.get("objects", {})
    after_objects = after.get("objects", {})
    before_materials = before.get("materials", {})
    after_materials = after.get("materials", {})

    return {
        "touchedObjects": sorted(
            name
            for name in (set(before_objects) | set(after_objects))
            if before_objects.get(name) != after_objects.get(name)
        ),
        "touchedMaterials": sorted(
            name
            for name in (set(before_materials) | set(after_materials))
            if before_materials.get(name) != after_materials.get(name)
        ),
        "addedObjects": sorted(set(after_objects) - set(before_objects)),
        "removedObjects": sorted(set(before_objects) - set(after_objects)),
    }


def widen_apply_objects(bpy, touched_objects, deleted_objects, after_objects):
    """Widen the apply set to the datablocks that cannot travel alone.

    A parented object without its parent is not a usable object, and a parent
    without its children strands them. Widening happens here rather than at
    apply time, and is reported, because a widened apply set is exactly what
    turns into a conflict against a sibling.

    A deleted object that was only a RELATIVE of something touched is not a
    removal by this module: it never asked for one, and dropping it because a
    parent moved would make this module's apply destroy another module's work.
    """
    deleted = set(deleted_objects)
    after = set(after_objects)
    apply_objects = set(touched_objects) - deleted
    for name in list(apply_objects):
        obj = bpy.data.objects.get(name)
        if obj is None:
            continue
        ancestor = obj.parent
        while ancestor is not None:
            apply_objects.add(ancestor.name)
            ancestor = ancestor.parent
        for descendant in obj.children_recursive:
            apply_objects.add(descendant.name)
    removed_objects = sorted(deleted - (apply_objects & after))
    return sorted(apply_objects), removed_objects


def owned_after(prior_owned, apply_objects, removed_objects):
    """Carry ownership forward across the run.

    Ownership is the DIGEST SUBJECT, not the apply set. An idempotent rebuild
    that removes and recreates a part byte-for-byte is indistinguishable from a
    run that did nothing: touched is empty and apply_objects is empty. A digest
    over the apply set would then hash the empty string and report every rebuild
    as a change, which is the one false negative the loop must not have.
    """
    owned = set(prior_owned or [])
    owned |= set(apply_objects)
    owned -= set(removed_objects)
    return sorted(owned)


def state_digest(after, owned_objects, touched_materials):
    """Content hash of what this module owns, or None when there is no subject.

    A pre-digest workspace and a run with no ownership both have nothing to
    compare. Returning None is that fact; returning `md5("")` would be a digest
    that every empty run matches, which reads as "unchanged" for a module whose
    subject was never recorded.

    Two exclusions keep the number about geometry a critic would notice. The
    camera AND its target are rewritten by framing on every run, so both
    suffixes are filtered: filtering on CAMERA_SUFFIX alone leaves the target in
    the digest, and because the after-snapshot predates framing, the first run
    hashes a datablock that does not exist yet as a dash while later runs hash
    its real content.
    """
    digest_objects = [
        name
        for name in sorted(owned_objects)
        if not name.endswith(FRAMING_DATABLOCK_SUFFIXES)
    ]
    source = [name + "=" + after["objects"].get(name, "-") for name in digest_objects]
    for material_name in sorted(touched_materials):
        source.append(material_name + "=" + after["materials"].get(material_name, "-"))
    if not source:
        return None
    # SHA-256, not MD5: these digests are change detectors rather than a
    # security boundary, but the rule against MD5 is cheap to satisfy and a
    # 64-hex digest is distinguishable from the 32-hex values earlier releases
    # recorded, which callers use to skip an incomparable comparison.
    return hashlib.sha256("\x01".join(source).encode()).hexdigest()
