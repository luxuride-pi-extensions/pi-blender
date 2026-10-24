# Geometry Nodes Procedural Guide (Blender 4.2 LTS)

Procedural geometry, node fields, curve generation, instancing, and attribute pipelines in Blender 4.2.

## Core Geometry Nodes Concepts

### Geometries vs Fields
- **Geometry Sockets (Round Green)**: Concrete geometric meshes, curves, point clouds, or instances passing through the node graph.
- **Field Sockets (Diamond)**: Functions or equations evaluated per-element (per-vertex, per-edge, per-face) within the context of a geometry flow.

## Common Procedural Patterns

### 1. Curve to Tube / Pipe
Convert a 1D spline curve into a 3D tubular mesh surface:
```
[Curve Input] -> [Curve to Mesh] -> [Mesh Output]
                        ^
[Curve Circle Primitive] | (Profile Curve)
```
- Node: `GeometryNodeCurveToMesh`
- Profile input: `GeometryNodeCurvePrimitiveCircle` with configurable radius.

### 2. Point Distribution and Instancing
Scatter multiple object instances across a surface (e.g. foliage, debris, rivets):
```
[Mesh Surface] -> [Distribute Points on Faces] -> [Instance on Points] -> [Realize Instances]
                                                        ^
                                              [Instance Object/Mesh]
```
- `GeometryNodeDistributePointsOnFaces` (Poisson Disk method guarantees minimum distance between scattered points).
- `GeometryNodeInstanceOnPoints`.
- `GeometryNodeRealizeInstances`: Converts virtual lightweight instances into real geometry, required if subsequent modifiers or boolean operations need to evaluate the mesh.

### 3. Setting Procedural Materials
- `GeometryNodeSetMaterial`: Assigns a specific Material datablock directly to procedural geometry within the node tree.
