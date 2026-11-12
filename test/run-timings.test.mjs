import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const root = new URL("..", import.meta.url).pathname;
const { formatTimings } = await loadTs("../blender/timings.ts");

test("the branch script measures launch, import, exec, save and render", async () => {
	const source = await readFile(join(root, "blender/branch.ts"), "utf8");
	for (const field of ["launchMs", "importMs", "execMs", "saveMs", "renderMs", "totalMs", "processStartedAt"]) {
		assert.match(source, new RegExp(`"${field}"`), `branch payload must report ${field}`);
	}
	assert.match(source, /processStartedAt - spawnAt/, "launch is the gap before the script starts");
	assert.match(source, /timings,\n\t\tresolvedEngine/, "the result carries timings, not only the payload");
});

test("the apply reports its own stages and both record them", async () => {
	const branch = await readFile(join(root, "blender/branch.ts"), "utf8");
	assert.match(branch, /applyTimings = \{/, "apply timings are captured");
	assert.match(branch, /timings: applyTimings/, "the apply record stores them");
	const module = await readFile(join(root, "blender/iteration-state.ts"), "utf8");
	assert.match(module, /run\.timings\?\.launchMs/, "iteration state aggregates launch time");
	assert.match(module, /totalMs: timed\.reduce/, "iteration state aggregates total time");
});

test("the tool text opens with one readable timing line", () => {
	assert.equal(formatTimings(undefined), "");
	const line = formatTimings({ launchMs: 2500, execMs: 100, saveMs: 20, renderMs: 41000, totalMs: 43620 });
	assert.equal(line, "2.5s launch, 0.1s exec, 41.0s render (43.6s total)");
});
