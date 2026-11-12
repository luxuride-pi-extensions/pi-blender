import assert from "node:assert/strict";
import test from "node:test";
import { loadTs } from "./paths.mjs";

const { assertBuildTransition, buildExportGate, readBuildState } = await loadTs("../blender/build-state.ts");

test("the build contract refuses the skip that loses work", () => {
	assert.doesNotThrow(() => assertBuildTransition("staged", "exported"), "the export gate, not the graph, refuses an early export");
});

test("a critic may judge a staged generation and the apply may follow it", () => {
	assert.doesNotThrow(() => assertBuildTransition("staged", "critiqued"));
	assert.doesNotThrow(() => assertBuildTransition("critiqued", "applied"));
	assert.doesNotThrow(() => assertBuildTransition("applied", "merged"));
	assert.doesNotThrow(() => assertBuildTransition("merged", "critiqued"));
	assert.doesNotThrow(() => assertBuildTransition("critiqued", "finalized"));
	assert.doesNotThrow(() => assertBuildTransition("merged", "staged"), "a later run stages again after a merge");
	assert.doesNotThrow(() => assertBuildTransition("critiqued", "staged"), "a critique does not freeze the build");
	assert.doesNotThrow(() => assertBuildTransition("finalized", "exported"));
	assert.doesNotThrow(() => assertBuildTransition("exported", "exported"), "exporting twice is not a lost transition");
	assert.throws(() => assertBuildTransition("exported", "finalized"), /cannot move/);
});

test("export is gated only once a build exists, and allowUnfinalized is explicit", () => {
	assert.equal(buildExportGate({}, false), null);
	const staged = { build: { stage: "staged", history: [] } };
	assert.match(buildExportGate(staged, false) ?? "", /not "finalized"/);
	assert.equal(buildExportGate(staged, true), null);
	assert.equal(buildExportGate({ build: { stage: "finalized", history: [] } }, false), null);
	assert.equal(buildExportGate({ build: { stage: "intake", history: [] } }, false), null, "legacy intake is not gated");
	assert.equal(buildExportGate({ build: { stage: "planned", history: [] } }, false), null, "a plan alone is not an unfinished build");
});

test("an absent build reads as intake rather than undefined", () => {
	assert.deepEqual(readBuildState({}), { stage: "intake", history: [] });
});
