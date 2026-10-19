"""
Blend-file health summaries: missing files and linked library trees.

Inspects the saved .blend file headlessly without requiring a running UI window:
- missingFiles: external references that are missing from disk (images, libraries,
  fonts, sounds, movie clips, caches, sequences) checking os.path.exists on resolved file paths.
- linkedLibraries: tree and list of directly and indirectly linked library files.
"""

import os
import bpy


def resolve_path(raw_path, blend_path=None):
    """Resolve a Blender filepath to an absolute, normalized filesystem path."""
    if not raw_path:
        return None
    try:
        resolved = bpy.path.abspath(raw_path)
    except Exception:
        resolved = raw_path

    # If the blend file is saved, bpy.path.abspath resolves '//'.
    # If not saved or relative resolution failed, fallback to blend_path.
    if resolved.startswith("//"):
        base_dir = (
            os.path.dirname(bpy.data.filepath)
            if bpy.data.filepath
            else (os.path.dirname(blend_path) if blend_path else os.getcwd())
        )
        resolved = os.path.join(base_dir, resolved[2:])

    return os.path.normpath(os.path.abspath(resolved))


def extract_missing_files(blend_path=None):
    """Report missing external references per kind with offending paths.

    Inspects:
    - images: bpy.data.images (skipping generated, viewer, and packed images)
    - libraries: bpy.data.libraries (skipping packed)
    - fonts: bpy.data.fonts (skipping builtin and packed)
    - sounds: bpy.data.sounds (skipping packed)
    - movieClips: bpy.data.movieclips
    - caches: bpy.data.cache_files
    - sequences: strips in scene sequence editors (image, movie, sound, clip)
    """
    missing = {
        "images": [],
        "libraries": [],
        "fonts": [],
        "sounds": [],
        "movieClips": [],
        "caches": [],
        "sequences": [],
    }

    # Images
    for img in bpy.data.images:
        if getattr(img, "source", None) in ("VIEWER", "GENERATED"):
            continue
        if getattr(img, "packed_file", None) is not None:
            continue
        raw = getattr(img, "filepath", None)
        if not raw:
            continue
        resolved = resolve_path(raw, blend_path)
        if resolved and not os.path.exists(resolved):
            missing["images"].append({
                "name": img.name,
                "filepath": raw,
                "resolvedPath": resolved,
                "path": resolved,
            })

    # Libraries
    for lib in bpy.data.libraries:
        if getattr(lib, "packed_file", None) is not None:
            continue
        raw = getattr(lib, "filepath", None)
        if not raw:
            continue
        resolved = resolve_path(raw, blend_path)
        if resolved and not os.path.exists(resolved):
            missing["libraries"].append({
                "name": lib.name,
                "filepath": raw,
                "resolvedPath": resolved,
                "path": resolved,
            })

    # Fonts
    for font in bpy.data.fonts:
        raw = getattr(font, "filepath", None)
        if not raw or raw == "<builtin>":
            continue
        if getattr(font, "packed_file", None) is not None:
            continue
        resolved = resolve_path(raw, blend_path)
        if resolved and not os.path.exists(resolved):
            missing["fonts"].append({
                "name": font.name,
                "filepath": raw,
                "resolvedPath": resolved,
                "path": resolved,
            })

    # Sounds
    for snd in bpy.data.sounds:
        if getattr(snd, "packed_file", None) is not None:
            continue
        raw = getattr(snd, "filepath", None)
        if not raw:
            continue
        resolved = resolve_path(raw, blend_path)
        if resolved and not os.path.exists(resolved):
            missing["sounds"].append({
                "name": snd.name,
                "filepath": raw,
                "resolvedPath": resolved,
                "path": resolved,
            })

    # Movie clips
    for clip in bpy.data.movieclips:
        raw = getattr(clip, "filepath", None)
        if not raw:
            continue
        resolved = resolve_path(raw, blend_path)
        if resolved and not os.path.exists(resolved):
            missing["movieClips"].append({
                "name": clip.name,
                "filepath": raw,
                "resolvedPath": resolved,
                "path": resolved,
            })

    # Caches (Alembic / USD / cache files)
    for cf in getattr(bpy.data, "cache_files", []):
        raw = getattr(cf, "filepath", None)
        if not raw:
            continue
        resolved = resolve_path(raw, blend_path)
        if resolved and not os.path.exists(resolved):
            missing["caches"].append({
                "name": cf.name,
                "filepath": raw,
                "resolvedPath": resolved,
                "path": resolved,
            })

    # Sequences
    for scene in bpy.data.scenes:
        if not getattr(scene, "sequence_editor", None):
            continue
        seqs = getattr(scene.sequence_editor, "strips_all", None)
        if seqs is None:
            seqs = getattr(scene.sequence_editor, "strips", None)
        if seqs is None:
            seqs = getattr(scene.sequence_editor, "sequences_all", None)
        if seqs is None:
            seqs = getattr(scene.sequence_editor, "sequences", [])
        for strip in seqs:
            strip_type = getattr(strip, "type", None)
            if strip_type == "IMAGE":
                directory = getattr(strip, "directory", "")
                elements = getattr(strip, "elements", [])
                if elements:
                    for elem in elements:
                        elem_fn = getattr(elem, "filename", "")
                        if not elem_fn:
                            continue
                        raw = os.path.join(directory, elem_fn) if directory else elem_fn
                        resolved = resolve_path(raw, blend_path)
                        if resolved and not os.path.exists(resolved):
                            missing["sequences"].append({
                                "name": f"{strip.name}/{elem_fn}",
                                "strip": strip.name,
                                "filepath": raw,
                                "resolvedPath": resolved,
                                "path": resolved,
                            })
                elif directory:
                    resolved = resolve_path(directory, blend_path)
                    if resolved and not os.path.exists(resolved):
                        missing["sequences"].append({
                            "name": strip.name,
                            "strip": strip.name,
                            "filepath": directory,
                            "resolvedPath": resolved,
                            "path": resolved,
                        })
            elif strip_type in ("MOVIE", "SOUND"):
                raw = getattr(strip, "filepath", None)
                if not raw and strip_type == "SOUND" and getattr(strip, "sound", None):
                    raw = getattr(strip.sound, "filepath", None)
                if not raw:
                    continue
                resolved = resolve_path(raw, blend_path)
                if resolved and not os.path.exists(resolved):
                    missing["sequences"].append({
                        "name": strip.name,
                        "strip": strip.name,
                        "filepath": raw,
                        "resolvedPath": resolved,
                        "path": resolved,
                    })
            elif strip_type == "CLIP" and getattr(strip, "clip", None):
                raw = getattr(strip.clip, "filepath", None)
                if not raw:
                    continue
                resolved = resolve_path(raw, blend_path)
                if resolved and not os.path.exists(resolved):
                    missing["sequences"].append({
                        "name": strip.name,
                        "strip": strip.name,
                        "filepath": raw,
                        "resolvedPath": resolved,
                        "path": resolved,
                    })

    # Aliases
    missing["movie_clips"] = missing["movieClips"]
    missing["totalCount"] = sum(
        len(items)
        for items in [
            missing["images"],
            missing["libraries"],
            missing["fonts"],
            missing["sounds"],
            missing["movieClips"],
            missing["caches"],
            missing["sequences"],
        ]
    )

    return missing


