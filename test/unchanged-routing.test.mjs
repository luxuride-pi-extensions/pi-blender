import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const branch = readFileSync(new URL("../blender/branch.ts", import.meta.url), "utf8");
const module = readFileSync(new URL("../blender/module.ts", import.meta.url), "utf8");

test("an unchanged branch is not applied and its render is reused", () => {
	assert.match(branch, /render_attempted = exit_code == 0 and bool\(render_request\) and not preflight_blocked and bool\(changed or payload\.get\("forceRender"\)\)/);
	assert.match(branch, /reason: "unchanged"/);
	assert.match(branch, /mark\(record\.sequence, "unchanged"\)/);
});

test("the module path treats an unchanged apply as success", () => {
	assert.match(module, /unchanged && branchResult\.changed === false/);
	assert.match(module, /no fingerprint-visible change; model\.blend was not rewritten/);
});

test("the reuse key covers only picture inputs", () => {
	const key = branch.slice(branch.indexOf("const renderKey = JSON.stringify"), branch.indexOf("});", branch.indexOf("const renderKey = JSON.stringify")));
	assert.match(key, /profile: cameraPlan\.profile/);
	assert.match(key, /shots: cameraPlan\.shots/);
	assert.doesNotMatch(key, /cameraPlan,\s*$/m);
});
