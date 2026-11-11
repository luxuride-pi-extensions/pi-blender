/**
 * The headless budget is a machine property, not a process property.
 *
 * A fan-out used to multiply it: four workers each resolved the same limit and
 * admitted it, so a 16-run ceiling became 64 Blenders. These tests hold the
 * admission primitive to the session-wide reading: a second contender waits
 * while the budget is taken, a dead owner's slot is swept instead of blocking
 * forever, and concurrent contenders never exceed the limit together.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { JITI, loadTs } from "./paths.mjs";

const LEASES = fileURLToPath(new URL("../blender/run-leases.ts", import.meta.url));
const bridge = mkdtempSync(join(tmpdir(), "pi-blender-slots-"));
const env = { PI_BLENDER_BRIDGE_DIR: bridge };
process.on("exit", () => rmSync(bridge, { recursive: true, force: true }));

test("a slot is not granted past the limit until one is released", async () => {
	const { acquireHeadlessSlot, releaseHeadlessSlot } = await loadTs(LEASES, env);
	const first = await acquireHeadlessSlot(2);
	const second = await acquireHeadlessSlot(2);
	let thirdAdmitted = false;
	const third = acquireHeadlessSlot(2).then((slot) => {
		thirdAdmitted = true;
		return slot;
	});
	await new Promise((resolve) => setTimeout(resolve, 350));
	assert.equal(thirdAdmitted, false, "a third run was admitted while two slots were held");
	releaseHeadlessSlot(first);
	const thirdSlot = await Promise.race([
		third,
		new Promise((resolve) => setTimeout(() => resolve(null), 3_000)),
	]);
	assert.notEqual(thirdSlot, null, "releasing a slot did not admit the waiter");
	releaseHeadlessSlot(second);
	releaseHeadlessSlot(thirdSlot);
});

test("a slot left by a dead process is swept, not waited on forever", async () => {
	const { acquireHeadlessSlot, releaseHeadlessSlot } = await loadTs(LEASES, env);
	// 2_147_483_647 is above any Linux pid the kernel will hand out.
	writeFileSync(join(bridge, "headless-slots", "slot-0.json"), JSON.stringify({ pid: 2_147_483_647 }));
	const slot = await acquireHeadlessSlot(1);
	assert.equal(slot.index, 0);
	releaseHeadlessSlot(slot);
});

test("concurrent contenders never hold more slots than the limit", async () => {
	const limit = 2;
	const workers = [];
	const admitted = [];
	const holders = new Map();
	for (let index = 0; index < 5; index += 1) {
		const worker = new Worker(new URL("./slot-worker.mjs", import.meta.url), {
			workerData: { jiti: JITI, limit, module: LEASES },
		});
		worker.on("error", () => {});
		worker.on("message", (message) => {
			if (message.event === "admitted") {
				admitted.push(message.index);
				holders.set(message.index, worker);
			}
		});
		workers.push(worker);
	}
	const waitFor = async (count, ms) => {
		const started = Date.now();
		while (admitted.length < count && Date.now() - started < ms) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	};
	await waitFor(limit, 5_000);
	assert.equal(admitted.length, limit, `expected ${limit} concurrent admissions, saw ${admitted.length}`);
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(admitted.length, limit, "a contender was admitted while the budget was full");
	holders.values().next().value.postMessage("release");
	await waitFor(limit + 1, 5_000);
	assert.equal(admitted.length, limit + 1, "releasing one slot did not admit exactly one waiter");
	await Promise.all(workers.map((worker) => worker.terminate()));
	rmSync(join(bridge, "headless-slots"), { recursive: true, force: true });
	const { acquireHeadlessSlot, releaseHeadlessSlot } = await loadTs(LEASES, env);
	const slot = await acquireHeadlessSlot(limit);
	assert.equal(slot.index, 0);
	releaseHeadlessSlot(slot);
});
