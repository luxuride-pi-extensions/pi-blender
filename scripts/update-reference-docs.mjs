#!/usr/bin/env node

/**
 * scripts/update-reference-docs.mjs
 *
 * Generates and refreshes curated Blender 4.2 LTS Python API reference and
 * User Manual excerpts under docs/reference/.
 *
 * Usage:
 *   node scripts/update-reference-docs.mjs          # Refresh/generate docs
 *   node scripts/update-reference-docs.mjs --check  # Validate docs presence and format
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, "..");
const DOCS_DIR = join(ROOT_DIR, "docs", "reference");
const API_DIR = join(DOCS_DIR, "api");
const MANUAL_DIR = join(DOCS_DIR, "manual");

const BLENDER_VERSION = "Blender 4.2 LTS";

// ============================================================================
// API REFERENCE CORPUS (Blender 4.2 LTS)
// ============================================================================

const API_DOCS = {
	"bpy.ops.mesh.md": `# bpy.ops.mesh — Mesh Operators (${BLENDER_VERSION})

Operators for mesh generation, topology manipulation, UV unwrapping, and geometry editing.

## Operators

### bpy.ops.mesh.primitive_cube_add
\`\`\`python
bpy.ops.mesh.primitive_cube_add(size=2.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
\`\`\`
Construct a cube mesh primitive centered at location with width, depth, and height of \`size\`.

- \`size\` (float, default 2.0): Edge length of the cube.
- \`calc_uvs\` (boolean, default True): Generate default unwrapped UV coordinates.
- \`enter_editmode\` (boolean, default False): Immediately switch to Edit Mode after creation.
- \`align\` (enum in ['WORLD', 'VIEW', 'CURSOR'], default 'WORLD'): Coordinate system alignment.
- \`location\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): World position.
- \`rotation\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Euler orientation.
- \`scale\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Initial object scale.

### bpy.ops.mesh.primitive_uv_sphere_add
\`\`\`python
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
\`\`\`
Construct a UV sphere mesh primitive.

- \`segments\` (int in [3, 100000], default 32): Number of vertical segment slices around the Z axis.
- \`ring_count\` (int in [3, 100000], default 16): Number of horizontal latitude rings from pole to pole.
- \`radius\` (float, default 1.0): Radius of the sphere in meters.
- \`calc_uvs\` (boolean, default True): Generate cylindrical/spherical unwrapped UVs.
- \`enter_editmode\` (boolean, default False): Switch to Edit Mode after adding geometry.
- \`align\` (enum in ['WORLD', 'VIEW', 'CURSOR'], default 'WORLD'): Coordinate system alignment.
- \`location\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): World position.
- \`rotation\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Euler orientation.
- \`scale\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Initial object scale.

### bpy.ops.mesh.primitive_cylinder_add
\`\`\`python
bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=1.0, depth=2.0, end_fill_type='NGON', calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
\`\`\`
Construct a cylinder mesh primitive.

- \`vertices\` (int in [3, 100000], default 32): Number of vertices around perimeter.
- \`radius\` (float, default 1.0): Radius of circular cross-section.
- \`depth\` (float, default 2.0): Height along the local Z axis.
- \`end_fill_type\` (enum in ['NOTHING', 'NGON', 'TRIFAN'], default 'NGON'): How cap ends are closed.
- \`calc_uvs\` (boolean, default True): Calculate default UV coordinates.
- \`enter_editmode\` (boolean, default False): Enter Edit Mode upon creation.
- \`align\` (enum in ['WORLD', 'VIEW', 'CURSOR'], default 'WORLD'): Coordinate system alignment.
- \`location\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): World position.
- \`rotation\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Euler orientation.
- \`scale\` (tuple of 3 floats, default (0.0, 0.0, 0.0)): Initial scale.

### bpy.ops.mesh.primitive_cone_add
\`\`\`python
bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=1.0, radius2=0.0, depth=2.0, end_fill_type='NGON', calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
\`\`\`
Construct a cone or truncated cone mesh primitive.

- \`vertices\` (int in [3, 100000], default 32): Number of vertices around perimeter.
- \`radius1\` (float, default 1.0): Radius of bottom circular base.
- \`radius2\` (float, default 0.0): Radius of top tip or circular cap (0 for pointed tip).
- \`depth\` (float, default 2.0): Height of cone along local Z axis.
- \`end_fill_type\` (enum in ['NOTHING', 'NGON', 'TRIFAN'], default 'NGON'): Cap fill type.

### bpy.ops.mesh.primitive_plane_add
\`\`\`python
bpy.ops.mesh.primitive_plane_add(size=2.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
\`\`\`
Construct a flat 2D square plane mesh with 4 vertices.

- \`size\` (float, default 2.0): Length of side.
- \`calc_uvs\` (boolean, default True): Generate UV coordinates.

### bpy.ops.mesh.primitive_circle_add
\`\`\`python
bpy.ops.mesh.primitive_circle_add(vertices=32, radius=1.0, fill_type='NOTHING', calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
\`\`\`
Construct a 2D circle mesh with optional interior surface.

- \`vertices\` (int in [3, 100000], default 32): Number of vertices along perimeter.
- \`radius\` (float, default 1.0): Radius of circle.
- \`fill_type\` (enum in ['NOTHING', 'NGON', 'TRIFAN'], default 'NOTHING'): Fill interior faces.

### bpy.ops.mesh.primitive_torus_add
\`\`\`python
bpy.ops.mesh.primitive_torus_add(align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), major_segments=48, minor_segments=12, mode='MAJOR_MINOR', major_radius=1.0, minor_radius=0.25, abso_major_rad=1.25, abso_minor_rad=0.75, generate_uvs=True)
\`\`\`
Construct a donut-shaped torus mesh primitive.

- \`major_segments\` (int in [3, 256], default 48): Segments around main ring.
- \`minor_segments\` (int in [3, 256], default 12): Segments around cross-section tube.
- \`major_radius\` (float, default 1.0): Distance from center to tube center.
- \`minor_radius\` (float, default 0.25): Radius of tube cross-section.

### bpy.ops.mesh.primitive_monkey_add
\`\`\`python
bpy.ops.mesh.primitive_monkey_add(size=2.0, calc_uvs=True, enter_editmode=False, align='WORLD', location=(0.0, 0.0, 0.0), rotation=(0.0, 0.0, 0.0), scale=(0.0, 0.0, 0.0))
\`\`\`
Construct Suzanne the monkey test geometry.

### bpy.ops.mesh.subdivide
\`\`\`python
bpy.ops.mesh.subdivide(number_cuts=1, smoothness=0.0, ngon=True, quadcorner='STRAIGHT_CUT', fractal=0.0, fractal_along_normal=0.0, seed=0)
\`\`\`
Subdivide selected edges and faces in Edit Mode.

- \`number_cuts\` (int in [1, 1000], default 1): Number of cuts added per edge.
- \`smoothness\` (float in [0.0, 1.0], default 0.0): Smooth vertices toward spherical curvature.
- \`ngon\` (boolean, default True): Allow n-gon creation on boundary cuts.

### bpy.ops.mesh.extrude_region_move
\`\`\`python
bpy.ops.mesh.extrude_region_move(MESH_OT_extrude_region=None, TRANSFORM_OT_translate=None)
\`\`\`
Extrude selected face/edge region and initiate interactive or programmatic translation transform.

### bpy.ops.mesh.bevel
\`\`\`python
bpy.ops.mesh.bevel(offset_type='OFFSET', offset=0.0, offset_pct=0.0, segments=1, profile=0.5, affect='EDGES', clamp_overlap=False, loop_slide=True, mark_seam=False, mark_sharp=False, material=-1, harden_normals=False, face_strength_mode='NONE', miter_outer='SHARP', miter_inner='SHARP', spread=0.1)
\`\`\`
Edge and vertex bevel operator for rounding or chamfering selected mesh components.

- \`offset\` (float, default 0.0): Amount to offset bevel faces.
- \`segments\` (int in [1, 1000], default 1): Number of segments in the bevel profile.
- \`affect\` (enum in ['VERTICES', 'EDGES'], default 'EDGES'): Whether to bevel vertices or edges.
- \`clamp_overlap\` (boolean, default False): Prevent beveled geometry from intersecting existing edges.

### bpy.ops.mesh.loopcut_slide
\`\`\`python
bpy.ops.mesh.loopcut_slide(MESH_OT_loopcut=None, TRANSFORM_OT_edge_slide=None)
\`\`\`
Insert an edge loop cut across quad rings and slide along existing edge rails.

### bpy.ops.mesh.inset
\`\`\`python
bpy.ops.mesh.inset(use_boundary=True, use_even_offset=True, use_relative_offset=False, use_edge_rail=False, thickness=0.0, depth=0.0, use_outset=False, use_select_inset=False, use_individual=False, use_interpolate=True)
\`\`\`
Inset selected polygonal faces inward with optional depth extrusion.

- \`thickness\` (float, default 0.0): Distance inset faces are pushed inward from boundary.
- \`depth\` (float, default 0.0): Perpendicular displacement outward or inward along face normal.
- \`use_individual\` (boolean, default False): Inset each face individually rather than as a merged island.

### bpy.ops.mesh.normals_make_consistent
\`\`\`python
bpy.ops.mesh.normals_make_consistent(inside=False)
\`\`\`
Recalculate face normals of selected faces to point consistently outward (or inward if \`inside=True\`).

### bpy.ops.mesh.select_all
\`\`\`python
bpy.ops.mesh.select_all(action='TOGGLE')
\`\`\`
Change selection state of all mesh elements in Edit Mode ('SELECT', 'DESELECT', 'INVERT', 'TOGGLE').

### bpy.ops.mesh.delete
\`\`\`python
bpy.ops.mesh.delete(type='VERT')
\`\`\`
Delete selected mesh elements ('VERT', 'EDGE', 'FACE', 'ONLY_FACE', 'EDGE_FACE').

### bpy.ops.mesh.fill
\`\`\`python
bpy.ops.mesh.fill(use_beauty=True)
\`\`\`
Fill a boundary loop of selected edges with triangles.

### bpy.ops.mesh.quads_convert_to_tris
\`\`\`python
bpy.ops.mesh.quads_convert_to_tris(quad_method='BEAUTY', ngon_method='BEAUTY')
\`\`\`
Triangulate selected polygonal faces.

### bpy.ops.mesh.tris_convert_to_quads
\`\`\`python
bpy.ops.mesh.tris_convert_to_quads(face_threshold=0.698132, shape_threshold=0.698132)
\`\`\`
Merge adjacent pairs of coplanar triangles into quads.

### bpy.ops.mesh.separate
\`\`\`python
bpy.ops.mesh.separate(type='SELECTED')
\`\`\`
Separate selected geometry into a new Object ('SELECTED', 'MATERIAL', 'LOOSE').
`,

	"bpy.ops.object.md": `# bpy.ops.object — Object Operators (${BLENDER_VERSION})

Operators for object lifecycle, modes, transformations, hierarchy parenting, and modifier stack manipulation.

## Operators

### bpy.ops.object.mode_set
\`\`\`python
bpy.ops.object.mode_set(mode='OBJECT', toggle=False)
\`\`\`
Set the current interaction mode of the active object.

- \`mode\` (enum in ['OBJECT', 'EDIT', 'SCULPT', 'VERTEX_PAINT', 'WEIGHT_PAINT', 'TEXTURE_PAINT', 'POSE'], default 'OBJECT').
- \`toggle\` (boolean, default False): Toggle mode instead of setting explicitly.

### bpy.ops.object.select_all
\`\`\`python
bpy.ops.object.select_all(action='TOGGLE')
\`\`\`
Change selection of all objects in the current view layer ('SELECT', 'DESELECT', 'INVERT', 'TOGGLE').

### bpy.ops.object.modifier_add
\`\`\`python
bpy.ops.object.modifier_add(type='SUBSURF')
\`\`\`
Add a modifier to the active object's modifier stack.

- \`type\` (enum in ['SUBSURF', 'BOOLEAN', 'MIRROR', 'BEVEL', 'ARRAY', 'SOLIDIFY', 'ARMATURE', 'DECIMATE', 'CURVE', 'NODES', ...], default 'SUBSURF').

### bpy.ops.object.modifier_apply
\`\`\`python
bpy.ops.object.modifier_apply(modifier="", report=False, merge_customdata=True, single_user=False)
\`\`\`
Bake and evaluate the named modifier into the base mesh data of the active object.

- \`modifier\` (string): Name of the modifier to apply.
- \`single_user\` (boolean, default False): Create a unique copy of mesh data if shared by multiple objects.

### bpy.ops.object.modifier_remove
\`\`\`python
bpy.ops.object.modifier_remove(modifier="", report=False)
\`\`\`
Remove the named modifier from the active object's modifier stack.

### bpy.ops.object.shade_smooth
\`\`\`python
bpy.ops.object.shade_smooth()
\`\`\`
Set mesh shading to smooth interpolation across face normals. In Blender 4.1+, auto-smooth angle threshold is managed via the "Smooth by Angle" modifier/geometry nodes.

### bpy.ops.object.shade_flat
\`\`\`python
bpy.ops.object.shade_flat()
\`\`\`
Set mesh shading to flat faceted face normals.

### bpy.ops.object.transform_apply
\`\`\`python
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True, properties=True, isolate_users=False)
\`\`\`
Bake the object's transform delta into its underlying geometry and reset transform channels to identity.

- \`location\` (boolean, default True): Reset object location to (0,0,0) and displace vertices.
- \`rotation\` (boolean, default True): Reset object rotation to 0 and rotate vertices.
- \`scale\` (boolean, default True): Reset object scale to (1,1,1) and scale vertex coordinates.

### bpy.ops.object.origin_set
\`\`\`python
bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='MEDIAN')
\`\`\`
Set object origin position.

- \`type\` (enum in ['GEOMETRY_ORIGIN', 'ORIGIN_GEOMETRY', 'ORIGIN_CURSOR', 'ORIGIN_CENTER_OF_MASS', 'ORIGIN_CENTER_OF_VOLUME']).
- \`center\` (enum in ['MEDIAN', 'BOUNDS']).

### bpy.ops.object.parent_set
\`\`\`python
bpy.ops.object.parent_set(type='OBJECT', xmirror=False, keep_transform=False)
\`\`\`
Set parent-child relationship between selected objects and active object.

- \`type\` (enum in ['OBJECT', 'ARMATURE', 'ARMATURE_NAME', 'ARMATURE_AUTO', 'ARMATURE_ENVELOPE', 'BONE', 'VERTEX', 'VERTEX_TRI']).

### bpy.ops.object.parent_clear
\`\`\`python
bpy.ops.object.parent_clear(type='CLEAR')
\`\`\`
Clear parent relationship ('CLEAR', 'CLEAR_KEEP_TRANSFORM', 'CLEAR_INVERSE').

### bpy.ops.object.join
\`\`\`python
bpy.ops.object.join()
\`\`\`
Join selected mesh objects into the active mesh object.

### bpy.ops.object.duplicate
\`\`\`python
bpy.ops.object.duplicate(linked=False, mode='TRANSLATION')
\`\`\`
Duplicate selected objects. If \`linked=True\`, duplicates share underlying mesh/curve datablocks.

### bpy.ops.object.delete
\`\`\`python
bpy.ops.object.delete(use_global=False, confirm=False)
\`\`\`
Delete selected objects from the current scene.

### bpy.ops.object.material_slot_add
\`\`\`python
bpy.ops.object.material_slot_add()
\`\`\`
Add a new empty material slot to the active object.

### bpy.ops.object.material_slot_remove
\`\`\`python
bpy.ops.object.material_slot_remove()
\`\`\`
Remove the currently active material slot from the object.

### bpy.ops.object.material_slot_assign
\`\`\`python
bpy.ops.object.material_slot_assign()
\`\`\`
Assign the material in the active slot to currently selected mesh faces in Edit Mode.
`,

	"bpy.ops.material.md": `# bpy.ops.material — Material Operators (${BLENDER_VERSION})

Operators for material slots and datablock assignment.

## Operators

### bpy.ops.material.new
\`\`\`python
bpy.ops.material.new()
\`\`\`
Create a new material and assign it to the active object's active material slot. Note that in Python scripts, \`bpy.data.materials.new(name)\` is preferred for direct programmatic control.
`,

	"bpy.ops.wm.md": `# bpy.ops.wm — Window Manager Operators (${BLENDER_VERSION})

File I/O, saving, loading, and window state management.

## Operators

### bpy.ops.wm.save_as_mainfile
\`\`\`python
bpy.ops.wm.save_as_mainfile(filepath="", check_existing=True, filter_blender=True, compress=False, relative_remap=True, copy=False)
\`\`\`
Save current Blender document to disk at \`filepath\`.

- \`filepath\` (string): Target file path ending in \`.blend\`.
- \`compress\` (boolean, default False): Use gzip compression on the .blend file.
- \`copy\` (boolean, default False): Save a copy without changing active document filename.

### bpy.ops.wm.save_mainfile
\`\`\`python
bpy.ops.wm.save_mainfile(filepath="", check_existing=True, filter_blender=True, compress=False, relative_remap=True)
\`\`\`
Save current Blender document to its current filepath.

### bpy.ops.wm.open_mainfile
\`\`\`python
bpy.ops.wm.open_mainfile(filepath="", filter_blender=True, display_type='DEFAULT', sort_method='', load_ui=True, use_scripts=True)
\`\`\`
Open a Blender document from disk.

- \`filepath\` (string): Path to \`.blend\` file.
- \`load_ui\` (boolean, default True): Load window layout stored inside the file.
- \`use_scripts\` (boolean, default True): Allow auto-execution of embedded Python scripts.

### bpy.ops.wm.read_homefile
\`\`\`python
bpy.ops.wm.read_homefile(filepath="", load_ui=True, use_empty=False)
\`\`\`
Reset session to default startup configuration.
`,

	"bpy.ops.render.md": `# bpy.ops.render — Render Operators (${BLENDER_VERSION})

Operators for invoking rendering passes and animations.

## Operators

### bpy.ops.render.render
\`\`\`python
bpy.ops.render.render(animation=False, write_still=False, use_viewport=False, layer="", scene="")
\`\`\`
Render the active scene from its active camera viewpoint.

- \`animation\` (boolean, default False): Render entire frame sequence from frame_start to frame_end.
- \`write_still\` (boolean, default False): Immediately save rendered image to scene.render.filepath.
- \`use_viewport\` (boolean, default False): Render from current 3D viewport display rather than full engine pass.
`,

	"bpy.ops.armature.md": `# bpy.ops.armature — Armature Operators (${BLENDER_VERSION})

Operators for armature skeletal rigging in Edit Mode.

## Operators

### bpy.ops.armature.bone_primitive_add
\`\`\`python
bpy.ops.armature.bone_primitive_add(name="Bone")
\`\`\`
Add a new bone to the active armature in Edit Mode.

### bpy.ops.armature.extrude_move
\`\`\`python
bpy.ops.armature.extrude_move(ARMATURE_OT_extrude=None, TRANSFORM_OT_translate=None)
\`\`\`
Extrude selected bone tips into new child bones connected at the joint.

### bpy.ops.armature.subdivide
\`\`\`python
bpy.ops.armature.subdivide(number_cuts=1)
\`\`\`
Subdivide selected bones in Edit Mode into chains of smaller bones.
`,

	"bpy.types.md": `# bpy.types — Blender Data and Struct Types (${BLENDER_VERSION})

Authoritative class reference for Blender's internal data model, objects, meshes, modifiers, and shading datablocks.

## Core Classes

### bpy.types.Object
\`\`\`python
bpy.types.Object(ID)
\`\`\`
Represents an object instance situated in 3D world space (meshes, lights, cameras, armatures, empties).

**Properties:**
- \`name\` (string): Unique object identifier within the file.
- \`type\` (enum in ['MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'ARMATURE', 'LATTICE', 'EMPTY', 'LIGHT', 'CAMERA', 'SPEAKER', 'LIGHT_PROBE', 'VOLUME', 'GPENCIL']): Datablock type.
- \`location\` (Vector of 3 floats): Object translation vector in world/parent coordinates.
- \`rotation_euler\` (Euler angles in radians): Orientation specified in XYZ order.
- \`rotation_quaternion\` (Quaternion of 4 floats): Orientation specified as quaternion (w, x, y, z).
- \`scale\` (Vector of 3 floats): Non-uniform scaling vector.
- \`dimensions\` (Vector of 3 floats): Axis-aligned bounding box size in meters.
- \`matrix_world\` (Matrix 4x4): Complete transform matrix in world space including parent hierarchy.
- \`data\` (ID): Pointer to underlying geometry or device datablock (\`Mesh\`, \`Camera\`, \`Light\`, \`Armature\`).
- \`modifiers\` (\`ObjectModifiers\` collection): Stack of modifiers applied to this object.
- \`material_slots\` (\`ObjectMaterialSlots\` collection): List of assigned material slots.
- \`parent\` (\`Object\` or None): Parent object in hierarchy.
- \`visible_get()\` -> bool: Returns whether object is visible in current viewport.
- \`select_set(state: bool)\`: Programmatically select or deselect this object.

### bpy.types.Mesh
\`\`\`python
bpy.types.Mesh(ID)
\`\`\`
Mesh datablock storing polygon vertices, edges, loops, UV coordinates, and normals.

**Properties & Methods:**
- \`name\` (string): Mesh datablock name.
- \`vertices\` (\`MeshVertices\` collection): Vertex coordinates (\`.co\`), normals, and vertex group weights.
- \`edges\` (\`MeshEdges\` collection): Pair of vertex indices connecting edges.
- \`polygons\` (\`MeshPolygons\` collection): Faces, polygon normals, loop starts, material index.
- \`loops\` (\`MeshLoops\` collection): Corner vertices for face polygons (carries per-vertex UVs and split normals).
- \`materials\` (\`IDMaterials\` collection): Materials bound to this mesh data.
- \`uv_layers\` (\`UVLoopLayers\` collection): Active UV unwrapped coordinate channels.
- \`color_attributes\` (\`AttributeGroup\`): Vertex colors and attribute data channels.
- \`from_pydata(vertices, edges, faces)\`: Build complete mesh geometry directly from Python lists of tuples.
- \`update(calc_edges=False, calc_edges_loose=False)\`: Refresh internal acceleration BVH structures after mutating geometry.
- \`validate(verbose=False)\`: Verify mesh integrity and remove invalid zero-area faces.

### bpy.types.Material
\`\`\`python
bpy.types.Material(ID)
\`\`\`
Surface appearance datablock defining shading, reflection, refraction, and texture maps.

**Properties:**
- \`name\` (string): Unique material name.
- \`use_nodes\` (boolean): Whether shading is driven by a shader node tree (default True in modern Blender).
- \`node_tree\` (\`ShaderNodeTree\`): Graph containing Principled BSDF, texture coordinates, and material output.
- \`diffuse_color\` (Color 4 floats): Fallback viewport display color.
- \`blend_method\` (enum in ['OPAQUE', 'CLIP', 'HASHED', 'BLEND']): Viewport transparency mode.

### bpy.types.Modifier
\`\`\`python
bpy.types.Modifier(bpy_struct)
\`\`\`
Base class for all modifier operations attached to an object's modifier stack.

**Properties:**
- \`name\` (string): Modifier name, unique on the object.
- \`type\` (enum): Modifier type identifier (e.g. 'SUBSURF', 'BOOLEAN', 'MIRROR', 'BEVEL', 'ARRAY', 'SOLIDIFY', 'ARMATURE', 'NODES'). Read-only.
- \`show_viewport\` (boolean): Enable modifier effect in 3D viewport.
- \`show_render\` (boolean): Enable modifier effect during final rendering.
- \`show_in_editmode\` (boolean): Display modified cage while in Edit Mode.
- \`show_on_cage\` (boolean): Adjust edit cage vertices directly to the deformed surface.
- \`is_active\` (boolean): Whether modifier is selected as active in the modifier panel.
- \`execution_time\` (float): Profiling time in seconds spent evaluating this modifier.

### bpy.types.SubsurfModifier
\`\`\`python
bpy.types.SubsurfModifier(Modifier)
\`\`\`
Catmull-Clark and Simple subdivision surface modifier.

- \`levels\` (int in [0, 11], default 1): Subdivision iterations displayed in 3D viewport.
- \`render_levels\` (int in [0, 11], default 2): Subdivision iterations computed for final render.
- \`subdivision_type\` (enum in ['CATMULL_CLARK', 'SIMPLE'], default 'CATMULL_CLARK').
- \`quality\` (int in [1, 10], default 3): Precision of limit surface positions.
- \`boundary_smooth\` (enum in ['ALL', 'PRESERVE_CORNERS'], default 'ALL').
- \`uv_smooth\` (enum in ['NONE', 'PRESERVE_CORNERS', 'PRESERVE_CORNERS_AND_JUNCTIONS', 'PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE', 'SMOOTH_BOUNDARIES']): Handling of UV seams during subdivision.

### bpy.types.BooleanModifier
\`\`\`python
bpy.types.BooleanModifier(Modifier)
\`\`\`
Constructive solid geometry (CSG) modifier.

- \`operation\` (enum in ['DIFFERENCE', 'UNION', 'INTERSECT'], default 'DIFFERENCE').
- \`solver\` (enum in ['FAST', 'EXACT'], default 'EXACT'): Exact is robust for coplanar faces; Fast is faster for simple geometry.
- \`object\` (\`Object\`): Target object used as boolean tool operand.
- \`collection\` (\`Collection\`): Target collection of operands.
- \`double_threshold\` (float, default 1e-6): Distance threshold for merging duplicate vertices.

### bpy.types.MirrorModifier
\`\`\`python
bpy.types.MirrorModifier(Modifier)
\`\`\`
Symmetrical mesh duplication modifier.

- \`use_axis\` (boolean array of 3): Symmetrical reflection along [X, Y, Z] axes.
- \`use_clip\` (boolean, default False): Prevent vertices from crossing the mirror plane.
- \`use_mirror_merge\` (boolean, default True): Merge vertices situated within merge threshold of mirror plane.
- \`merge_threshold\` (float, default 0.001): Distance threshold for boundary vertex merging.
- \`mirror_object\` (\`Object\` or None): Reference coordinate origin object.

### bpy.types.BevelModifier
\`\`\`python
bpy.types.BevelModifier(Modifier)
\`\`\`
Non-destructive edge and vertex beveling modifier.

- \`width\` (float, default 0.01): Bevel offset distance.
- \`segments\` (int in [1, 100], default 1): Number of segments in bevel profile.
- \`affect\` (enum in ['VERTICES', 'EDGES'], default 'EDGES').
- \`limit_method\` (enum in ['NONE', 'ANGLE', 'WEIGHT', 'VGROUP'], default 'ANGLE').
- \`angle_limit\` (float in radians, default 0.523599): Threshold angle (30 deg) for edge beveling.

### bpy.types.ArrayModifier
\`\`\`python
bpy.types.ArrayModifier(Modifier)
\`\`\`
Linear repetition modifier.

- \`count\` (int, default 2): Number of duplicate instances created.
- \`use_relative_offset\` (boolean, default True): Shift copies by multiples of object bounding box size.
- \`relative_offset_displace\` (Vector of 3 floats, default (1.0, 0.0, 0.0)).
- \`use_constant_offset\` (boolean, default False): Shift copies by fixed absolute world distances.
- \`constant_offset_displace\` (Vector of 3 floats).
- \`offset_object\` (\`Object\` or None): Transform each successive copy by reference object transform.

### bpy.types.SolidifyModifier
\`\`\`python
bpy.types.SolidifyModifier(Modifier)
\`\`\`
Gives shell and sheet meshes physical thickness.

- \`thickness\` (float, default 0.01): Wall thickness in meters.
- \`offset\` (float in [-1.0, 1.0], default -1.0): Displacement relative to normal (-1 = inward, 1 = outward).
- \`use_even_offset\` (boolean, default True): Maintain uniform thickness around sharp corners.
- \`use_rim\` (boolean, default True): Generate connecting boundary walls between front and back surfaces.

### bpy.types.ArmatureModifier
\`\`\`python
bpy.types.ArmatureModifier(Modifier)
\`\`\`
Deforms mesh geometry according to bone movements in an armature rig.

- \`object\` (\`Object\`): Target Armature object.
- \`use_vertex_groups\` (boolean, default True): Bind deformation to vertex groups named after bones.
- \`use_deform_preserve_volume\` (boolean, default False): Dual quaternion skinning to prevent candy-wrapper twisting.

### bpy.types.NodesModifier
\`\`\`python
bpy.types.NodesModifier(Modifier)
\`\`\`
Geometry Nodes modifier executing a procedural node graph.

- \`node_group\` (\`GeometryNodeTree\`): Procedural node graph assigned to the modifier.

### bpy.types.Armature
\`\`\`python
bpy.types.Armature(ID)
\`\`\`
Skeletal rig container.

- \`bones\` (\`ArmatureBones\` collection): Read-only rest-pose bone descriptors in Object Mode.
- \`edit_bones\` (\`ArmatureEditBones\` collection): Editable bone joints available during Edit Mode.
- \`pose_position\` (enum in ['POSE', 'REST'], default 'POSE'): Toggle rest pose vs animated pose.

### bpy.types.Bone
\`\`\`python
bpy.types.Bone(bpy_struct)
\`\`\`
Read-only rest bone structure.

- \`name\` (string): Unique bone name.
- \`head\` (Vector 3 floats): Rest position of head joint.
- \`tail\` (Vector 3 floats): Rest position of tail joint.
- \`length\` (float): Length between head and tail.
- \`parent\` (\`Bone\` or None): Hierarchy parent.

### bpy.types.EditBone
\`\`\`python
bpy.types.EditBone(bpy_struct)
\`\`\`
Bone definition in Armature Edit Mode.

- \`name\` (string): Bone name.
- \`head\` (Vector 3 floats): Head joint coordinate.
- \`tail\` (Vector 3 floats): Tail joint coordinate.
- \`roll\` (float in radians): Longitudinal rotation around head-to-tail axis.
- \`parent\` (\`EditBone\` or None): Hierarchy parent.
- \`use_connect\` (boolean): Whether head joint is welded directly to parent's tail joint.

### bpy.types.PoseBone
\`\`\`python
bpy.types.PoseBone(bpy_struct)
\`\`\`
Bone instance in Pose Mode used for animation, IK constraints, and deformation.

- \`name\` (string): Target bone name.
- \`location\` (Vector 3 floats): Translation offset in local bone space.
- \`rotation_euler\` / \`rotation_quaternion\`: Rotation orientation.
- \`matrix\` (Matrix 4x4): Evaluated pose matrix.
- \`constraints\` (\`PoseBoneConstraints\` collection): IK, Copy Transforms, and Track To constraints.

### bpy.types.Scene
\`\`\`python
bpy.types.Scene(ID)
\`\`\`
Scene datablock grouping collections, cameras, world lighting, and render settings.

- \`camera\` (\`Object\` or None): Active camera object used for rendering.
- \`world\` (\`World\` or None): World background radiance and HDRI lighting.
- \`render\` (\`RenderSettings\`): Resolution, fps, filepath, format, and engine choice.
- \`cycles\` / \`eevee\`: Engine-specific sample count, denoising, and ray-tracing settings.
- \`frame_start\` / \`frame_end\` / \`frame_current\`: Animation frame bounds and timeline cursor.

### bpy.types.Camera
\`\`\`python
bpy.types.Camera(ID)
\`\`\`
Optical viewpoint settings datablock.

- \`type\` (enum in ['PERSP', 'ORTHO', 'PANO'], default 'PERSP').
- \`lens\` (float, default 50.0): Focal length in millimeters.
- \`ortho_scale\` (float, default 6.0): Orthographic view volume width in meters.
- \`sensor_width\` (float, default 36.0): Sensor width in millimeters (36mm = standard 35mm full frame).
- \`clip_start\` / \`clip_end\` (float): Near and far depth clipping planes in meters.
- \`dof\` (\`CameraDOFSettings\`): Depth of field focus object, focus distance, and f-stop aperture.

### bpy.types.Light
\`\`\`python
bpy.types.Light(ID)
\`\`\`
Illumination source datablock.

- \`type\` (enum in ['POINT', 'SUN', 'SPOT', 'AREA'], default 'POINT').
- \`energy\` (float): Radiant power (Watts for Point/Spot/Area, Watts/m^2 for Sun).
- \`color\` (Color 3 floats, default (1.0, 1.0, 1.0)): Light chromaticity.
- \`shadow_soft_size\` (float): Radius of emitting sphere for soft contact shadows.

### bpy.types.NodeTree
\`\`\`python
bpy.types.NodeTree(ID)
\`\`\`
Graph structure connecting nodes together with directional links. Subclasses include \`ShaderNodeTree\`, \`GeometryNodeTree\`, and \`CompositorNodeTree\`.

- \`nodes\` (\`NodeTreeNodes\` collection): Nodes present in graph. \`new(type)\`, \`remove(node)\`, \`clear()\`.
- \`links\` (\`NodeTreeLinks\` collection): Connections between sockets. \`new(input_socket, output_socket)\`, \`remove(link)\`.

### bpy.types.Node
\`\`\`python
bpy.types.Node(bpy_struct)
\`\`\`
Individual operation node in a NodeTree graph.

- \`name\` (string): Unique node identifier.
- \`label\` (string): User-facing display title.
- \`inputs\` (\`NodeInputs\` collection): Input parameter sockets.
- \`outputs\` (\`NodeOutputs\` collection): Output result sockets.
- \`location\` (Vector 2 floats): Coordinates on node editor canvas.

### bpy.types.Collection
\`\`\`python
bpy.types.Collection(ID)
\`\`\`
Hierarchical organization container for objects.

- \`objects\` (\`CollectionObjects\` collection): Objects linked into this collection. \`link(obj)\`, \`unlink(obj)\`.
- \`children\` (\`CollectionChildren\` collection): Subordinate nested collections.
`,

	"bpy.data.md": `# bpy.data — Main Data-block Access (${BLENDER_VERSION})

The \`bpy.data\` module provides direct access to every datablock loaded in the current Blender mainfile (.blend).

## Collections & Methods

### bpy.data.objects
Collection of all Object instances.
- \`bpy.data.objects.new(name, object_data)\`: Instantiate a new Object bound to geometry/datablock.
- \`bpy.data.objects.remove(object, do_unlink=True)\`: Delete an object from the file.
- \`bpy.data.objects.get(name, default=None)\`: Safely lookup an object by name without throwing KeyError.

### bpy.data.meshes
Collection of all Mesh datablocks.
- \`bpy.data.meshes.new(name)\`: Allocate an empty Mesh datablock ready for geometry.
- \`bpy.data.meshes.remove(mesh, do_unlink=True)\`: Delete mesh datablock.
- \`bpy.data.meshes.get(name)\`: Lookup mesh by name.

### bpy.data.materials
Collection of all Material datablocks.
- \`bpy.data.materials.new(name)\`: Allocate a new Material datablock.
- \`bpy.data.materials.remove(material, do_unlink=True)\`: Delete material.
- \`bpy.data.materials.get(name)\`: Lookup material by name.

### bpy.data.collections
Collection of all Collection containers.
- \`bpy.data.collections.new(name)\`: Create a new organizational collection.
- \`bpy.data.collections.remove(collection, do_unlink=True)\`: Delete collection.
- \`bpy.data.collections.get(name)\`: Lookup collection by name.

### bpy.data.scenes
Collection of all Scene datablocks.
- \`bpy.data.scenes.new(name)\`: Create a new scene.
- \`bpy.data.scenes.remove(scene)\`: Delete scene.
- \`bpy.data.scenes.get(name)\`: Lookup scene.

### bpy.data.cameras
Collection of all Camera optical datablocks.
- \`bpy.data.cameras.new(name)\`: Create a new Camera datablock.
- \`bpy.data.cameras.remove(camera)\`: Delete camera datablock.

### bpy.data.lights
Collection of all Light datablocks.
- \`bpy.data.lights.new(name, type='POINT')\`: Create a new Light datablock ('POINT', 'SUN', 'SPOT', 'AREA').
- \`bpy.data.lights.remove(light)\`: Delete light datablock.

### bpy.data.images
Collection of all Image textures and rendered buffers.
- \`bpy.data.images.new(name, width, height, alpha=True, float_buffer=False)\`: Allocate raw image buffer.
- \`bpy.data.images.load(filepath, check_existing=True)\`: Load an image file from disk.
- \`bpy.data.images.remove(image)\`: Free image buffer.

### bpy.data.node_groups
Collection of reusable node trees (\`ShaderNodeTree\`, \`GeometryNodeTree\`).
- \`bpy.data.node_groups.new(name, type)\`: Allocate a new procedural node group.
- \`bpy.data.node_groups.remove(group)\`: Delete node group.
`,

	"bpy.context.md": `# bpy.context — Execution Context Access (${BLENDER_VERSION})

The \`bpy.context\` module provides read-only properties describing the active state, active selection, scene, window, and workspace.

## Context Properties

### bpy.context.active_object
The currently active Object in the active view layer (or \`None\` if nothing is active).
\`\`\`python
obj = bpy.context.active_object
if obj and obj.type == 'MESH':
    print("Active mesh:", obj.name)
\`\`\`

### bpy.context.selected_objects
List of all selected Object instances in the active view layer.

### bpy.context.scene
The currently active \`bpy.types.Scene\` datablock.

### bpy.context.view_layer
The active \`bpy.types.ViewLayer\` datablock.

### bpy.context.mode
Current interaction mode string:
- \`'OBJECT'\`: Object Mode.
- \`'EDIT_MESH'\`: Mesh Edit Mode.
- \`'POSE'\`: Armature Pose Mode.
- \`'SCULPT'\`: Sculpt Mode.
- \`'PAINT_WEIGHT'\`: Weight Paint Mode.
- \`'PAINT_VERTEX'\`: Vertex Paint Mode.
- \`'PAINT_TEXTURE'\`: Texture Paint Mode.

### bpy.context.workspace
The active \`bpy.types.Workspace\` layout.

### bpy.context.area / bpy.context.region
The active window Area (e.g. 'VIEW_3D', 'PROPERTIES') and Region ('WINDOW', 'UI', 'HEADER') when invoked in interactive contexts.

## Context Overrides

In Blender 3.2+ and 4.x, operators requiring a specific context must be invoked using \`bpy.context.temp_override(...)\` as a Python context manager rather than passing context dictionary arguments:

\`\`\`python
# Modern Blender 4.2 LTS context override pattern:
with bpy.context.temp_override(active_object=target_obj, selected_objects=[target_obj]):
    bpy.ops.object.modifier_apply(modifier="Subsurf")
\`\`\`
`,

	"bpy.props.md": `# bpy.props — Custom Property Definitions (${BLENDER_VERSION})

The \`bpy.props\` module defines typed property definitions for custom Operator parameters, Add-on preferences, and UI property groups.

## Property Types

### bpy.props.StringProperty
\`\`\`python
bpy.props.StringProperty(name="", description="", default="", maxlen=0, options={'ANIMATABLE'}, subtype='NONE', update=None, get=None, set=None)
\`\`\`
Text string property.

### bpy.props.IntProperty
\`\`\`python
bpy.props.IntProperty(name="", description="", default=0, min=-2**31, max=2**31-1, soft_min=-2**31, soft_max=2**31-1, step=1, options={'ANIMATABLE'}, subtype='NONE', update=None, get=None, set=None)
\`\`\`
Signed integer property with optional hard/soft clamping bounds.

### bpy.props.FloatProperty
\`\`\`python
bpy.props.FloatProperty(name="", description="", default=0.0, min=-3.402823e+38, max=3.402823e+38, soft_min=-3.402823e+38, soft_max=3.402823e+38, step=3, precision=3, options={'ANIMATABLE'}, subtype='NONE', unit='NONE', update=None, get=None, set=None)
\`\`\`
Floating-point number with precision formatting and physics unit support ('LENGTH', 'AREA', 'VOLUME', 'ROTATION', 'TIME', 'VELOCITY', 'ACCELERATION', 'MASS', 'CAMERA', 'POWER').

### bpy.props.BoolProperty
\`\`\`python
bpy.props.BoolProperty(name="", description="", default=False, options={'ANIMATABLE'}, subtype='NONE', update=None, get=None, set=None)
\`\`\`
Boolean toggle switch property.

### bpy.props.EnumProperty
\`\`\`python
bpy.props.EnumProperty(items, name="", description="", default=None, options={'ANIMATABLE'}, update=None, get=None, set=None)
\`\`\`
Enumeration dropdown selection. \`items\` is a sequence of \`(identifier, name, description, icon, number)\` tuples.

### bpy.props.PointerProperty
\`\`\`python
bpy.props.PointerProperty(type=None, name="", description="", options={'ANIMATABLE'}, update=None)
\`\`\`
Reference pointer to a datablock or custom PropertyGroup.

### bpy.props.CollectionProperty
\`\`\`python
bpy.props.CollectionProperty(type=None, name="", description="", options={'ANIMATABLE'})
\`\`\`
List collection of PropertyGroup elements.

### bpy.props.FloatVectorProperty
\`\`\`python
bpy.props.FloatVectorProperty(name="", description="", default=(0.0, 0.0, 0.0), min=-3.402823e+38, max=3.402823e+38, soft_min=-3.402823e+38, soft_max=3.402823e+38, step=3, precision=3, options={'ANIMATABLE'}, subtype='NONE', size=3, unit='NONE', update=None, get=None, set=None)
\`\`\`
Vector array of floating point numbers (size 2 to 32, default 3). Subtypes: 'COLOR', 'TRANSLATION', 'DIRECTION', 'VELOCITY', 'ACCELERATION', 'EULER', 'QUATERNION', 'XYZ'.
`,
};

// ============================================================================
// USER MANUAL EXCERPTS CORPUS (Blender 4.2 LTS)
// ============================================================================

const MANUAL_DOCS = {
	"modeling.md": `# Modeling Guide (${BLENDER_VERSION})

Core modeling principles, tools, topology best practices, and workflow conventions in Blender 4.2.

## Mesh Topology Fundamentals

### Quad-Dominant Topology
- For deformation and subdivision, clean quad meshes are essential. Quads subdivide predictably, deform cleanly along skeletal joints, and support continuous edge loops.
- Avoid n-gons (>4 sides) on deforming surfaces or curved geometry; they produce unpredictable triangulation, shading artifacts, and pinch points under subdivision surface modifiers.
- Triangles are acceptable on rigid, coplanar surfaces (e.g. mechanical parts, planar architectural walls), but avoid them across curved organic silhouettes.

### Poles and Edge Flow
- Standard vertices have 4 intersecting edges.
- **E-poles (5 edges)** and **N-poles (3 edges)** redirect edge loops and allow transitions between regions of different mesh density.
- Keep poles away from sharp bending hinges (e.g. elbows, knees, eyelid rims) where deformation stresses will produce pinching.

## Core Modeling Workflows

### Primitives to Form
1. Start from basic primitives (\`primitive_cube_add\`, \`primitive_cylinder_add\`, \`primitive_uv_sphere_add\`) matching the general volume and proportion of the target asset.
2. In Edit Mode, block primary volumes before detailing. Use \`extrude_region_move\` along primary axes to build limbs, necks, or extensions.
3. Use \`loopcut_slide\` to add supportive edge loops where forms change curvature.
4. Use \`inset\` on faces to create perimeter boundary loops before recessing or extruding details.

### Beveling and Edge Hardening
- Pure razor-sharp digital edges look artificial in physical lighting. Always add subtle bevels to catch specular highlights.
- Use the **Bevel Modifier** with \`limit_method='ANGLE'\` (threshold around 30 degrees) for non-destructive edge beveling.

### Smooth Shading & Normal Management in 4.2 LTS
- In Blender 4.1 and 4.2 LTS, the legacy Auto Smooth mesh toggle was replaced by modifier-based normal handling:
  - Add the **Smooth by Angle** modifier (or run \`bpy.ops.object.shade_smooth()\`).
  - Use \`bpy.ops.mesh.normals_make_consistent(inside=False)\` to ensure all face normal vectors point outward. Inconsistent normals cause flipped dark patches and inside-out boolean operations.
`,

	"modifiers.md": `# Modifiers Guide (${BLENDER_VERSION})

Overview of non-destructive modifiers, evaluation order, and configuration best practices in Blender 4.2.

## Evaluation Stack Order

Modifiers execute sequentially from top to bottom of the object's modifier stack. The output geometry of each modifier becomes the input geometry of the next:

1. **Mirror Modifier**: Place first in the stack so procedural modeling works symmetrically across the origin plane. Ensure \`use_clip=True\` and \`use_mirror_merge=True\` so center-line vertices stay welded.
2. **Generative / Deconstructive Modifiers**: Boolean, Array, Solidify, Bevel.
3. **Deformation Modifiers**: Armature modifier or Curve modifier. Deforming a lower-density mesh before subdivision is significantly more performant than deforming millions of subdivided polygons.
4. **Subdivision Surface (Subsurf)**: Place near or at the very end of the stack. Subsurf rounds out and smooths the final evaluated geometry.

## Essential Modifiers

### Subdivision Surface (SubsurfModifier)
- Evaluates Catmull-Clark subdivision surfaces.
- Keep viewport \`levels\` at 1 or 2 for responsive interactivity; set \`render_levels\` to 2 or 3 for final high-fidelity production rendering.
- Avoid setting viewport levels above 3 unless necessary, as polygon counts scale by $4^N$.

### Mirror (MirrorModifier)
- Mirrors geometry across local X, Y, or Z axis.
- Clipping prevents vertices near the mirror plane from being pulled apart or overlapping.
- \`merge_threshold\` welds boundary seam vertices together seamlessly.

### Boolean (BooleanModifier)
- Evaluates constructive solid geometry: Difference, Union, Intersect.
- **Exact Solver**: Handles coplanar faces, overlapping coplanar coplanar shells, and manifold solids with high precision.
- **Fast Solver**: High-performance solver best suited for simple non-intersecting shapes.
- Requirements for clean booleans: Both operands should be closed, 2-manifold meshes with consistent outward-pointing normals.

### Bevel (BevelModifier)
- Rounds edges without destructively altering underlying base mesh topology.
- Combine with \`limit_method='ANGLE'\` (default 30°) or vertex groups for localized edge chamfering.
- Enable \`harden_normals=True\` to eliminate shading gradient artifacts across adjacent flat faces.

### Solidify (SolidifyModifier)
- Adds uniform wall thickness to single-sided sheet meshes or open shells (e.g. clothing, pottery, architectural walls).
- Enable \`use_even_offset=True\` to maintain constant wall thickness through corners.

### Array (ArrayModifier)
- Duplicates geometry in regular linear or offset increments.
- Combine with an empty reference object (\`use_object_offset=True\`) to create radial circular arrays (e.g. gear teeth, spokes, stairs).
`,

	"rigging.md": `# Rigging and Armatures Guide (${BLENDER_VERSION})

Skeletal rigs, bone hierarchies, skinning, and inverse kinematics (IK) in Blender 4.2.

## Armature Structure

An Armature object contains a skeletal structure made of bones:
- **Head**: Base joint of the bone.
- **Tail**: Tip joint of the bone.
- **Roll**: Axial rotation of the bone along its head-to-tail vector. Consistent bone roll is critical for predictable rotational axis orientation in Pose Mode.

### Interaction Modes
- **Edit Mode**: Defines rest pose morphology. Reposition bone head and tail coordinates, construct parent hierarchies (\`use_connect=True\` or \`False\`), adjust roll angles.
- **Pose Mode**: Defines interactive posing, keyframe animation, and constraint evaluation. Bone rest positions are not altered.

## Skinning Mesh to Armature

### Parenting with Automatic Weights
1. Ensure both mesh and armature share a common origin and scale is applied: \`bpy.ops.object.transform_apply(scale=True, rotation=True)\`.
2. Select the mesh object first, then Shift-select the armature object (armature must be active).
3. Run \`bpy.ops.object.parent_set(type='ARMATURE_AUTO')\`.
4. Blender creates:
   - An \`ArmatureModifier\` on the mesh object bound to the armature.
   - Deform vertex groups on the mesh corresponding exactly to each bone's name.
   - Smooth heat-map weight distribution across vertex vertices.

## Inverse Kinematics (IK)

Inverse Kinematics calculates intermediate bone rotations backwards from an end-effector target:
- Add an **IK Constraint** to the lower bone in a chain (e.g. Shin / Forearm):
  - \`target\`: Armature object.
  - \`subtarget\`: IK controller bone (e.g. Foot_IK, Hand_IK).
  - \`chain_count\`: Number of ancestor bones influenced (e.g. 2 for Thigh + Shin).
  - \`pole_target\`: Knee or Elbow hint target bone to prevent knee/elbow flipping.
  - \`pole_angle\`: Offset angle in radians aligning the knee bend direction to the pole bone.
`,

	"shading.md": `# Shading and Materials Guide (${BLENDER_VERSION})

Material creation, Principled BSDF v2, shader node graphs, and texture mapping in Blender 4.2.

## Principled BSDF (Blender 4.x Architecture)

The Principled BSDF physically-based shader provides an energy-conserving, unified material model:

### Key Sockets
- **Base Color**: Albedo diffuse reflection color for dielectrics; specular reflection color for metals.
- **Metallic**: 0.0 for dielectric materials (wood, stone, plastic, skin, cloth); 1.0 for conductive metals (gold, copper, iron, chrome). Values between 0 and 1 represent mixed surfaces like dusty metal.
- **Roughness**: Microfacet roughness. 0.0 is mirror-sharp specular reflection; 1.0 is diffuse, matte dispersion.
- **IOR (Index of Refraction)**: Default 1.45 (standard plastics/glass). Water is 1.333, diamond is 2.417.
- **Transmission**: 1.0 for refractive transparent materials (glass, liquids).
- **Coat**: Secondary clear reflective lacquer layer on top of base material (e.g. car paint, varnished wood).
- **Emission Color & Strength**: Self-illumination emission contributing light to the scene.
- **Normal**: Connects to the output of a \`ShaderNodeNormalMap\` or \`ShaderNodeBump\`.

## Constructing Shader Node Networks

Programmatic Python construction pattern:
\`\`\`python
mat = bpy.data.materials.new(name="PBR_Material")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links

nodes.clear() # remove default Principled and Output

output_node = nodes.new(type="ShaderNodeOutputMaterial")
bsdf_node = nodes.new(type="ShaderNodeBsdfPrincipled")
tex_node = nodes.new(type="ShaderNodeTexImage")
norm_node = nodes.new(type="ShaderNodeNormalMap")

# Link Base Color
links.new(tex_node.outputs["Color"], bsdf_node.inputs["Base Color"])
# Link Normal Map
links.new(norm_node.outputs["Normal"], bsdf_node.inputs["Normal"])
# Link Shader to Output
links.new(bsdf_node.outputs["BSDF"], output_node.inputs["Surface"])
\`\`\`

## Texture Color Spaces
- **sRGB**: Used strictly for color data that represents visual hue (Base Color, Subsurface Color).
- **Non-Color**: Mandatory for numerical vector and scalar maps (Normal maps, Roughness maps, Metallic maps, Displacement). Reading a normal map as sRGB distorts vector normals and ruins lighting fidelity.
`,

	"render.md": `# Render Engines and Setup Guide (${BLENDER_VERSION})

EEVEE-Next, Cycles, camera settings, lighting setups, and color management in Blender 4.2.

## Render Engines in 4.2 LTS

### EEVEE-Next
Blender 4.2 introduces the upgraded EEVEE-Next real-time rendering architecture:
- Screen-space and hardware raytracing for ambient occlusion, reflections, and shadows.
- Fast evaluation, highly suited for real-time viewport feedback and rapid worker iterations.

### Cycles
- Physically-based path tracer.
- Supports global illumination, multi-bounce indirect lighting, true volume scattering, and microfacet transmission.
- Uses OpenImageDenoise (OIDN) or OptiX for denoising low-sample renders.

## Three-Point Lighting Setup

The classic studio setup balances form, contrast, and depth:
1. **Key Light**: Primary illumination source angled 45° to the side and 45° above the subject. Establishes primary shadows and shape definition.
2. **Fill Light**: Placed opposite the Key light at lower intensity (typically 25%–50% of Key power). Softens harsh shadows and reveals detail without creating competing double shadows.
3. **Rim / Back Light**: Positioned behind the subject facing towards the camera. Separates the subject's silhouette from the background with a crisp edge highlight.

Tip: For distance-independent irradiance across varying prop scales, use **SUN** lamps rather than point or area lights with square-distance falloff.

## Color Management: AgX

- Blender 4.0+ defaults to the **AgX** view transform, replacing legacy Filmic.
- AgX handles saturated, intense lighting highlights without harsh clipped color shifts (e.g. bright lights turning yellow instead of pure white).
`,

	"geometry_nodes.md": `# Geometry Nodes Procedural Guide (${BLENDER_VERSION})

Procedural geometry, node fields, curve generation, instancing, and attribute pipelines in Blender 4.2.

## Core Geometry Nodes Concepts

### Geometries vs Fields
- **Geometry Sockets (Round Green)**: Concrete geometric meshes, curves, point clouds, or instances passing through the node graph.
- **Field Sockets (Diamond)**: Functions or equations evaluated per-element (per-vertex, per-edge, per-face) within the context of a geometry flow.

## Common Procedural Patterns

### 1. Curve to Tube / Pipe
Convert a 1D spline curve into a 3D tubular mesh surface:
\`\`\`
[Curve Input] -> [Curve to Mesh] -> [Mesh Output]
                        ^
[Curve Circle Primitive] | (Profile Curve)
\`\`\`
- Node: \`GeometryNodeCurveToMesh\`
- Profile input: \`GeometryNodeCurvePrimitiveCircle\` with configurable radius.

### 2. Point Distribution and Instancing
Scatter multiple object instances across a surface (e.g. foliage, debris, rivets):
\`\`\`
[Mesh Surface] -> [Distribute Points on Faces] -> [Instance on Points] -> [Realize Instances]
                                                        ^
                                              [Instance Object/Mesh]
\`\`\`
- \`GeometryNodeDistributePointsOnFaces\` (Poisson Disk method guarantees minimum distance between scattered points).
- \`GeometryNodeInstanceOnPoints\`.
- \`GeometryNodeRealizeInstances\`: Converts virtual lightweight instances into real geometry, required if subsequent modifiers or boolean operations need to evaluate the mesh.

### 3. Setting Procedural Materials
- \`GeometryNodeSetMaterial\`: Assigns a specific Material datablock directly to procedural geometry within the node tree.
`,
};

// ============================================================================
// MAIN EXECUTION
// ============================================================================

export function ensureDirectories() {
	mkdirSync(API_DIR, { recursive: true });
	mkdirSync(MANUAL_DIR, { recursive: true });
}

export function writeReferenceDocs() {
	ensureDirectories();

	console.log(`[update-reference-docs] Updating Blender 4.2 LTS API reference corpus...`);
	let apiCount = 0;
	for (const [filename, content] of Object.entries(API_DOCS)) {
		const targetPath = join(API_DIR, filename);
		writeFileSync(targetPath, content.trim() + "\n", "utf8");
		apiCount++;
	}
	console.log(`[update-reference-docs] Wrote ${apiCount} API reference files to ${API_DIR}`);

	console.log(`[update-reference-docs] Updating Blender 4.2 LTS Manual excerpts corpus...`);
	let manualCount = 0;
	for (const [filename, content] of Object.entries(MANUAL_DOCS)) {
		const targetPath = join(MANUAL_DIR, filename);
		writeFileSync(targetPath, content.trim() + "\n", "utf8");
		manualCount++;
	}
	console.log(`[update-reference-docs] Wrote ${manualCount} Manual excerpt files to ${MANUAL_DIR}`);
}

export function checkReferenceDocs() {
	console.log(`[update-reference-docs] Validating reference documentation...`);
	const noticePath = join(DOCS_DIR, "NOTICE");
	const licensePath = join(DOCS_DIR, "LICENSE.blender-docs");

	if (!existsSync(noticePath)) {
		throw new Error(`Missing ${noticePath}`);
	}
	if (!existsSync(licensePath)) {
		throw new Error(`Missing ${licensePath}`);
	}

	for (const filename of Object.keys(API_DOCS)) {
		const targetPath = join(API_DIR, filename);
		if (!existsSync(targetPath)) {
			throw new Error(`Missing API reference file: ${targetPath}`);
		}
		const content = readFileSync(targetPath, "utf8");
		if (content.length < 50) {
			throw new Error(`API reference file is suspiciously small: ${targetPath}`);
		}
	}

	for (const filename of Object.keys(MANUAL_DOCS)) {
		const targetPath = join(MANUAL_DIR, filename);
		if (!existsSync(targetPath)) {
			throw new Error(`Missing Manual excerpt file: ${targetPath}`);
		}
		const content = readFileSync(targetPath, "utf8");
		if (content.length < 50) {
			throw new Error(`Manual excerpt file is suspiciously small: ${targetPath}`);
		}
	}

	console.log(`[update-reference-docs] All reference documents validated successfully.`);
}

const args = process.argv.slice(2);
if (args.includes("--check")) {
	try {
		checkReferenceDocs();
		process.exit(0);
	} catch (err) {
		console.error(`[update-reference-docs] Validation failed:`, err);
		process.exit(1);
	}
} else {
	writeReferenceDocs();
	checkReferenceDocs();
}
