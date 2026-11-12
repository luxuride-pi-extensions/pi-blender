"""Long-lived Blender worker for runBlenderJson.

Blender has no daemon API, so the protocol is ours: one JSON request per line
on stdin, one JSON response per line on stdout, prefixed so Blender's own
chatter cannot be mistaken for a response. Every job starts from factory
settings; the job script then opens whatever blend it was given, exactly as it
does in a one-shot process.
"""

import contextlib
import io
import json
import os
import runpy
import sys
import traceback

PREFIX = "__PI_WARM__"


def run_job(job):
    # pi-lens-ignore: ast-grep:unresolved-import-python (bpy is provided by Blender's Python runtime)
    import bpy  # pyright: ignore[reportMissingImports]

    # A job inherits the worker's cwd otherwise, and a script that chdirs would
    # move every later job. Each job starts where its caller asked.
    os.chdir(job.get("cwd") or os.getcwd())
    before_path = list(sys.path)
    before_argv = list(sys.argv)
    before_modules = set(sys.modules)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    blend_path = job.get("blendPath")
    if blend_path:
        bpy.ops.wm.open_mainfile(filepath=blend_path)
    sys.argv = [job["script"], "--", json.dumps(job["payload"])]
    for argument in job.get("scriptArgs") or []:
        sys.argv.append(argument)
    stdout = io.StringIO()
    stderr = io.StringIO()
    code = 0
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            runpy.run_path(job["script"], run_name="__main__")
    except SystemExit as exit_error:
        code = int(exit_error.code or 0) if isinstance(exit_error.code, int) else 1
    except BaseException:
        code = 1
        stderr.write(traceback.format_exc())
    finally:
        sys.path[:] = before_path
        sys.argv[:] = before_argv
        for name in set(sys.modules) - before_modules:
            sys.modules.pop(name, None)
    return {
        "id": job.get("id"),
        "code": code,
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "pid": __import__("os").getpid(),
    }


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            job = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = run_job(job)
        output = sys.__stdout__
        if output is None:
            raise RuntimeError("Blender did not provide a stdout stream for the warm worker.")
        output.write(PREFIX + json.dumps(response) + "\n")
        output.flush()


main()
