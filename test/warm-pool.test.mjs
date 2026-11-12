/**
 * A warm Blender process is only useful if it is actually reused and actually
 * forgets the previous job. Both are properties of Blender's own state, so the
 * test launches it rather than mocking the protocol.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { loadTs } from "./paths.mjs";

const { runBlenderJson } = await loadTs(fileURLToPath(new URL("../blender/utils.ts", import.meta.url)));
const { resetWarmPoolForTests, warmPoolStats } = await loadTs(
	fileURLToPath(new URL("../blender/warm-pool.ts", import.meta.url)),
);

async function blenderAvailable() {
	try {
		const { resolveBlenderArgv } = await loadTs(fileURLToPath(new URL("../launch.ts", import.meta.url)));
		const { command, args } = await resolveBlenderArgv();
		execFileSync(command, [...args, "--version"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"] });
		return true;
	} catch {
		return false;
	}
}

const available = await blenderAvailable();
const skip = available ? false : "Blender is not installed";

function job(source, extra = {}) {
	return runBlenderJson({
		cwd: extra.cwd ?? process.cwd(),
		label: "warm pool test",
		scriptSource: `
import bpy
${source}
print("__PI_BLENDER_JSON_START__")
print('{"ok": true}')
print("__PI_BLENDER_JSON_END__")
`,
		payload: {},
		timeoutMs: 120_000,
		...extra,
	});
}

test("two jobs share one Blender process", { skip, timeout: 180_000 }, async () => {
	process.env.PI_BLENDER_WARM_POOL = "1";
	resetWarmPoolForTests();
	try {
		await job("pass");
		await job("pass");
		const stats = warmPoolStats();
		assert.equal(stats.spawned, 1, JSON.stringify(stats));
		assert.equal(stats.reused, 1, JSON.stringify(stats));
	} finally {
		resetWarmPoolForTests();
		delete process.env.PI_BLENDER_WARM_POOL;
	}
});

test("the next job starts from factory settings", { skip, timeout: 180_000 }, async () => {
	process.env.PI_BLENDER_WARM_POOL = "1";
	resetWarmPoolForTests();
	try {
		await job('bpy.data.objects.new("Leak", None)');
		await job(`
if bpy.data.objects.get("Leak") is not None:
    raise RuntimeError("the previous job leaked an object")
`);
	} finally {
		resetWarmPoolForTests();
		delete process.env.PI_BLENDER_WARM_POOL;
	}
});

test("a crashed worker rejects the job and the next job gets a fresh one", { skip, timeout: 180_000 }, async () => {
	process.env.PI_BLENDER_WARM_POOL = "1";
	resetWarmPoolForTests();
	try {
		await assert.rejects(
			job("import os\nos._exit(3)"),
			/exited before answering/,
		);
		await job("pass");
		assert.equal(warmPoolStats().spawned, 2, JSON.stringify(warmPoolStats()));
	} finally {
		resetWarmPoolForTests();
		delete process.env.PI_BLENDER_WARM_POOL;
	}
});

test("a hung job is killed and reported as a timeout", { skip, timeout: 180_000 }, async () => {
	process.env.PI_BLENDER_WARM_POOL = "1";
	resetWarmPoolForTests();
	try {
		await assert.rejects(
			job("import time\ntime.sleep(10)", { timeoutMs: 800 }),
			/timed out after 800 ms/,
		);
		await job("pass");
	} finally {
		resetWarmPoolForTests();
		delete process.env.PI_BLENDER_WARM_POOL;
	}
});

test("each job runs in the cwd it was given", { skip, timeout: 180_000 }, async () => {
	process.env.PI_BLENDER_WARM_POOL = "1";
	resetWarmPoolForTests();
	const first = mkdtempSync(join(process.cwd(), ".warm-cwd-a-"));
	const second = mkdtempSync(join(process.cwd(), ".warm-cwd-b-"));
	try {
		await job('import os\nos.chdir("/")', { cwd: first });
		await job(`
import os
expected = ${JSON.stringify(second)}
if os.path.realpath(os.getcwd()) != os.path.realpath(expected):
    raise RuntimeError(f"wrong cwd: {os.getcwd()}")
`, { cwd: second });
	} finally {
		resetWarmPoolForTests();
		delete process.env.PI_BLENDER_WARM_POOL;
		rmSync(first, { recursive: true, force: true });
		rmSync(second, { recursive: true, force: true });
	}
});

test("overlapping jobs get separate workers", { skip, timeout: 180_000 }, async () => {
	process.env.PI_BLENDER_WARM_POOL = "1";
	resetWarmPoolForTests();
	try {
		await Promise.all([job("import time\ntime.sleep(1)"), job("import time\ntime.sleep(1)")]);
		const stats = warmPoolStats();
		assert.equal(stats.spawned, 2, JSON.stringify(stats));
		assert.equal(stats.reused, 0, JSON.stringify(stats));
	} finally {
		resetWarmPoolForTests();
		delete process.env.PI_BLENDER_WARM_POOL;
	}
});

test("a failed job is not reused and leaves no trace", { skip, timeout: 180_000 }, async () => {
	process.env.PI_BLENDER_WARM_POOL = "1";
	resetWarmPoolForTests();
	try {
		await assert.rejects(job('raise RuntimeError("boom")'), /boom/);
		const next = await job("pass");
		assert.equal(warmPoolStats().spawned, 2, JSON.stringify(warmPoolStats()));
		assert.deepEqual(next, { ok: true });
	} finally {
		resetWarmPoolForTests();
		delete process.env.PI_BLENDER_WARM_POOL;
	}
});

test("the feature is off unless asked for", { skip, timeout: 120_000 }, async () => {
	delete process.env.PI_BLENDER_WARM_POOL;
	resetWarmPoolForTests();
	await job("pass");
	assert.equal(warmPoolStats().spawned, 0, "no worker was started");
});
