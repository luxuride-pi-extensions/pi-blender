# bpy.context — Execution Context Access (Blender 4.2 LTS)

The `bpy.context` module provides read-only properties describing the active state, active selection, scene, window, and workspace.

## Context Properties

### bpy.context.active_object
The currently active Object in the active view layer (or `None` if nothing is active).
```python
obj = bpy.context.active_object
if obj and obj.type == 'MESH':
    print("Active mesh:", obj.name)
```

### bpy.context.selected_objects
List of all selected Object instances in the active view layer.

### bpy.context.scene
The currently active `bpy.types.Scene` datablock.

### bpy.context.view_layer
The active `bpy.types.ViewLayer` datablock.

### bpy.context.mode
Current interaction mode string:
- `'OBJECT'`: Object Mode.
- `'EDIT_MESH'`: Mesh Edit Mode.
- `'POSE'`: Armature Pose Mode.
- `'SCULPT'`: Sculpt Mode.
- `'PAINT_WEIGHT'`: Weight Paint Mode.
- `'PAINT_VERTEX'`: Vertex Paint Mode.
- `'PAINT_TEXTURE'`: Texture Paint Mode.

### bpy.context.workspace
The active `bpy.types.Workspace` layout.

### bpy.context.area / bpy.context.region
The active window Area (e.g. 'VIEW_3D', 'PROPERTIES') and Region ('WINDOW', 'UI', 'HEADER') when invoked in interactive contexts.

## Context Overrides

In Blender 3.2+ and 4.x, operators requiring a specific context must be invoked using `bpy.context.temp_override(...)` as a Python context manager rather than passing context dictionary arguments:

```python
# Modern Blender 4.2 LTS context override pattern:
with bpy.context.temp_override(active_object=target_obj, selected_objects=[target_obj]):
    bpy.ops.object.modifier_apply(modifier="Subsurf")
```
