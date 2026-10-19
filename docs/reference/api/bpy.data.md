# bpy.data — Main Data-block Access (Blender 4.2 LTS)

The `bpy.data` module provides direct access to every datablock loaded in the current Blender mainfile (.blend).

## Collections & Methods

### bpy.data.objects
Collection of all Object instances.
- `bpy.data.objects.new(name, object_data)`: Instantiate a new Object bound to geometry/datablock.
- `bpy.data.objects.remove(object, do_unlink=True)`: Delete an object from the file.
- `bpy.data.objects.get(name, default=None)`: Safely lookup an object by name without throwing KeyError.

### bpy.data.meshes
Collection of all Mesh datablocks.
- `bpy.data.meshes.new(name)`: Allocate an empty Mesh datablock ready for geometry.
- `bpy.data.meshes.remove(mesh, do_unlink=True)`: Delete mesh datablock.
- `bpy.data.meshes.get(name)`: Lookup mesh by name.

### bpy.data.materials
Collection of all Material datablocks.
- `bpy.data.materials.new(name)`: Allocate a new Material datablock.
- `bpy.data.materials.remove(material, do_unlink=True)`: Delete material.
- `bpy.data.materials.get(name)`: Lookup material by name.

### bpy.data.collections
Collection of all Collection containers.
- `bpy.data.collections.new(name)`: Create a new organizational collection.
- `bpy.data.collections.remove(collection, do_unlink=True)`: Delete collection.
- `bpy.data.collections.get(name)`: Lookup collection by name.

### bpy.data.scenes
Collection of all Scene datablocks.
- `bpy.data.scenes.new(name)`: Create a new scene.
- `bpy.data.scenes.remove(scene)`: Delete scene.
- `bpy.data.scenes.get(name)`: Lookup scene.

### bpy.data.cameras
Collection of all Camera optical datablocks.
- `bpy.data.cameras.new(name)`: Create a new Camera datablock.
- `bpy.data.cameras.remove(camera)`: Delete camera datablock.

### bpy.data.lights
Collection of all Light datablocks.
- `bpy.data.lights.new(name, type='POINT')`: Create a new Light datablock ('POINT', 'SUN', 'SPOT', 'AREA').
- `bpy.data.lights.remove(light)`: Delete light datablock.

### bpy.data.images
Collection of all Image textures and rendered buffers.
- `bpy.data.images.new(name, width, height, alpha=True, float_buffer=False)`: Allocate raw image buffer.
- `bpy.data.images.load(filepath, check_existing=True)`: Load an image file from disk.
- `bpy.data.images.remove(image)`: Free image buffer.

### bpy.data.node_groups
Collection of reusable node trees (`ShaderNodeTree`, `GeometryNodeTree`).
- `bpy.data.node_groups.new(name, type)`: Allocate a new procedural node group.
- `bpy.data.node_groups.remove(group)`: Delete node group.
