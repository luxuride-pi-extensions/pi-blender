# bpy.ops.material — Material Operators (Blender 4.2 LTS)

Operators for material slots and datablock assignment.

## Operators

### bpy.ops.material.new
```python
bpy.ops.material.new()
```
Create a new material and assign it to the active object's active material slot. Note that in Python scripts, `bpy.data.materials.new(name)` is preferred for direct programmatic control.
