"""
Blank-blend bootstrap for the pi-vibe-blender live bridge.

Runs as the first --python startup script of the UI launch, before
live-bridge.py registers its poll timer. It:
  1. Removes the default startup objects (Cube, Camera, Light) so the
     session starts from a truly empty scene.
  2. Saves the result to a known path so bpy.data.filepath is set and
     bpy.data.is_dirty is False — session context reports a saved,
     clean scene and no manual "save/discard" step is needed.

Env:
  PI_BLENDER_BLANK_BLEND_PATH — override the output path. launch.ts always
  sets it, to $XDG_CACHE_HOME/vibe-blender/blank/<instance-id>.blend (flatpak-
  visible via the bind-mounted XDG cache home), so the default below only
  applies to a hand-started Blender. It deliberately lands on a different
  filename from the per-instance ones: a manual run must not clobber the
  scratch blank a live instance is using.
"""

import os

# pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
import bpy  # pyright: ignore[reportMissingImports]

DEFAULT_BLANK_BLEND_PATH = os.path.join(
    os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache"),
    "vibe-blender",
    "blank",
    "manual.blend",
)


def main():
    blank_path = os.environ.get("PI_BLENDER_BLANK_BLEND_PATH") or DEFAULT_BLANK_BLEND_PATH

    # Remove the default startup objects (Cube, Camera, Light, ...).
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)

    # Drop the now-orphaned default datablocks so the file stays clean.
    for collection in (bpy.data.meshes, bpy.data.cameras, bpy.data.lights):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)

    # pi-lens-ignore: ast-grep:unchecked-throwing-call-python
    os.makedirs(os.path.dirname(blank_path), exist_ok=True)
    bpy.ops.wm.save_mainfile(filepath=blank_path)


main()
