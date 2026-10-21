# bpy.props — Custom Property Definitions (Blender 4.2 LTS)

The `bpy.props` module defines typed property definitions for custom Operator parameters, Add-on preferences, and UI property groups.

## Property Types

### bpy.props.StringProperty
```python
bpy.props.StringProperty(name="", description="", default="", maxlen=0, options={'ANIMATABLE'}, subtype='NONE', update=None, get=None, set=None)
```
Text string property.

### bpy.props.IntProperty
```python
bpy.props.IntProperty(name="", description="", default=0, min=-2**31, max=2**31-1, soft_min=-2**31, soft_max=2**31-1, step=1, options={'ANIMATABLE'}, subtype='NONE', update=None, get=None, set=None)
```
Signed integer property with optional hard/soft clamping bounds.

### bpy.props.FloatProperty
```python
bpy.props.FloatProperty(name="", description="", default=0.0, min=-3.402823e+38, max=3.402823e+38, soft_min=-3.402823e+38, soft_max=3.402823e+38, step=3, precision=3, options={'ANIMATABLE'}, subtype='NONE', unit='NONE', update=None, get=None, set=None)
```
Floating-point number with precision formatting and physics unit support ('LENGTH', 'AREA', 'VOLUME', 'ROTATION', 'TIME', 'VELOCITY', 'ACCELERATION', 'MASS', 'CAMERA', 'POWER').

### bpy.props.BoolProperty
```python
bpy.props.BoolProperty(name="", description="", default=False, options={'ANIMATABLE'}, subtype='NONE', update=None, get=None, set=None)
```
Boolean toggle switch property.

### bpy.props.EnumProperty
```python
bpy.props.EnumProperty(items, name="", description="", default=None, options={'ANIMATABLE'}, update=None, get=None, set=None)
```
Enumeration dropdown selection. `items` is a sequence of `(identifier, name, description, icon, number)` tuples.

### bpy.props.PointerProperty
```python
bpy.props.PointerProperty(type=None, name="", description="", options={'ANIMATABLE'}, update=None)
```
Reference pointer to a datablock or custom PropertyGroup.

### bpy.props.CollectionProperty
```python
bpy.props.CollectionProperty(type=None, name="", description="", options={'ANIMATABLE'})
```
List collection of PropertyGroup elements.

### bpy.props.FloatVectorProperty
```python
bpy.props.FloatVectorProperty(name="", description="", default=(0.0, 0.0, 0.0), min=-3.402823e+38, max=3.402823e+38, soft_min=-3.402823e+38, soft_max=3.402823e+38, step=3, precision=3, options={'ANIMATABLE'}, subtype='NONE', size=3, unit='NONE', update=None, get=None, set=None)
```
Vector array of floating point numbers (size 2 to 32, default 3). Subtypes: 'COLOR', 'TRANSLATION', 'DIRECTION', 'VELOCITY', 'ACCELERATION', 'EULER', 'QUATERNION', 'XYZ'.
