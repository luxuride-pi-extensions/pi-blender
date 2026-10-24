# bpy.types — Blender Data and Struct Types (Blender 4.2 LTS)

Authoritative class reference for Blender's internal data model, objects, meshes, modifiers, and shading datablocks.

## Core Classes

### bpy.types.Object
```python
bpy.types.Object(ID)
```
Represents an object instance situated in 3D world space (meshes, lights, cameras, armatures, empties).

**Properties:**
- `name` (string): Unique object identifier within the file.
- `type` (enum in ['MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'ARMATURE', 'LATTICE', 'EMPTY', 'LIGHT', 'CAMERA', 'SPEAKER', 'LIGHT_PROBE', 'VOLUME', 'GPENCIL']): Datablock type.
- `location` (Vector of 3 floats): Object translation vector in world/parent coordinates.
- `rotation_euler` (Euler angles in radians): Orientation specified in XYZ order.
- `rotation_quaternion` (Quaternion of 4 floats): Orientation specified as quaternion (w, x, y, z).
- `scale` (Vector of 3 floats): Non-uniform scaling vector.
- `dimensions` (Vector of 3 floats): Axis-aligned bounding box size in meters.
- `matrix_world` (Matrix 4x4): Complete transform matrix in world space including parent hierarchy.
- `data` (ID): Pointer to underlying geometry or device datablock (`Mesh`, `Camera`, `Light`, `Armature`).
- `modifiers` (`ObjectModifiers` collection): Stack of modifiers applied to this object.
- `material_slots` (`ObjectMaterialSlots` collection): List of assigned material slots.
- `parent` (`Object` or None): Parent object in hierarchy.
- `visible_get()` -> bool: Returns whether object is visible in current viewport.
- `select_set(state: bool)`: Programmatically select or deselect this object.

### bpy.types.Mesh
```python
bpy.types.Mesh(ID)
```
Mesh datablock storing polygon vertices, edges, loops, UV coordinates, and normals.

**Properties & Methods:**
- `name` (string): Mesh datablock name.
- `vertices` (`MeshVertices` collection): Vertex coordinates (`.co`), normals, and vertex group weights.
- `edges` (`MeshEdges` collection): Pair of vertex indices connecting edges.
- `polygons` (`MeshPolygons` collection): Faces, polygon normals, loop starts, material index.
- `loops` (`MeshLoops` collection): Corner vertices for face polygons (carries per-vertex UVs and split normals).
- `materials` (`IDMaterials` collection): Materials bound to this mesh data.
- `uv_layers` (`UVLoopLayers` collection): Active UV unwrapped coordinate channels.
- `color_attributes` (`AttributeGroup`): Vertex colors and attribute data channels.
- `from_pydata(vertices, edges, faces)`: Build complete mesh geometry directly from Python lists of tuples.
- `update(calc_edges=False, calc_edges_loose=False)`: Refresh internal acceleration BVH structures after mutating geometry.
- `validate(verbose=False)`: Verify mesh integrity and remove invalid zero-area faces.

### bpy.types.Material
```python
bpy.types.Material(ID)
```
Surface appearance datablock defining shading, reflection, refraction, and texture maps.

**Properties:**
- `name` (string): Unique material name.
- `use_nodes` (boolean): Whether shading is driven by a shader node tree (default True in modern Blender).
- `node_tree` (`ShaderNodeTree`): Graph containing Principled BSDF, texture coordinates, and material output.
- `diffuse_color` (Color 4 floats): Fallback viewport display color.
- `blend_method` (enum in ['OPAQUE', 'CLIP', 'HASHED', 'BLEND']): Viewport transparency mode.

### bpy.types.Modifier
```python
bpy.types.Modifier(bpy_struct)
```
Base class for all modifier operations attached to an object's modifier stack.

**Properties:**
- `name` (string): Modifier name, unique on the object.
- `type` (enum): Modifier type identifier (e.g. 'SUBSURF', 'BOOLEAN', 'MIRROR', 'BEVEL', 'ARRAY', 'SOLIDIFY', 'ARMATURE', 'NODES'). Read-only.
- `show_viewport` (boolean): Enable modifier effect in 3D viewport.
- `show_render` (boolean): Enable modifier effect during final rendering.
- `show_in_editmode` (boolean): Display modified cage while in Edit Mode.
- `show_on_cage` (boolean): Adjust edit cage vertices directly to the deformed surface.
- `is_active` (boolean): Whether modifier is selected as active in the modifier panel.
- `execution_time` (float): Profiling time in seconds spent evaluating this modifier.

### bpy.types.SubsurfModifier
```python
bpy.types.SubsurfModifier(Modifier)
```
Catmull-Clark and Simple subdivision surface modifier.

- `levels` (int in [0, 11], default 1): Subdivision iterations displayed in 3D viewport.
- `render_levels` (int in [0, 11], default 2): Subdivision iterations computed for final render.
- `subdivision_type` (enum in ['CATMULL_CLARK', 'SIMPLE'], default 'CATMULL_CLARK').
- `quality` (int in [1, 10], default 3): Precision of limit surface positions.
- `boundary_smooth` (enum in ['ALL', 'PRESERVE_CORNERS'], default 'ALL').
- `uv_smooth` (enum in ['NONE', 'PRESERVE_CORNERS', 'PRESERVE_CORNERS_AND_JUNCTIONS', 'PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE', 'SMOOTH_BOUNDARIES']): Handling of UV seams during subdivision.

### bpy.types.BooleanModifier
```python
bpy.types.BooleanModifier(Modifier)
```
Constructive solid geometry (CSG) modifier.

- `operation` (enum in ['DIFFERENCE', 'UNION', 'INTERSECT'], default 'DIFFERENCE').
- `solver` (enum in ['FAST', 'EXACT'], default 'EXACT'): Exact is robust for coplanar faces; Fast is faster for simple geometry.
- `object` (`Object`): Target object used as boolean tool operand.
- `collection` (`Collection`): Target collection of operands.
- `double_threshold` (float, default 1e-6): Distance threshold for merging duplicate vertices.

### bpy.types.MirrorModifier
```python
bpy.types.MirrorModifier(Modifier)
```
Symmetrical mesh duplication modifier.

- `use_axis` (boolean array of 3): Symmetrical reflection along [X, Y, Z] axes.
- `use_clip` (boolean, default False): Prevent vertices from crossing the mirror plane.
- `use_mirror_merge` (boolean, default True): Merge vertices situated within merge threshold of mirror plane.
- `merge_threshold` (float, default 0.001): Distance threshold for boundary vertex merging.
- `mirror_object` (`Object` or None): Reference coordinate origin object.

### bpy.types.BevelModifier
```python
bpy.types.BevelModifier(Modifier)
```
Non-destructive edge and vertex beveling modifier.

- `width` (float, default 0.01): Bevel offset distance.
- `segments` (int in [1, 100], default 1): Number of segments in bevel profile.
- `affect` (enum in ['VERTICES', 'EDGES'], default 'EDGES').
- `limit_method` (enum in ['NONE', 'ANGLE', 'WEIGHT', 'VGROUP'], default 'ANGLE').
- `angle_limit` (float in radians, default 0.523599): Threshold angle (30 deg) for edge beveling.

### bpy.types.ArrayModifier
```python
bpy.types.ArrayModifier(Modifier)
```
Linear repetition modifier.

- `count` (int, default 2): Number of duplicate instances created.
- `use_relative_offset` (boolean, default True): Shift copies by multiples of object bounding box size.
- `relative_offset_displace` (Vector of 3 floats, default (1.0, 0.0, 0.0)).
- `use_constant_offset` (boolean, default False): Shift copies by fixed absolute world distances.
- `constant_offset_displace` (Vector of 3 floats).
- `offset_object` (`Object` or None): Transform each successive copy by reference object transform.

### bpy.types.SolidifyModifier
```python
bpy.types.SolidifyModifier(Modifier)
```
Gives shell and sheet meshes physical thickness.

- `thickness` (float, default 0.01): Wall thickness in meters.
- `offset` (float in [-1.0, 1.0], default -1.0): Displacement relative to normal (-1 = inward, 1 = outward).
- `use_even_offset` (boolean, default True): Maintain uniform thickness around sharp corners.
- `use_rim` (boolean, default True): Generate connecting boundary walls between front and back surfaces.

### bpy.types.ArmatureModifier
```python
bpy.types.ArmatureModifier(Modifier)
```
Deforms mesh geometry according to bone movements in an armature rig.

- `object` (`Object`): Target Armature object.
- `use_vertex_groups` (boolean, default True): Bind deformation to vertex groups named after bones.
- `use_deform_preserve_volume` (boolean, default False): Dual quaternion skinning to prevent candy-wrapper twisting.

### bpy.types.NodesModifier
```python
bpy.types.NodesModifier(Modifier)
```
Geometry Nodes modifier executing a procedural node graph.

- `node_group` (`GeometryNodeTree`): Procedural node graph assigned to the modifier.

### bpy.types.Armature
```python
bpy.types.Armature(ID)
```
Skeletal rig container.

- `bones` (`ArmatureBones` collection): Read-only rest-pose bone descriptors in Object Mode.
- `edit_bones` (`ArmatureEditBones` collection): Editable bone joints available during Edit Mode.
- `pose_position` (enum in ['POSE', 'REST'], default 'POSE'): Toggle rest pose vs animated pose.

### bpy.types.Bone
```python
bpy.types.Bone(bpy_struct)
```
Read-only rest bone structure.

- `name` (string): Unique bone name.
- `head` (Vector 3 floats): Rest position of head joint.
- `tail` (Vector 3 floats): Rest position of tail joint.
- `length` (float): Length between head and tail.
- `parent` (`Bone` or None): Hierarchy parent.

### bpy.types.EditBone
```python
bpy.types.EditBone(bpy_struct)
```
Bone definition in Armature Edit Mode.

- `name` (string): Bone name.
- `head` (Vector 3 floats): Head joint coordinate.
- `tail` (Vector 3 floats): Tail joint coordinate.
- `roll` (float in radians): Longitudinal rotation around head-to-tail axis.
- `parent` (`EditBone` or None): Hierarchy parent.
- `use_connect` (boolean): Whether head joint is welded directly to parent's tail joint.

### bpy.types.PoseBone
```python
bpy.types.PoseBone(bpy_struct)
```
Bone instance in Pose Mode used for animation, IK constraints, and deformation.

- `name` (string): Target bone name.
- `location` (Vector 3 floats): Translation offset in local bone space.
- `rotation_euler` / `rotation_quaternion`: Rotation orientation.
- `matrix` (Matrix 4x4): Evaluated pose matrix.
- `constraints` (`PoseBoneConstraints` collection): IK, Copy Transforms, and Track To constraints.

### bpy.types.Scene
```python
bpy.types.Scene(ID)
```
Scene datablock grouping collections, cameras, world lighting, and render settings.

- `camera` (`Object` or None): Active camera object used for rendering.
- `world` (`World` or None): World background radiance and HDRI lighting.
- `render` (`RenderSettings`): Resolution, fps, filepath, format, and engine choice.
- `cycles` / `eevee`: Engine-specific sample count, denoising, and ray-tracing settings.
- `frame_start` / `frame_end` / `frame_current`: Animation frame bounds and timeline cursor.

### bpy.types.Camera
```python
bpy.types.Camera(ID)
```
Optical viewpoint settings datablock.

- `type` (enum in ['PERSP', 'ORTHO', 'PANO'], default 'PERSP').
- `lens` (float, default 50.0): Focal length in millimeters.
- `ortho_scale` (float, default 6.0): Orthographic view volume width in meters.
- `sensor_width` (float, default 36.0): Sensor width in millimeters (36mm = standard 35mm full frame).
- `clip_start` / `clip_end` (float): Near and far depth clipping planes in meters.
- `dof` (`CameraDOFSettings`): Depth of field focus object, focus distance, and f-stop aperture.

### bpy.types.Light
```python
bpy.types.Light(ID)
```
Illumination source datablock.

- `type` (enum in ['POINT', 'SUN', 'SPOT', 'AREA'], default 'POINT').
- `energy` (float): Radiant power (Watts for Point/Spot/Area, Watts/m^2 for Sun).
- `color` (Color 3 floats, default (1.0, 1.0, 1.0)): Light chromaticity.
- `shadow_soft_size` (float): Radius of emitting sphere for soft contact shadows.

### bpy.types.NodeTree
```python
bpy.types.NodeTree(ID)
```
Graph structure connecting nodes together with directional links. Subclasses include `ShaderNodeTree`, `GeometryNodeTree`, and `CompositorNodeTree`.

- `nodes` (`NodeTreeNodes` collection): Nodes present in graph. `new(type)`, `remove(node)`, `clear()`.
- `links` (`NodeTreeLinks` collection): Connections between sockets. `new(input_socket, output_socket)`, `remove(link)`.

### bpy.types.Node
```python
bpy.types.Node(bpy_struct)
```
Individual operation node in a NodeTree graph.

- `name` (string): Unique node identifier.
- `label` (string): User-facing display title.
- `inputs` (`NodeInputs` collection): Input parameter sockets.
- `outputs` (`NodeOutputs` collection): Output result sockets.
- `location` (Vector 2 floats): Coordinates on node editor canvas.

### bpy.types.Collection
```python
bpy.types.Collection(ID)
```
Hierarchical organization container for objects.

- `objects` (`CollectionObjects` collection): Objects linked into this collection. `link(obj)`, `unlink(obj)`.
- `children` (`CollectionChildren` collection): Subordinate nested collections.
