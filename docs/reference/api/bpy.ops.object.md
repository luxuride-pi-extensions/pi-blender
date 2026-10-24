# bpy.ops.object — Object Operators (Blender 4.2 LTS)

Operators for object lifecycle, modes, transformations, hierarchy parenting, and modifier stack manipulation.

## Operators

### bpy.ops.object.mode_set
```python
bpy.ops.object.mode_set(mode='OBJECT', toggle=False)
```
Set the current interaction mode of the active object.

- `mode` (enum in ['OBJECT', 'EDIT', 'SCULPT', 'VERTEX_PAINT', 'WEIGHT_PAINT', 'TEXTURE_PAINT', 'POSE'], default 'OBJECT').
- `toggle` (boolean, default False): Toggle mode instead of setting explicitly.

### bpy.ops.object.select_all
```python
bpy.ops.object.select_all(action='TOGGLE')
```
Change selection of all objects in the current view layer ('SELECT', 'DESELECT', 'INVERT', 'TOGGLE').

### bpy.ops.object.modifier_add
```python
bpy.ops.object.modifier_add(type='SUBSURF')
```
Add a modifier to the active object's modifier stack.

- `type` (enum in ['SUBSURF', 'BOOLEAN', 'MIRROR', 'BEVEL', 'ARRAY', 'SOLIDIFY', 'ARMATURE', 'DECIMATE', 'CURVE', 'NODES', ...], default 'SUBSURF').

### bpy.ops.object.modifier_apply
```python
bpy.ops.object.modifier_apply(modifier="", report=False, merge_customdata=True, single_user=False)
```
Bake and evaluate the named modifier into the base mesh data of the active object.

- `modifier` (string): Name of the modifier to apply.
- `single_user` (boolean, default False): Create a unique copy of mesh data if shared by multiple objects.

### bpy.ops.object.modifier_remove
```python
bpy.ops.object.modifier_remove(modifier="", report=False)
```
Remove the named modifier from the active object's modifier stack.

### bpy.ops.object.shade_smooth
```python
bpy.ops.object.shade_smooth()
```
Set mesh shading to smooth interpolation across face normals. In Blender 4.1+, auto-smooth angle threshold is managed via the "Smooth by Angle" modifier/geometry nodes.

### bpy.ops.object.shade_flat
```python
bpy.ops.object.shade_flat()
```
Set mesh shading to flat faceted face normals.

### bpy.ops.object.transform_apply
```python
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True, properties=True, isolate_users=False)
```
Bake the object's transform delta into its underlying geometry and reset transform channels to identity.

- `location` (boolean, default True): Reset object location to (0,0,0) and displace vertices.
- `rotation` (boolean, default True): Reset object rotation to 0 and rotate vertices.
- `scale` (boolean, default True): Reset object scale to (1,1,1) and scale vertex coordinates.

### bpy.ops.object.origin_set
```python
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='MEDIAN')
```
Set object origin position.

- `type` (enum in ['GEOMETRY_ORIGIN', 'ORIGIN_GEOMETRY', 'ORIGIN_CURSOR', 'ORIGIN_CENTER_OF_MASS', 'ORIGIN_CENTER_OF_VOLUME']).
- `center` (enum in ['MEDIAN', 'BOUNDS']).

### bpy.ops.object.parent_set
```python
bpy.ops.object.parent_set(type='OBJECT', xmirror=False, keep_transform=False)
```
Set parent-child relationship between selected objects and active object.

- `type` (enum in ['OBJECT', 'ARMATURE', 'ARMATURE_NAME', 'ARMATURE_AUTO', 'ARMATURE_ENVELOPE', 'BONE', 'VERTEX', 'VERTEX_TRI']).

### bpy.ops.object.parent_clear
```python
bpy.ops.object.parent_clear(type='CLEAR')
```
Clear parent relationship ('CLEAR', 'CLEAR_KEEP_TRANSFORM', 'CLEAR_INVERSE').

### bpy.ops.object.join
```python
bpy.ops.object.join()
```
Join selected mesh objects into the active mesh object.

### bpy.ops.object.duplicate
```python
bpy.ops.object.duplicate(linked=False, mode='TRANSLATION')
```
Duplicate selected objects. If `linked=True`, duplicates share underlying mesh/curve datablocks.

### bpy.ops.object.delete
```python
bpy.ops.object.delete(use_global=False, confirm=False)
```
Delete selected objects from the current scene.

### bpy.ops.object.material_slot_add
```python
bpy.ops.object.material_slot_add()
```
Add a new empty material slot to the active object.

### bpy.ops.object.material_slot_remove
```python
bpy.ops.object.material_slot_remove()
```
Remove the currently active material slot from the object.

### bpy.ops.object.material_slot_assign
```python
bpy.ops.object.material_slot_assign()
```
Assign the material in the active slot to currently selected mesh faces in Edit Mode.
