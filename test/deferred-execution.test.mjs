import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const render = await load("blender/render.ts");
const jobs = await load("blender/jobs.ts");
const status = await load("blender/status.ts");
const utils = await load("blender/utils.js");

function scratchRoot() {
	const cacheDir = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? tmpdir(), ".cache");
	return mkdtempSync(join(cacheDir, "pi-blender-deferred-test-"));
}

function initMockWorkspace(root) {
	const manifestPath = join(root, "blender-workspace.json");
	const blendPath = join(root, "model.blend");
	writeFileSync(blendPath, "");
	writeFileSync(
		manifestPath,
		JSON.stringify(
			{
				version: 1,
				workspacePath: root,
				manifestPath,
				blendPath,
				template: "blank",
				latestIteration: 1,
				savedViews: {},
				moduleRuns: {},
				renderOutputs: [],
			},
			null,
			2,
		),
	);
	return { workspacePath: root, blendPath, manifestPath };
}

test("dispatchDeferredJob creates job record and tracks in-flight jobs", async () => {
	let resolveWorker;
	const workerPromise = new Promise((resolve) => {
		resolveWorker = resolve;
	});

	const handle = await jobs.dispatchDeferredJob("render", () => workerPromise);
	assert.ok(handle.jobId, "must return jobId");
	assert.equal(handle.state, "running");

	// Status registry check
	const inFlight = await jobs.listInFlightJobs();
	const record = inFlight.find((j) => j.id === handle.jobId);
	assert.ok(record, "job must appear in in-flight list");
	assert.equal(record.state, "running");
	assert.equal(record.type, "render");

	// blenderJobStatus tool query
	const jobStatus = await jobs.blenderJobStatus({ jobId: handle.jobId });
	assert.equal(jobStatus.id, handle.jobId);
	assert.equal(jobStatus.state, "running");

	// Complete the worker
	resolveWorker({ ok: true, output: "test.png" });
	// Wait a tick for promise completion
	await new Promise((r) => setTimeout(r, 50));

	const completedStatus = await jobs.blenderJobStatus({ jobId: handle.jobId });
	assert.equal(completedStatus.state, "completed");
	assert.deepEqual(completedStatus.result, { ok: true, output: "test.png" });

	const inFlightAfter = await jobs.listInFlightJobs();
	assert.ok(!inFlightAfter.some((j) => j.id === handle.jobId), "completed job must not be in-flight");
});

test("blender_bridge_status reports in-flight jobs", async () => {
	let resolveWorker;
	const workerPromise = new Promise((resolve) => {
		resolveWorker = resolve;
	});

	const handle = await jobs.dispatchDeferredJob("montage", () => workerPromise);

	const bridgeStatus = await status.blenderBridgeStatus({}, { isAlive: () => false });
	assert.ok(bridgeStatus.inFlightJobs, "bridgeStatus must include inFlightJobs");
	const found = bridgeStatus.inFlightJobs.find((j) => j.id === handle.jobId);
	assert.ok(found, "dispatched job must be reported in bridge status inFlightJobs");
	assert.equal(found.type, "montage");
	assert.match(bridgeStatus.recommendation, /deferred job.*in flight/i);

	resolveWorker({ done: true });
	await new Promise((r) => setTimeout(r, 50));
});

test("deferred dispatch does not hold bridge.lock and allows concurrent fast operations", async () => {
	let resolveWorker;
	const workerPromise = new Promise((resolve) => {
		resolveWorker = resolve;
	});

	// Dispatch deferred job
	const handle = await jobs.dispatchDeferredJob("render", () => workerPromise);

	// Verify bridge.lock is NOT held by the deferred job dispatch
	const lock = await utils.readBridgeLock();
	assert.equal(lock, null, "bridge.lock must not be held after deferred dispatch");

	// A concurrent caller can immediately acquire the lock without blocking
	const acquired = await utils.acquireBridgeLock({ timeoutMs: 5000, label: "concurrent-fast-check" });
	assert.ok(acquired, "concurrent call must be able to acquire bridge.lock immediately");
	await acquired.release();

	resolveWorker({ done: true });
	await new Promise((r) => setTimeout(r, 50));
});

test("blenderRender with async: true returns handle immediately without blocking", async () => {
	const root = scratchRoot();
	try {
		const ws = initMockWorkspace(root);

		const result = await render.blenderRender({
			cwd: root,
			workspace: ws.workspacePath,
			renderMethod: "background",
			async: true,
		});

		assert.ok(result.jobId, "must return jobId");
		assert.equal(result.state, "running");

		// Bridge status shows in-flight render job
		const bridgeStatus = await status.blenderBridgeStatus({ workspace: ws.workspacePath }, { isAlive: () => false });
		assert.ok(bridgeStatus.inFlightJobs.some((j) => j.id === result.jobId));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
