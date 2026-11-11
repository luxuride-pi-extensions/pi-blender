import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const launch = await loadTs(join(REPO, "launch.ts"));

async function blenderAvailable() {
	try {
		const { command, args } = await launch.resolveBlenderArgv();
		execFileSync(command, [...args, "--version"], { stdio: "ignore", timeout: 60_000 });
		return true;
	} catch {
		return false;
	}
}

const available = await blenderAvailable();

describe("the normal-map bake", { skip: available ? false : "no Blender found" }, () => {
	test("test/normal-bake-probe.py passes", async () => {
		const { command, args } = await launch.resolveBlenderArgv();
		const output = execFileSync(
			command,
			[...args, "--background", "--factory-startup", "--python", join(REPO, "test/normal-bake-probe.py")],
			{ encoding: "utf8", timeout: 300_000, maxBuffer: 32 * 1024 * 1024 },
		);
		assert.match(output, /PASS: normal bake writes a packed map and exports it/);
	});

	test("the helper is a render operation, not a stroke table", () => {
		const source = readFileSync(join(REPO, "blender/bake.py"), "utf8");
		assert.match(source, /bpy\.ops\.object\.bake\(type="NORMAL"\)/);
		assert.match(source, /use_selected_to_active = True/);
		assert.match(source, /image\.pack\(\)/);
	});
});
