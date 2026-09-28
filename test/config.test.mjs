/**
 * Behavioural tests for the parts of this extension that decide WHERE things
 * live: the session instance id, the bridge/temp dir resolution, the ownership
 * record, and the manager prompt assembly.
 *
 * These are the pieces where a mistake is silent. A wrong bridge dir does not
 * throw -- it points at a directory no Blender polls, and the next request
 * launches a second UI. A traversal in the instance id does not throw either;
 * it just relocates state outside the bridge root. So the tests assert resolved
 * PATHS and exact rejections, not that functions merely run.
 *
 * Every case runs in a child process via test/probe.mjs, because config.ts mints
 * the instance id at module load and jiti caches modules per instance. See
 * probe.mjs for why escaping the cache is the whole problem.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = fileURLToPath(new URL("./probe.mjs", import.meta.url));

/** A scratch XDG cache root, so nothing here reads or writes the real one. */
function scratchCache() {
	return mkdtempSync(join(tmpdir(), "vibe-blender-test-"));
}

/**
 * Resolve config.ts in a fresh process under `extra` env.
 *
 * `null` deletes a var, because "set to undefined" is not the same thing to a
 * child process: it would arrive as the literal string "undefined".
 */
function probe(extra = {}) {
	const base = {
		PI_BLENDER_INSTANCE_ID: null,
		PI_BLENDER_BRIDGE_DIR: null,
		PI_BLENDER_TMP_DIR: null,
		PI_BLENDER_BLANK_BLEND_PATH: null,
		XDG_CACHE_HOME: scratchCache(),
		...extra,
	};
	const out = execFileSync(process.execPath, [PROBE, JSON.stringify(base)], {
		encoding: "utf8",
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(out);
}

test("an inherited instance id is used verbatim", () => {
	const result = probe({ PI_BLENDER_INSTANCE_ID: "abc123def456" });
	assert.equal(result.instanceId, "abc123def456");
});

test("an absent instance id mints 12 hex characters", () => {
	assert.match(probe().instanceId, /^[0-9a-f]{12}$/);
});

test("instance ids that could escape the bridge root are refused", () => {
	// The id becomes a path segment, and the env var is untrusted input: a
	// "../../" there would redirect the bridge dir out of the bridge root.
	const hostile = ["..", ".", "../escape", "a/b", "a\\b", "", "   ", "a b", "x".repeat(65), "../../etc"];
	for (const value of hostile) {
		const result = probe({ PI_BLENDER_INSTANCE_ID: value });
		assert.match(result.instanceId, /^[0-9a-f]{12}$/, `refused ${JSON.stringify(value)} but got ${result.instanceId}`);
	}
});

test("a valid but unusual id survives intact", () => {
	// The guard must reject traversal, not be so strict it breaks real ids. A
	// leading dash is fine: it is not traversal, and `-` is inside the allowed
	// character set.
	for (const value of ["a", "A1.b2_c3-d4", "0".repeat(64), "..leading", "trailing..", "-lead-dash"]) {
		assert.equal(probe({ PI_BLENDER_INSTANCE_ID: value }).instanceId, value, `wrongly refused ${value}`);
	}
});

test("the bridge dir nests the instance id under the XDG cache root by default", () => {
	const cache = scratchCache();
	const result = probe({ PI_BLENDER_INSTANCE_ID: "sess0000abcd", XDG_CACHE_HOME: cache });
	assert.equal(result.bridgeRoot, join(cache, "vibe-blender", "bridge"));
	assert.equal(result.bridgeDir, join(cache, "vibe-blender", "bridge", "sess0000abcd"));
	assert.equal(result.hasBridgeDirOverride, false);
	rmSync(cache, { recursive: true, force: true });
});

test("a bridge dir override is used EXACTLY, with no instance subdirectory", () => {
	// Someone who sets this is naming one bridge on purpose, to share a UI with
	// another process. Nesting a subdir under it gives a Blender that can never
	// see the requests.
	const pinned = join(tmpdir(), "vibe-blender-pinned-bridge");
	const result = probe({ PI_BLENDER_BRIDGE_DIR: pinned });
	assert.equal(result.bridgeDir, pinned);
	assert.equal(result.hasBridgeDirOverride, true);
});

test("a ~-relative bridge dir override expands against the home directory", () => {
	assert.equal(probe({ PI_BLENDER_BRIDGE_DIR: "~/some-bridge" }).bridgeDir, join(homedir(), "some-bridge"));
});

test("a relative bridge dir override resolves against the cwd", () => {
	assert.equal(probe({ PI_BLENDER_BRIDGE_DIR: "./rel-bridge" }).bridgeDir, join(process.cwd(), "rel-bridge"));
});

test("the temp dir honours its override and creates what it returns", () => {
	const root = scratchCache();
	const wanted = join(root, "nested", "tmp");
	assert.equal(probe({ PI_BLENDER_TMP_DIR: wanted }).tempDir, wanted);
	assert.ok(existsSync(wanted), "the dir it hands to Blender must already exist");
	rmSync(root, { recursive: true, force: true });
});

test("the blank bootstrap blend is per-instance", () => {
	// Two Blenders sharing one bootstrap blend overwrite each other's.
	const a = probe({ PI_BLENDER_INSTANCE_ID: "aaaaaaaaaaaa" });
	const b = probe({ PI_BLENDER_INSTANCE_ID: "bbbbbbbbbbbb" });
	assert.notEqual(a.blankPath, b.blankPath);
	assert.ok(a.blankPath.endsWith("aaaaaaaaaaaa.blend"));
});

test("the bundled bridge script lives under this extension's assets dir", () => {
	const result = probe();
	assert.ok(result.bridgeScript.startsWith(result.assetsDir), "the bridge script resolved outside the extension");
	assert.ok(existsSync(result.bridgeScript), "the bundled live-bridge.py is missing from the install");
});

test("the manager prompt carries the exchange contract after the manager prompt", () => {
	const prompt = probe().managerPrompt;
	// The contract is appended, not inlined, and it is the piece carrying the
	// STOP CONDITIONS -- the absence of which produced a 44-turn run that
	// repeated one traceback four times.
	const briefAt = prompt.indexOf("## BRIEF");
	const stopAt = prompt.indexOf("## STOP CONDITIONS");
	assert.ok(briefAt > 0, "the BRIEF skeleton is missing from the manager prompt");
	assert.ok(stopAt > briefAt, "STOP CONDITIONS must follow BRIEF");
	assert.ok(prompt.includes("## Fan out to several workers at once"), "the manager prompt body is missing");
});

test("manager prompt frontmatter is stripped", () => {
	const prompt = probe().managerPrompt;
	// `tools:` and `extensions:` are a spawnable child's contract. A command
	// session gets its tools from the extension it is already running, so a
	// stray tools: line here is both inert and misleading.
	assert.ok(!prompt.startsWith("---"), "frontmatter delimiter leaked into the system prompt");
	assert.ok(!/^tools:/m.test(prompt), "a tools: line leaked into the system prompt");
	assert.ok(!/^extensions:/m.test(prompt), "an extensions: line leaked into the system prompt");
});

test("writeInstanceFile publishes an atomic per-pid ownership record", () => {
	const dir = join(scratchCache(), "bridge");
	const out = execFileSync(process.execPath, [PROBE, JSON.stringify({
		PI_BLENDER_INSTANCE_ID: null,
		PI_BLENDER_BRIDGE_DIR: dir,
		PI_PROBE_WRITE_INSTANCE: "1",
	})], { encoding: "utf8", env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
	const result = JSON.parse(out);

	assert.equal(result.shared.pid, result.ownerPid, "instance.json and the per-pid record must name the same pid");
	assert.equal(result.shared.instanceId, result.instanceId);
	// Separate files per pid, so two owners cannot clobber each other's entry.
	assert.equal(result.ownerExists, true, "the per-pid ownership record is missing");
	// Atomic publish: a torn read makes a sweep classify a LIVE peer's dir as an
	// orphan, so no temp file may survive the rename.
	assert.deepEqual(result.leftoverTmp, [], "a temp file was left behind, so the rename did not happen");
	rmSync(dir, { recursive: true, force: true });
});
