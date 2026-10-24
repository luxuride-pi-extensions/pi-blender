# bpy.ops.render — Render Operators (Blender 4.2 LTS)

Operators for invoking rendering passes and animations.

## Operators

### bpy.ops.render.render
```python
bpy.ops.render.render(animation=False, write_still=False, use_viewport=False, layer="", scene="")
```
Render the active scene from its active camera viewpoint.

- `animation` (boolean, default False): Render entire frame sequence from frame_start to frame_end.
- `write_still` (boolean, default False): Immediately save rendered image to scene.render.filepath.
- `use_viewport` (boolean, default False): Render from current 3D viewport display rather than full engine pass.
