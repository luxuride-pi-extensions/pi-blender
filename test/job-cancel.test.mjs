import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTs } from "./paths.mjs";

/**
 * Cancellation is a decision that must survive the worker. These tests pin the
 * final state, not just the abort: a worker that rejects after being cancelled
 * must not rewrite the record as failed.
 */

const root = mkdtempSync(join(tmpdir(), "pi-blender-jobs-"));
process.env.PI_BLENDER_BRIDGE_DIR = root;
after(() => rmSync(root, { recursive: true, force: true }));
const { dispatchDeferredJob, cancelJob, blenderJobStatus } = await loadTs("../blender/jobs.ts");

function neverFinishes(signal) {
	return new Promise((_, reject) => {
		signal.addEventListener("abort", () => reject(new Error("aborted")));
	});
}

test("a cancelled job records the decision and the worker cannot overwrite it", async () => {
	const handle = await dispatchDeferredJob("render", neverFinishes, { workspace: "w" });
	await new Promise((resolve) => setTimeout(resolve, 5));
	const cancelled = await cancelJob(handle.jobId, "the user changed the camera");
	assert.equal(cancelled.state, "cancelled");
	assert.equal(cancelled.cancelReason, "the user changed the camera");

	await new Promise((resolve) => setTimeout(resolve, 20));
	const later = await blenderJobStatus({ jobId: handle.jobId });
	assert.equal(later.state, "cancelled");
	assert.equal(later.cancelReason, "the user changed the camera");
});

test("a completed job is reported, not silently cancelled", async () => {
	const handle = await dispatchDeferredJob("compare", async () => ({ ok: true }));
	await new Promise((resolve) => setTimeout(resolve, 20));
	await assert.rejects(() => cancelJob(handle.jobId), /already completed/);
	assert.equal((await blenderJobStatus({ jobId: handle.jobId })).state, "completed");
});

test("an unknown id is refused", async () => {
	await assert.rejects(
		() => cancelJob("00000000-0000-4000-8000-000000000000"),
		/not found in job registry/,
	);
});
