# bpy.ops.armature — Armature Operators (Blender 4.2 LTS)

Operators for armature skeletal rigging in Edit Mode.

## Operators

### bpy.ops.armature.bone_primitive_add
```python
bpy.ops.armature.bone_primitive_add(name="Bone")
```
Add a new bone to the active armature in Edit Mode.

### bpy.ops.armature.extrude_move
```python
bpy.ops.armature.extrude_move(ARMATURE_OT_extrude=None, TRANSFORM_OT_translate=None)
```
Extrude selected bone tips into new child bones connected at the joint.

### bpy.ops.armature.subdivide
```python
bpy.ops.armature.subdivide(number_cuts=1)
```
Subdivide selected bones in Edit Mode into chains of smaller bones.
