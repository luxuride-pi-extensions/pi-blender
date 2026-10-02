// Walking up from a cwd to the nearest workspace.
//
// A bare /blender-watch resolves its blend this way, so the only thing that
// can go wrong is the search itself: a miss sends the user to an empty file,
// and an over-eager match sends them to a workspace they never asked for.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

	// The root of the filesystem is outside the scratch tree, so a correct
	// walk reaches it and returns nothing. Asserting `undefined` exactly is
	// what makes this a real test: a match *under* the root would be the bug.
	assert.equal(await findNearestWorkspace(empty), undefined);
});

test("a directory with the manifest's name is not a workspace", async () => {
	const root = await scratchTree();
	const nested = join(root, "looks-wrong");
	await mkdir(nested, { recursive: true });
	// A directory named after the manifest is a plausible accident, and it
	// satisfies every existence check that is not asking for a regular file.
	await mkdir(join(nested, MANIFEST_FILE), { recursive: true });

	assert.equal(await findNearestWorkspace(nested), undefined);
});

test("a real manifest file is preferred over a lookalike directory above it", async () => {
	const root = await scratchTree();
	// The decoy sits between the start directory and the genuine workspace,
	// so accepting it would silently shadow the real one.
	await mkdir(join(root, MANIFEST_FILE), { recursive: true });
	const inner = await makeWorkspace(join(root, "rooms", "kitchen"));

	assert.equal(await findNearestWorkspace(inner), inner);
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

// The recorded workspace: what this session last opened, which is not where
// pi was started.
//
// The manager brief has every agent pass `workspace` explicitly, so the
// workspace in use is routinely somewhere with no workspace above it. That is
// the case a bare /blender-watch has to survive, and the walk alone cannot:
// it would answer "nothing" and send the user to supply a path the session
// already knew.

test("a workspace opened with an explicit path is remembered for a bare /blender-watch", async () => {
	const root = await scratchTree();
	const bridgeDir = join(root, "bridge");
	const previousBridge = process.env.PI_BLENDER_BRIDGE_DIR;
	process.env.PI_BLENDER_BRIDGE_DIR = bridgeDir;
	try {
		// Recorded by loadWorkspaceManifest, which every workspace-opening tool
		// calls -- so this is what any agent's first blender_* call does.
		const { loadWorkspaceManifest } = await loadTs("../blender/workspace.ts");
		const workspace = join(root, "elsewhere", "shower");
		await makeWorkspace(workspace);
		// A workspace manifest names its own path and blend; the `{}` the other
		// tests use is enough for a bare directory search but not for opening.
		await writeFile(
			join(workspace, MANIFEST_FILE),
			JSON.stringify({
				workspacePath: workspace,
				manifestPath: join(workspace, MANIFEST_FILE),
				blendPath: join(workspace, "model.blend"),
			}),
			"utf-8",
		);
		const manifest = await loadWorkspaceManifest(root, workspace);

		const { readRecordedWorkspace } = await loadTs("../blender/workspace.ts");
		assert.equal(await readRecordedWorkspace(), manifest.workspacePath);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_BLENDER_BRIDGE_DIR;
		else process.env.PI_BLENDER_BRIDGE_DIR = previousBridge;
	}
});

test("a record naming a directory that is not a workspace is ignored, not obeyed", async () => {
	const root = await scratchTree();
	const bridgeDir = join(root, "bridge");
	const previousBridge = process.env.PI_BLENDER_BRIDGE_DIR;
	process.env.PI_BLENDER_BRIDGE_DIR = bridgeDir;
	try {
		const { readRecordedWorkspace } = await loadTs("../blender/workspace.ts");
		// A workspace that was deleted, renamed, or lives on a volume that is
		// not mounted right now. Handing this to /blender-watch would fail
		// inside loadWorkspaceManifest with manifest-not-found instead of
		// falling back to the cwd walk that would have worked.
		await mkdir(bridgeDir, { recursive: true });
		await writeFile(
			join(bridgeDir, "current-workspace.json"),
			JSON.stringify({ workspacePath: join(root, "deleted") }),
			"utf-8",
		);
		assert.equal(await readRecordedWorkspace(), undefined);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_BLENDER_BRIDGE_DIR;
		else process.env.PI_BLENDER_BRIDGE_DIR = previousBridge;
	}
});

test("no record at all reads as absent rather than throwing", async () => {
	const root = await scratchTree();
	const previousBridge = process.env.PI_BLENDER_BRIDGE_DIR;
	process.env.PI_BLENDER_BRIDGE_DIR = join(root, "bridge-never-created");
	try {
		const { readRecordedWorkspace } = await loadTs("../blender/workspace.ts");
		assert.equal(await readRecordedWorkspace(), undefined);
	} finally {
		if (previousBridge === undefined) delete process.env.PI_BLENDER_BRIDGE_DIR;
		else process.env.PI_BLENDER_BRIDGE_DIR = previousBridge;
	}
});