def extract_linked_libraries(blend_path=None):
    """Report linked-library tree and list, including indirect links.

    Returns:
    - tree: hierarchical list of root linked libraries with nested children
    - list: flat list of all linked libraries
    - hasIndirect: boolean flag whether any indirect libraries are present
    - totalCount: total count of linked libraries
    """
    all_nodes = []
    nodes_by_name = {}

    for lib in bpy.data.libraries:
        parent_obj = getattr(lib, "parent", None)
        parent_name = parent_obj.name if parent_obj else None
        parent_filepath = parent_obj.filepath if parent_obj else None
        is_indirect = bool(parent_obj is not None or getattr(lib, "is_library_indirect", False))

        raw = getattr(lib, "filepath", "")
        resolved = resolve_path(raw, blend_path) if raw else None
        exists = os.path.exists(resolved) if resolved else False

        node = {
            "name": lib.name,
            "filepath": raw,
            "resolvedPath": resolved,
            "isIndirect": is_indirect,
            "parentName": parent_name,
            "parentFilePath": parent_filepath,
            "exists": exists,
            "children": [],
        }
        all_nodes.append(node)
        nodes_by_name[lib.name] = node

    # Construct the tree: root nodes have no parent in this file's libraries
    tree = []
    for node in all_nodes:
        pname = node["parentName"]
        if pname and pname in nodes_by_name:
            nodes_by_name[pname]["children"].append(node)
        else:
            tree.append(node)

    return {
        "tree": tree,
        "list": all_nodes,
        "totalCount": len(all_nodes),
        "hasIndirect": any(node["isIndirect"] for node in all_nodes),
    }
