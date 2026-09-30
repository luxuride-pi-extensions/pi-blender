import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadTs } from "./paths.mjs";

// Same reasoning as module-manifest.test.mjs, applied to the critique budget:
// the thing it guards is a decision that must be made atomically, so it is
// factored into a pure function on the manifest and asserted here rather than
// through concurrent calls into a real workspace.
const { claimCritiqueBudget, MAX_ITERATIONS_PER_MODULE } = await loadTs("../blender/critique.ts");

const manifest = (overrides = {}) => ({ version: 2, ...overrides });

describe("the critique budget", () => {
	it("starts a module at one", () => {
		const current = manifest();
		assert.equal(claimCritiqueBudget(current, "shirt", false), 1);
		assert.equal(current.critiqueCounts.shirt, 1);
	});

	it("advances one per critique", () => {
		const current = manifest();
		assert.deepEqual(
			[false, false, false].map((present) => claimCritiqueBudget(current, "shirt", present)),
			[1, 2, 3],
		);
	});

	it("keeps each module's budget separate", () => {
		const current = manifest();
		claimCritiqueBudget(current, "shirt", false);
		claimCritiqueBudget(current, "shirt", false);
		claimCritiqueBudget(current, "trousers", false);
		assert.deepEqual(current.critiqueCounts, { shirt: 2, trousers: 1 });
	});

	it("resets a module's budget when it presents", () => {
		const current = manifest();
		claimCritiqueBudget(current, "shirt", false);
		claimCritiqueBudget(current, "shirt", false);
		assert.equal(claimCritiqueBudget(current, "shirt", true), 1);
		assert.equal(current.critiqueCounts.shirt, 1);
	});

	it("does not reset a sibling's budget when one presents", () => {
		const current = manifest();
		claimCritiqueBudget(current, "shirt", false);
		claimCritiqueBudget(current, "shirt", false);
		claimCritiqueBudget(current, "trousers", false);
		claimCritiqueBudget(current, "shirt", true);
		assert.equal(current.critiqueCounts.shirt, 1);
		assert.equal(current.critiqueCounts.trousers, 1);
	});

	it("reaches the cap exactly at MAX_ITERATIONS_PER_MODULE", () => {
		const current = manifest();
		const seen = [];
		for (let i = 0; i < 8; i += 1) {
			seen.push(claimCritiqueBudget(current, "shirt", false));
		}
		assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8]);
		assert.ok(MAX_ITERATIONS_PER_MODULE === 5);
	});

	it("tolerates a legacy manifest with no critiqueCounts", () => {
		const current = manifest();
		assert.equal(claimCritiqueBudget(current, "shirt", false), 1);
		assert.deepEqual(current.critiqueCounts, { shirt: 1 });
	});

	it("keeps counts it did not touch", () => {
		const current = manifest({ critiqueCounts: { trousers: 3 } });
		claimCritiqueBudget(current, "shirt", false);
		assert.equal(current.critiqueCounts.trousers, 3);
	});

	it("names the module even when a name carries odd characters", () => {
		const current = manifest();
		claimCritiqueBudget(current, "left boot v2", false);
		assert.equal(current.critiqueCounts["left boot v2"], 1);
	});
});
