/**
 * The open-run count, driven through a real spawn.
 *
 * run-leases.test.mjs proves the lease bookkeeping in isolation, which leaves
 * the wiring untested: a lease acquired nowhere, or released on the wrong side
 * of a failure, would leave every unit test green and the count permanently
 * zero — the same answer a per-process gate gives, which is the bug this
 * exists to fix. So these run a real child through runBlenderProcess and
 * sample the lease dir WHILE it runs.
 *
 * The spawned binary is node, not Blender, via BLENDER_PATH (honoured verbatim
 * by resolveBlenderArgv): what has to hold is that a spawn in flight is visible
 * and a finished one is not, and making that depend on a Blender install would
 * test the environment rather than the wiring.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { JITI } from "./paths.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(REPO, "test", "lease-wiring-driver.mjs");

const root = mkdtempSync(join(tmpdir(), "pi-blender-leasewire-"));
const staged = join(root, "run");
mkdirSync(staged, { recursive: true });

function runDriver(mode, { fakeBlender = true } = {}) {
	const bridge = join(root, `bridge-${mode}`);
	mkdirSync(bridge, { recursive: true });
	// The driver writes its own wrapper that execs node on the probe, so the
	// leased pid IS the probe process. Pointing BLENDER_PATH at node directly
	// would hand the child Blender's argv, which it does not understand and
	// exits on — too fast to sample, and for the wrong reason.
	const fake = join(staged, "blender");
	let blenderPath;
	if (fakeBlender) {
		writeFileSync(fake, `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(join(staged, "probe.mjs"))}\n`, "utf-8");
		chmodSync(fake, 0o755);
		blenderPath = fake;
	} else {
		blenderPath = join(root, "no-such-binary");
	}
	const result = spawnSync(process.execPath, [DRIVER, staged, mode], {
		encoding: "utf-8",
		env: {
			...process.env,
			PI_JITI_PATH: JITI,
			PI_BLENDER_BRIDGE_DIR: bridge,
			PI_BLENDER_MAX_PARALLEL_RUNS: "4",
			BLENDER_PATH: blenderPath,
		},
	});
	if (result.status !== 0) {
		throw new Error(`driver ${mode} failed (${result.status}):\n${result.stderr}`);
	}
	return JSON.parse(result.stdout);
}

test("a run in flight is visible, and gone once it exits", () => {
	const out = runDriver("observe");
	assert.equal(out.during.running, 1, "a headless Blender running right now must be counted. This is the wiring the isolated lease tests cannot prove: a lease acquired nowhere would leave them green and this zero.");
	assert.equal(out.during.pids.length, 1);
	assert.equal(out.after.running, 0, "a finished run left behind would make the count grow for the whole session");
	assert.equal(out.after.staleSwept, 0, "a clean exit is not a swept lease");
	assert.deepEqual(out.files, [], "the lease file is removed, not left for the next count to sweep");
	assert.equal(out.code, 0);
});

test("the lease names what the run was for", () => {
	const out = runDriver("observe");
	assert.equal(
		out.label,
		"probe run",
		"a count with pids is useful; pids AND a label let a caller say which module is running, not only how many things are",
	);
});

test("a run that fails still releases its lease", () => {
	const out = runDriver("fail");
	assert.equal(out.code, 3);
	assert.equal(out.during.running, 1, "a failing run was still a running Blender, and the count should have said so while it ran");
	assert.equal(out.after.running, 0, "a lease leaked only on the failure path looks exactly like a hung Blender, which is the state nobody can diagnose");
});

test("a spawn that never starts leaves no lease", () => {
	const out = runDriver("spawnfails", { fakeBlender: false });
	assert.equal(out.code, 127);
	assert.equal(out.after.running, 0, "a lease for a process that never existed is a phantom run");
});

test.after(() => {
	rmSync(root, { recursive: true, force: true });
});