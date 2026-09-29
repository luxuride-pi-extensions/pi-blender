/**
 * Shared staging for the tests that drive a real copy of launch.ts.
 *
 * WHY A COPY, AND WHY A CHILD PROCESS — both are load-bearing, and both were
 * arrived at by getting them wrong first.
 *
 * The copy: launch.ts resolves the two scripts it hands to Blender
 * (`blank-bootstrap.py`, `live-bridge.py`) relative to its OWN location, which
 * is what made a renamed checkout invisible to it in the first place. So the
 * only honest way to test the "the bundled scripts are missing" guard is a
 * directory that has the TypeScript and not the Python — which means copying,
 * because the real checkout has to stay intact for the tests that launch
 * successfully.
 *
 * The child process: the launcher holds module state — the launch claim, the
 * supervisor's interval handle, the cached "assets are missing" flag, the
 * consecutive-failure counter — and jiti caches modules per instance. An
 * in-process harness would be reading state no real session has, and would
 * give a second test in the same file the first test's answers. probe.mjs
 * documents the same lesson for the config tests.
 *
 * NOTHING HERE STARTS BLENDER. BLENDER_PATH points at a shell script. "It
 * launched" therefore means "a command line was written to a file", and a
 * regression in any of these tests cannot open a real window.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The launch module's own import graph. The two .py files are NOT in it. */
const LAUNCH_SOURCES = [
	"launch.ts",
	"config.ts",
	"manager-core.ts",
	join("blender", "reap.ts"),
	join("blender", "liveness.ts"),
];

const sandboxes = [];

/** Remove everything staged so far. Call from an `after` hook. */
export function cleanupSandboxes() {
	for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
}

/** A copy of the launcher in a directory of its own, scripts present or not. */
export function stageExtension({ withScripts }) {
	const dir = mkdtempSync(join(tmpdir(), "pi-blender-launch-"));
	sandboxes.push(dir);
	for (const rel of LAUNCH_SOURCES) {
		const dest = join(dir, rel);
		mkdirSync(dirname(dest), { recursive: true });
		copyFileSync(join(REPO, rel), dest);
	}
	// config.ts resolves the assets dir from its OWN location, so this is the
	// only way the two bundled scripts can be made to not exist.
	if (withScripts) {
		for (const name of ["blank-bootstrap.py", "live-bridge.py"]) {
			writeFileSync(join(dir, "blender", name), "# staged\n");
		}
	}
	return dir;
}

/**
 * A fake Blender that records how it was called instead of starting a UI.
 *
 * `recordEach` appends one line per spawn rather than overwriting, which is
 * what lets a test COUNT launches. A test that can only see "something was
 * recorded" cannot tell one launch from a loop of them, and a loop is exactly
 * what the retry ceiling exists to bound.
 */
export function stageFakeBlender({ recordEach = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-blender-bin-"));
	sandboxes.push(dir);
	const record = join(dir, "argv.txt");
	const path = join(dir, "blender");
	writeFileSync(
		path,
		recordEach
			? `#!/bin/sh\nprintf 'launch\\n' >> ${JSON.stringify(record)}\n`
			: `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(record)}\n`,
	);
	chmodSync(path, 0o755);
	return { path, record };
}

/** An empty bridge dir, which is what a session that has never launched has. */
export function stageBridgeDir() {
	const dir = join(mkdtempSync(join(tmpdir(), "pi-blender-box-")), "bridge");
	sandboxes.push(join(dir, ".."));
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** How many times the fake Blender was started. Zero if it never was. */
export function countLaunches(record) {
	if (!existsSync(record)) return 0;
	return readFileSync(record, "utf-8").split("\n").filter((line) => line.trim().length > 0).length;
}

/**
 * Run a driver script in a child process against a staged bridge dir.
 *
 * `PI_SUBAGENT_CHILD` is always passed explicitly, empty rather than absent,
 * because a driver that means to be a root session must not inherit the child
 * marker from whatever test runner launched it. Same reasoning for `LAUNCH`:
 * whether the session has already launched a Blender is a fact the driver
 * would otherwise have to guess, and the two cases it separates are exactly the
 * ones that must not be conflated.
 */
export function runDriver(
	driver,
	staged,
	args,
	{ bridge, blender, subagentChild = false, launched = true, timeout = 60_000 },
) {
	return spawnSync(process.execPath, [driver, staged, ...args], {
		env: {
			...process.env,
			PI_BLENDER_BRIDGE_DIR: bridge,
			PI_BLENDER_NO_UI: "",
			PI_SUBAGENT_CHILD: subagentChild ? "1" : "",
			LAUNCH: launched ? "1" : "0",
			BLENDER_PATH: blender,
		},
		encoding: "utf-8",
		timeout,
	});
}

/** Parse the driver's last stdout line as JSON, or null if it is not there. */
export function readDriverJson(result) {
	try {
		return JSON.parse(result.stdout.trim().split("\n").pop() ?? "null");
	} catch {
		// Null on purpose: the assertion then reports the missing value, next to
		// the driver's own stderr, instead of throwing somewhere less useful.
		return null;
	}
}
