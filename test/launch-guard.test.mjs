/**
 * The launch guard: a session that cannot start its bridge must say so once,
 * not reopen a window every fifteen seconds.
 *
 * The bug this exists for was live, not hypothetical. A pi session started at
 * 10:52 loaded this extension from a checkout that was renamed underneath it
 * three minutes later, so its `config.ts` still resolved
 * `/Projects/pi-vibe-blender/blender/blank-bootstrap.py`. That file no longer
 * exists. Blender was given `--python <missing>`, exited during boot without
 * writing a heartbeat, and every layer above read that as a dead bridge: the
 * watchdog released the claim and the 15 s supervisor reset and relaunched. The
 * user got a window every fifteen seconds for the rest of the session, with no
 * message naming a cause.
 *
 * How it is tested: the launcher's own import graph is COPIED into a temp
 * directory whose `blender/` holds the TypeScript it imports but not the two
 * `.py` files it feeds to Blender. The launcher resolves those paths relative
 * to the module's own location, so a copy is enough to make them missing
 * without touching the real checkout — which matters, because the real one has
 * to stay intact for the second half of this test.
 *
 * Nothing here starts Blender. BLENDER_PATH points at a shell script that
 * records its argv and exits, so "it launched" means the command line, and a
 * regression cannot open a real window.
 *
 * The driver runs in a CHILD process, for the reason probe.mjs documents: the
 * launcher holds module state (the launch claim, the supervisor handle, the
 * cached "assets are missing" flag) and jiti caches modules per instance, so an
 * in-process harness would test state no real session has.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(dirname(fileURLToPath(import.meta.url)), "launch-guard-driver.mjs");

/** The launch module's own import graph. The two .py files are NOT in it. */
const LAUNCH_SOURCES = [
	"launch.ts",
	"config.ts",
	"manager-core.ts",
	join("blender", "reap.ts"),
	join("blender", "liveness.ts"),
];

const sandboxes = [];
after(() => {
	for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** A copy of the launcher in a directory of its own, scripts present or not. */
function stageExtension({ withScripts }) {
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

/** A fake Blender that records how it was called instead of starting a UI. */
function stageFakeBlender() {
	const dir = mkdtempSync(join(tmpdir(), "pi-blender-bin-"));
	sandboxes.push(dir);
	const record = join(dir, "argv.txt");
	const path = join(dir, "blender");
	writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" > ${JSON.stringify(record)}\n`);
	chmodSync(path, 0o755);
	return { path, record };
}

/** Drive the staged launcher once, in a child process. */
function launchOnce({ withScripts, subagentChild = false }) {
	const staged = stageExtension({ withScripts });
	const { path: blender, record } = stageFakeBlender();
	const bridge = join(mkdtempSync(join(tmpdir(), "pi-blender-box-")), "bridge");
	sandboxes.push(join(bridge, ".."));
	mkdirSync(bridge, { recursive: true });

	const result = spawnSync(process.execPath, [DRIVER, staged], {
		env: {
			...process.env,
			PI_BLENDER_BRIDGE_DIR: bridge,
			PI_BLENDER_NO_UI: "",
			PI_SUBAGENT_CHILD: subagentChild ? "1" : "",
			BLENDER_PATH: blender,
		},
		encoding: "utf-8",
		timeout: 60_000,
	});
	let supervision = null;
	try {
		supervision = JSON.parse(result.stdout.trim().split("\n").pop() ?? "null");
	} catch {
		// Left null: the assertion below then reports it rather than throwing
		// somewhere less informative than the driver's own stderr.
	}
	return { result, record, supervision };
}

describe("launch guard", () => {
	it("refuses to launch when a bundled script is missing, and names the path", () => {
		const { result, record } = launchOnce({ withScripts: false });

		assert.equal(existsSync(record), false, "no Blender may be started when the scripts are missing");
		assert.match(result.stderr, /not launching Blender/, "the failure must be reported, not silent");
		assert.match(result.stderr, /blank-bootstrap\.py/, "the message must name the missing file");
		assert.match(result.stderr, /Restart the pi session/, "the message must say what actually fixes it");
	});

	it("still launches, with both scripts, when the checkout is complete", () => {
		const { result, record } = launchOnce({ withScripts: true });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(record), true, "a complete checkout must still launch Blender");
		const argv = readFileSync(record, "utf-8");
		assert.match(argv, /--python \S*blank-bootstrap\.py/);
		assert.match(argv, /--python \S*live-bridge\.py/);
		assert.doesNotMatch(result.stderr, /not launching Blender/);
	});

	it("arms supervision once from a root session_start, however many times it fires", () => {
		// /reload re-fires session_start on the same session, so "arms once" is
		// the whole assertion: a second interval would relaunch in parallel with
		// the first, which is the multi-window report this supervisor exists to
		// prevent. The accessor is what makes it observable at all.
		const { supervision } = launchOnce({ withScripts: true });

		assert.deepEqual(supervision, { armedAfterFirst: true, armedAfterSecond: true });
	});

	it("a subagent child never arms supervision", () => {
		const { supervision, record } = launchOnce({ withScripts: true, subagentChild: true });

		assert.deepEqual(
			supervision,
			{ armedAfterFirst: false, armedAfterSecond: false },
			"a child has no UI lifetime to protect, so it must not watch for a dead bridge",
		);
		assert.equal(
			existsSync(record),
			false,
			"and it must not launch either, since the driver's child path skips the launch",
		);
	});
});
