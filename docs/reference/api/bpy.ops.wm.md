# bpy.ops.wm — Window Manager Operators (Blender 4.2 LTS)

File I/O, saving, loading, and window state management.

## Operators

### bpy.ops.wm.save_as_mainfile
```python
bpy.ops.wm.save_as_mainfile(filepath="", check_existing=True, filter_blender=True, compress=False, relative_remap=True, copy=False)
```
Save current Blender document to disk at `filepath`.

- `filepath` (string): Target file path ending in `.blend`.
- `compress` (boolean, default False): Use gzip compression on the .blend file.
- `copy` (boolean, default False): Save a copy without changing active document filename.

### bpy.ops.wm.save_mainfile
```python
bpy.ops.wm.save_mainfile(filepath="", check_existing=True, filter_blender=True, compress=False, relative_remap=True)
```
Save current Blender document to its current filepath.

### bpy.ops.wm.open_mainfile
```python
bpy.ops.wm.open_mainfile(filepath="", filter_blender=True, display_type='DEFAULT', sort_method='', load_ui=True, use_scripts=True)
```
Open a Blender document from disk.

- `filepath` (string): Path to `.blend` file.
- `load_ui` (boolean, default True): Load window layout stored inside the file.
- `use_scripts` (boolean, default True): Allow auto-execution of embedded Python scripts.

### bpy.ops.wm.read_homefile
```python
bpy.ops.wm.read_homefile(filepath="", load_ui=True, use_empty=False)
```
Reset session to default startup configuration.
