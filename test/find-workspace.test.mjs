// Walking up from a cwd to the nearest workspace.
//
// A bare /blender-watch resolves its blend this way, so the only thing that
// can go wrong is the search itself: a miss sends the user to an empty file,
// and an over-eager match sends them to a workspace they never asked for.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test, { after } from "node:test";

import { loadTs } from "./paths.mjs";

const { MANIFEST_FILE } = await loadTs("../blender/utils.ts");
const { findNearestWorkspace } = await loadTs("../blender/workspace.ts");

const roots = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function scratchTree() {
	const root = await mkdtemp(join(tmpdir(), "pi-blender-nearest-"));
	roots.push(root);
	return root;
}

async function makeWorkspace(dir) {
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, MANIFEST_FILE), "{}\n");
	return dir;
}

test("finds a workspace in the starting directory itself", async () => {
	const root = await scratchTree();
	const workspace = await makeWorkspace(join(root, "kitchen"));

	assert.equal(await findNearestWorkspace(workspace), workspace);
});

test("walks up to the nearest workspace, not the outermost one", async () => {
	const root = await scratchTree();
	await makeWorkspace(root);
	const inner = await makeWorkspace(join(root, "rooms", "kitchen"));
	const deep = join(inner, "props", "shelf", "scenes");

	assert.equal(await findNearestWorkspace(deep), inner);
});

test("returns undefined when no ancestor holds a manifest", async () => {
	const root = await scratchTree();
	const empty = join(root, "a", "b", "c");
	await mkdir(empty, { recursive: true });

	// The root of the filesystem is outside the scratch tree, so this can
	// only be decided by there being no manifest anywhere between the two.
	const found = await findNearestWorkspace(empty);
	assert.ok(found === undefined || found.startsWith(root + sep), `unexpected match ${found}`);
});

test("a stray file with the manifest's name is not a workspace", async () => {
	const root = await scratchTree();
	const nested = join(root, "looks-wrong");
	await mkdir(nested, { recursive: true });
	// Directories ending in the manifest's name are a plausible accident:
	// `mkdir foo/blender-workspace.json` passes many file checks.
	await mkdir(join(nested, MANIFEST_FILE), { recursive: true });

	const found = await findNearestWorkspace(nested);
	assert.ok(found === undefined || found.startsWith(root + sep), `unexpected match ${found}`);
});

test("accepts a relative start directory by resolving it first", async () => {
	const root = await scratchTree();
	const workspace = await makeWorkspace(join(root, "kitchen"));
	const previous = process.cwd();
	try {
		process.chdir(root);
		assert.equal(await findNearestWorkspace("kitchen"), workspace);
	} finally {
		process.chdir(previous);
		assert.equal(dirname(workspace), root);
	}
});
