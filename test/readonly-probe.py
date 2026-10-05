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

# Resolved from this file rather than hardcoded: the probe is run by
# test/blender-probes.test.mjs against whichever checkout the tests live in, and
# a hardcoded path made it silently exercise a DIFFERENT copy of the guard --
# which is how the guard could be changed here and go unproven.
_BRIDGE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "blender")
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


def run_mutating(live_bridge, source, blend_path, save_after=False):
    """Same plumbing as run(), but through the handler that may change the file."""
    script_path = os.path.join(live_bridge.BRIDGE_DIR, "mutating-probe-script.py")
    with open(script_path, "w", encoding="utf-8") as handle:
        handle.write(source)
    return live_bridge.handle_execute_python({
        "blendPath": blend_path,
        "workspacePath": tempfile.mkdtemp(),
        "iterationPath": tempfile.mkdtemp(),
        "userScriptPath": script_path,
        "saveAfter": save_after,
    })


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
    # bpy.data's OWN removers, not bpy.data.<coll>'s. Measured against Blender
    # 5.2: batch_remove and orphans_purge live on bpy.data itself, and both
    # removed datablocks while the guard was installed.
    expect_refused(live_bridge, blend_path, "bpy.data.batch_remove", "bpy.data.batch_remove(list(bpy.data.objects))")
    expect_refused(live_bridge, blend_path, "bpy.data.orphans_purge", "bpy.data.orphans_purge()")
    # The outliner namespace's purge really deletes ("Info: Deleted 1
    # data-block(s)"), and the namespace was not on the refusal list.
    expect_refused(
        live_bridge,
        blend_path,
        "bpy.ops.outliner.orphans_purge",
        "bpy.ops.outliner.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)",
    )
    # bpy.context was not patched at all, so the scene collection's link/unlink
    # changed whether objects were in the scene, and the datablocks it handed
    # out were the REAL ones -- which walked around every assignment refusal.
    expect_refused(
        live_bridge,
        blend_path,
        "bpy.context.scene.collection.objects.unlink",
        # By name, not by index: the scene collection is empty under
        # --factory-startup, so objects[0] would raise IndexError before the
        # guard was ever reached and the case would prove nothing.
        f"bpy.context.scene.collection.objects.unlink(bpy.data.objects['{cube.name}'])",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "bpy.context.scene.collection.objects.link",
        f"bpy.context.scene.collection.objects.link(bpy.data.objects['{cube.name}'])",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "bpy.context.scene.collection.children.link",
        "bpy.context.scene.collection.children.link(bpy.data.collections.new('sneak'))",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "assigning through bpy.context (real datablock)",
        "bpy.context.scene.objects[0].location.x = 99.0",
    )
    expect_refused(
        live_bridge,
        blend_path,
        "assigning through the depsgraph bpy.context hands out",
        "bpy.context.evaluated_depsgraph_get().objects[0].location.x = 99.0",
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

    # --- `changed` is a dirty rising edge, not "the script exited 0" -----
    result = run_mutating(live_bridge, "print('READ ONLY SCRIPT')\n", blend_path)
    check(result["exitCode"] == 0, "a no-op mutating-handler run succeeds")
    check(
        result["changed"] is False,
        f"a successful no-op reports changed=False, got {result['changed']!r}",
    )

    result = run_mutating(
        live_bridge,
        "import bpy\nbpy.ops.mesh.primitive_ico_sphere_add()\nprint('MUTATED UNSAVED')\n",
        blend_path,
    )
    check(result["exitCode"] == 0, "an unsaved mutating run succeeds")
    check(
        result["changed"] is True,
        f"an unsaved mutation reports changed=True, got {result['changed']!r}",
    )

    # Saving clears the dirty flag, so a correct implementation cannot read it
    # after save_mainfile() -- this is the case that regressed before.
    result = run_mutating(
        live_bridge,
        "import bpy\nbpy.ops.mesh.primitive_ico_sphere_add()\nprint('MUTATED SAVED')\n",
        blend_path,
        save_after=True,
    )
    check(result["exitCode"] == 0, "a mutating run that saves succeeds")
    check(
        result["changed"] is True,
        f"a mutating run that saves reports changed=True, got {result['changed']!r}",
    )

    result = run_mutating(
        live_bridge,
        "import bpy\nbpy.ops.mesh.primitive_ico_sphere_add()\nraise ValueError('after the edit')\n",
        blend_path,
    )
    check(result["exitCode"] == 1, "a mutating run that raises still fails")
    check(
        result["changed"] is True,
        f"a mutation followed by a raise reports changed=True, got {result['changed']!r}",
    )

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

    # The file was left dirty by the raise case above. That is now irrelevant to
    # `changed`: the handler diffs content, so a run that adds an object is a
    # change whether or not the file was already dirty on entry.
    check(
        result["changed"] is True,
        f"a mutation against an already-dirty file reports changed=True, got {result['changed']!r}",
    )

    # The other half of that: prior dirtiness must not make every run report a
    # change, or `changed` is just `exit_code == 0` wearing a new hat.
    check(
        run_mutating(live_bridge, "print('NOTHING TOUCHED')", blend_path)["changed"] is False,
        "a no-op run against an already-dirty file reports changed=False",
    )

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
