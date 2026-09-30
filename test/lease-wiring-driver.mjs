/**
 * The open-run count, driven through a real spawn.
 *
 * run-leases.test.mjs proves the lease bookkeeping in isolation, which leaves
 * the wiring untested: a lease acquired nowhere, or released on the wrong side
 * of a failure, would leave every unit test green and the count permanently
 * zero — the same answer a per-process gate gives, which is the bug this
 * exists to fix. So this driver spawns an actual child through
 * runBlenderProcess and samples the lease dir WHILE it runs.
 *
 * The spawned binary is node, not Blender, and BLENDER_PATH is set to it: what
 * has to hold is that a spawn in flight is visible and a finished one is not.
 * Making that depend on a flatpak sandbox being present would test the
 * environment, not the wiring.
 *
 * It runs in a child process because the lease dir comes from
 * PI_BLENDER_BRIDGE_DIR at import time, and because the extension's TypeScript
 * needs jiti (see paths.mjs on why a bare import cannot load it).
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const { createJiti } = await import(process.env.PI_JITI_PATH);

const [staged, mode] = process.argv.slice(2);
const bridge = process.env.PI_BLENDER_BRIDGE_DIR;

// The real sources, not a staged copy: this test is about the wiring between
// utils.ts and run-leases.ts, and a copy of two files would import a third
// module's copy of config.ts and resolve the bridge dir from the wrong place.
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const jiti = createJiti(import.meta.url, { isolated: true, interopDefault: true });
const leaseMod = await jiti.import(join(REPO, "blender/run-leases.ts"));
const utilsMod = await jiti.import(join(REPO, "blender/utils.ts"));

function leaseFiles() {
	try {
		return readdirSync(join(bridge, "headless-runs")).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

/** One lease's label, or null. */
function singleLabel() {
	const files = leaseFiles();
	return files.length === 1 ? (leaseMod.readRunLease(Number(files[0].slice(0, -5)))?.label ?? null) : null;
}

/** Poll until `predicate` holds, then answer. A fixed sleep would race. */
async function until(predicate, timeoutMs = 5_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the expected state");
		await new Promise((r) => setTimeout(r, 10));
	}
}

if (mode === "observe" || mode === "fail") {
	const marker = join(staged, "started");
	rmSync(marker, { force: true });
	// A fake Blender: a shell script that drops Blender's own argv and runs the
	// probe. The child must LINGER, because the sample has to land while the run
	// is alive — one that exits the instant it starts leaves the lease already
	// gone, which is a race in the test and not evidence about the code. `fail`
	// lingers the same way and then exits non-zero, to check that the failure
	// path releases just as the success path does.
	const probe = join(staged, "probe.mjs");
	writeFileSync(
		probe,
		[
			'import { writeFileSync } from "node:fs";',
			`writeFileSync(${JSON.stringify(marker)}, String(Date.now()));`,
			mode === "fail" ? "setTimeout(() => process.exit(3), 600);" : "setTimeout(() => process.exit(0), 1200);",
		].join("\n"),
		"utf-8",
	);
	// `exec` so the leased pid is the node process itself rather than a shell
	// that outlives or precedes it.
	const fakeBlender = join(staged, "blender");
	writeFileSync(fakeBlender, `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(probe)}\n`, "utf-8");
	chmodSync(fakeBlender, 0o755);

	const run = utilsMod.runBlenderProcess({
		cwd: staged,
		scriptPath: probe,
		payload: {},
		label: "probe run",
	});

	await until(() => existsSync(marker));
	const during = leaseMod.countOpenHeadlessRuns();
	const label = singleLabel();
	const result = await run;

	process.stdout.write(
		JSON.stringify({ during, label, after: leaseMod.countOpenHeadlessRuns(), code: result.code, files: leaseFiles() }),
	);
	rmSync(probe, { force: true });
} else if (mode === "spawnfails") {
	// A command that does not exist: execCommand reports 127, and the lease must
	// not be left behind by a process that never started.
	const result = await utilsMod.runBlenderProcess({
		cwd: staged,
		scriptPath: join(staged, "never.mjs"),
		payload: {},
		label: "impossible",
	});
	process.stdout.write(JSON.stringify({ after: leaseMod.countOpenHeadlessRuns(), code: result.code }));
} else {
	mkdirSync(staged, { recursive: true });
	throw new Error(`unknown mode: ${mode}`);
}