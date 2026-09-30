#!/usr/bin/env python3
"""Exercise the read-only guard against the real bpy module.

A guard that patches bpy can only be tested against bpy: a mock has the wrong
attribute surface, so a test against one would pass while the real thing raised
AttributeError on first use.

Each case is a script that must be REFUSED, and one that must be ALLOWED, run
through the same request handler the bridge uses. Exit code 0 means every
refusal happened and every measurement still worked.
"""

import importlib.util
import os
import sys
import tempfile

_BRIDGE_DIR = "/var/home/lux/Projects/pi-blender/blender"
failures = []


def check(condition, message):
    if not condition:
        failures.append(message)
    # Blender buffers its own stdout, so an unflushed failure line is lost when
    # the process leaves via os._exit.
    print(f"  {'ok  ' if condition else 'FAIL'}: {message}")
    sys.stdout.flush()


def load_bridge(bridge_dir):
    os.environ["PI_BLENDER_BRIDGE_DIR"] = bridge_dir
    spec = importlib.util.spec_from_file_location(
        "live_bridge", os.path.join(_BRIDGE_DIR, "live-bridge.py")
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["live_bridge"] = module
    spec.loader.exec_module(module)
    return module


def run(live_bridge, source, blend_path):
    script_path = os.path.join(live_bridge.BRIDGE_DIR, "probe-script.py")
    with open(script_path, "w", encoding="utf-8") as handle:
        handle.write(source)
    request = {
        "blendPath": blend_path,
        "workspacePath": tempfile.mkdtemp(),
        "iterationPath": tempfile.mkdtemp(),
        "userScriptPath": script_path,
    }
    return live_bridge.handle_read_only_python(request)


def expect_refused(live_bridge, blend_path, label, source):
    result = run(live_bridge, source, blend_path)
    refused = result["exitCode"] == 2 and "read-only" in result["stdout"]
    check(refused, f"refused: {label}")


def main():
    live_bridge = load_bridge(tempfile.mkdtemp())

    import bpy

    bpy.ops.mesh.primitive_cube_add(size=1.0)
    cube = bpy.context.active_object
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(live_bridge.BRIDGE_DIR, "probe.blend"))
    blend_path = bpy.data.filepath

    # --- must be refused -------------------------------------------------
    expect_refused(live_bridge, blend_path, "bpy.ops.object.delete", "bpy.ops.object.delete()")
    expect_refused(live_bridge, blend_path, "bpy.ops.wm.save_mainfile", "bpy.ops.wm.save_mainfile()")
    expect_refused(live_bridge, blend_path, "bpy.ops.mesh.add_cube", "bpy.ops.mesh.add_cube()")
    expect_refused(
        live_bridge,
        blend_path,
        "bpy.data.objects.remove",
        f"bpy.data.objects.remove(bpy.data.objects['{cube.name}'])",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "del bpy.data.objects",
        f"del bpy.data.objects['{cube.name}']",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "bpy.data.meshes.new (creates a datablock)",
        "bpy.data.meshes.new('sneaky')",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "a computed attribute name",
        "bpy.ops.__getattr__('object').__getattr__('delete')()",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "mutating a property on a live object",
        f"bpy.data.objects['{cube.name}'].location.x = 99.0",
    )

    # --- must still work -------------------------------------------------
    result = run(
        live_bridge,
        "import bpy\n"
        f"obj = bpy.data.objects['{cube.name}']\n"
        "print('VERTS', len(obj.data.vertices))\n"
        "print('LOC', tuple(round(c, 3) for c in obj.location))\n"
        "deps = bpy.context.evaluated_depsgraph_get()\n"
        "print('EVAL', obj.evaluated_get(deps).name is not None)\n"
        "print('NAMES', [o.name for o in bpy.data.objects])\n",
        blend_path,
    )
    check(result["exitCode"] == 0, "a measurement script runs")
    check("VERTS 8" in result["stdout"], f"vertex count reaches stdout: {result['stdout']!r}")
    check("EVAL True" in result["stdout"], "the depsgraph is reachable")

    result = run(
        live_bridge,
        "from mathutils.bvhtree import BVHTree\n"
        "print('OK', BVHTree is not None)\n",
        blend_path,
    )
    check(result["exitCode"] == 0, "importing a module still works")

    result = run(live_bridge, "raise ValueError('deliberate')", blend_path)
    check(result["exitCode"] == 1, "an ordinary error is still an error, not a refusal")
    check("ValueError" in result["stderr"], "the traceback survives")

    # --- the guard must be gone afterwards -------------------------------
    # Checked through the MUTATING handler: every run above went through the
    # read-only one, which installs the guard every time by design, so this
    # proves nothing about whether it was uninstalled.
    check(len(bpy.data.objects) > 0, "the scene still has its objects after the guard cases")
    script_path = os.path.join(live_bridge.BRIDGE_DIR, "mutate-script.py")
    with open(script_path, "w", encoding="utf-8") as handle:
        handle.write("import bpy\nbpy.ops.mesh.primitive_ico_sphere_add()\nprint('MUTATED')\n")
    result = live_bridge.handle_execute_python({
        "blendPath": blend_path,
        "workspacePath": tempfile.mkdtemp(),
        "iterationPath": tempfile.mkdtemp(),
        "userScriptPath": script_path,
        "saveAfter": False,
    })
    check(result["exitCode"] == 0, "a MUTATING run works again after the guard is restored")
    check("MUTATED" in result["stdout"], "bpy.ops adds an object again after the guard is restored")

    if failures:
        print(f"FAIL: {len(failures)} case(s)")
        for failure in failures:
            print(f"  - {failure}")
        sys.stdout.flush()
        os._exit(1)
    print("PASS: the read-only guard refuses mutation and restores cleanly")
    sys.stdout.flush()
    os._exit(0)


main()
