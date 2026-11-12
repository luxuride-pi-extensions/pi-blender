import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./paths.mjs";

const { assertBuildTransition, buildExportGate, readBuildState } = await loadTs("../blender/build-state.ts");

test("the build contract refuses the skip that loses work", () => {
	assert.throws(() => assertBuildTransition("staged", "exported"), /cannot move to "exported"/);
	assert.throws(() => assertBuildTransition("intake", "finalized"), /cannot move/);
	assert.throws(() => assertBuildTransition("merged", "staged"), /cannot move/);
});

test("a critic may judge a staged generation and the apply may follow it", () => {
	assert.doesNotThrow(() => assertBuildTransition("staged", "critiqued"));
	assert.doesNotThrow(() => assertBuildTransition("critiqued", "applied"));
	assert.doesNotThrow(() => assertBuildTransition("applied", "merged"));
	assert.doesNotThrow(() => assertBuildTransition("merged", "critiqued"));
	assert.doesNotThrow(() => assertBuildTransition("critiqued", "finalized"));
	assert.doesNotThrow(() => assertBuildTransition("finalized", "exported"));
	assert.throws(() => assertBuildTransition("exported", "finalized"), /nothing \(it is exported\)/);
});

test("export is gated only once a build exists, and allowUnfinalized is explicit", () => {
	assert.equal(buildExportGate({}, false), null);
	const staged = { build: { stage: "staged", history: [] } };
	assert.match(buildExportGate(staged, false) ?? "", /not "finalized"/);
	assert.equal(buildExportGate(staged, true), null);
	assert.equal(buildExportGate({ build: { stage: "finalized", history: [] } }, false), null);
});

test("an absent build reads as intake rather than undefined", () => {
	assert.deepEqual(readBuildState({}), { stage: "intake", history: [] });
});
