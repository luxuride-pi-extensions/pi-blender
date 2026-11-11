import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

function blender() {
	for (const prefix of [["flatpak", "run", "org.blender.Blender"], ["blender"]]) {
		const probe = spawnSync(prefix[0], [...prefix.slice(1), "--version"], { encoding: "utf8", timeout: 60_000 });
		if (!probe.error && probe.status === 0) return prefix;
	}
	return null;
}

const argv = blender();
test("documented modeling snippets hold in a real Blender", { skip: argv ? false : "no headless Blender available" }, () => {
	const result = spawnSync(
		argv[0],
		[...argv.slice(1), "--background", "--python", join(import.meta.dirname, "modeling-snippets.py")],
		{ encoding: "utf8", timeout: 180_000 },
	);
	const output = `${result.stdout}\n${result.stderr}`;
	assert.equal(result.status, 0, output);
	const line = result.stdout.split("\n").find((entry) => entry.trim().startsWith('{"ok"'));
	assert.ok(line, `no result line in ${output}`);
	const parsed = JSON.parse(line);
	assert.equal(parsed.ok, true, JSON.stringify(parsed.checks));
	for (const [name, value] of Object.entries(parsed.checks)) {
		assert.equal(value, true, name);
	}
});
