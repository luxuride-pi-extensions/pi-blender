// A failing Blender script leaves two traces: a traceback on stderr and whatever
// the script printed on stdout, which is usually the measurements that explain
// the failure. The error message used to keep only one of them, so the half that
// said what the script was doing was discarded in favour of a bare RuntimeError.
//
// This asserts the SHAPE of the message rather than the exit path, because
// reaching the throw means starting a real Blender: the formatting is the part
// that can regress silently, because picking one stream still produces a
// perfectly readable error.

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadTs } from "./paths.mjs";

const { formatBlenderFailure } = await loadTs("../blender/utils.ts");

test("a failing script keeps both streams", () => {
	const message = formatBlenderFailure({
		streams: {
			stdout: "ray origin (0, 0, 0) hit nothing\nray origin (0, 0, 0.5) hit the floor",
			stderr: "Traceback (most recent call last):\n  RuntimeError: no such object",
		},
		subject: "Blender exited with code 1",
	});

	assert.match(message, /ray origin/);
	assert.match(message, /hit the floor/);
	assert.match(message, /RuntimeError/);
	assert.match(message, /Blender exited with code 1/);
});

test("an empty stream is labelled rather than left blank", () => {
	const message = formatBlenderFailure({
		streams: { stdout: "   \n", stderr: "RuntimeError: boom" },
		subject: "Blender exited with code 1",
	});

	assert.match(message, /--- stdout ---\n\(empty\)/);
	assert.match(message, /--- stderr ---\nRuntimeError: boom/);
});

test("the subject comes first, so it is never buried under a long trace", () => {
	const message = formatBlenderFailure({
		streams: { stdout: "a".repeat(500), stderr: "b".repeat(500) },
		subject: 'Module "legs" script failed (exit 1).',
	});

	assert.ok(message.startsWith('Module "legs" script failed (exit 1).'));
});
