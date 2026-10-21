# Shading and Materials Guide (Blender 4.2 LTS)

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
- **Normal**: Connects to the output of a `ShaderNodeNormalMap` or `ShaderNodeBump`.

## Constructing Shader Node Networks

Programmatic Python construction pattern:
```python
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
```

## Texture Color Spaces
- **sRGB**: Used strictly for color data that represents visual hue (Base Color, Subsurface Color).
- **Non-Color**: Mandatory for numerical vector and scalar maps (Normal maps, Roughness maps, Metallic maps, Displacement). Reading a normal map as sRGB distorts vector normals and ruins lighting fidelity.
