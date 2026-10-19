import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const load = (name) => loadTs(join(REPO, name));

const launch = await load("launch.ts");

describe("install detection and version floor (#25)", () => {
	test("version floor is 4.2.0 and correctly parses version strings", () => {
		assert.equal(launch.BLENDER_VERSION_FLOOR, "4.2.0");

		assert.equal(
			launch.parseBlenderVersion("Blender 4.2.0 LTS (hash abcdef built 2024-07-16)"),
			"4.2.0",
		);
		assert.equal(
			launch.parseBlenderVersion("Blender 5.2.0 (hash fbe6228777e7 built 2026-07-14 01:32:04)"),
			"5.2.0",
		);
		assert.equal(
			launch.parseBlenderVersion("Blender 3.6.14 LTS"),
			"3.6.14",
		);
		assert.equal(launch.parseBlenderVersion("Some other program 1.0"), null);
	});

	test("isBlenderVersionSufficient checks against version floor 4.2.0", () => {
		assert.equal(launch.isBlenderVersionSufficient("4.2.0"), true);
		assert.equal(launch.isBlenderVersionSufficient("4.2.1"), true);
		assert.equal(launch.isBlenderVersionSufficient("4.3.0"), true);
		assert.equal(launch.isBlenderVersionSufficient("5.0.0"), true);
		assert.equal(launch.isBlenderVersionSufficient("5.2.0"), true);

		// Versions below 4.2.0 must fail
		assert.equal(launch.isBlenderVersionSufficient("4.1.9"), false);
		assert.equal(launch.isBlenderVersionSufficient("4.1.0"), false);
		assert.equal(launch.isBlenderVersionSufficient("4.0.2"), false);
		assert.equal(launch.isBlenderVersionSufficient("3.6.0"), false);
		assert.equal(launch.isBlenderVersionSufficient("2.93.0"), false);
	});

	test("assertBlenderVersionFloor throws actionable upgrade message on sub-floor versions", () => {
		// Valid versions pass without throwing and return the parsed version
		assert.equal(
			launch.assertBlenderVersionFloor("Blender 4.2.0 LTS", "blender"),
			"4.2.0",
		);
		assert.equal(
			launch.assertBlenderVersionFloor("Blender 5.2.0", "blender"),
			"5.2.0",
		);

		// Sub-floor versions throw with actionable guidance
		assert.throws(
			() => launch.assertBlenderVersionFloor("Blender 3.6.0 LTS", "blender"),
			/Blender version 3\.6\.0 found at 'blender', but pi-blender requires Blender >= 4\.2\.0/,
		);

		assert.throws(
			() => launch.assertBlenderVersionFloor("Blender 4.1.1", "/usr/bin/blender"),
			/Please upgrade Blender or set BLENDER_PATH/,
		);
	});

	test("resolveBlenderArgv respects BLENDER_PATH environment override", async () => {
		const prev = process.env.BLENDER_PATH;
		try {
			launch.clearCachedBlenderArgv();
			process.env.BLENDER_PATH = "/custom/blender/path --custom-flag";
			const resolved = await launch.resolveBlenderArgv();
			assert.equal(resolved.command, "/custom/blender/path");
			assert.deepEqual(resolved.args, ["--custom-flag"]);
		} finally {
			if (prev === undefined) {
				delete process.env.BLENDER_PATH;
			} else {
				process.env.BLENDER_PATH = prev;
			}
			launch.clearCachedBlenderArgv();
		}
	});

	test("real Blender on host meets version floor", async () => {
		launch.clearCachedBlenderArgv();
		const { command, args } = await launch.resolveBlenderArgv();
		try {
			const versionOut = execFileSync(command, [...args, "--version"], {
				encoding: "utf8",
				timeout: 30_000,
			});
			const verifiedVersion = launch.assertBlenderVersionFloor(versionOut, command);
			assert.ok(verifiedVersion, "Host Blender version must parse");
		} catch (err) {
			if (err.code === "ENOENT") {
				// No blender installed in environment; skipped in pure CI without blender
				return;
			}
			throw err;
		}
	});
});
