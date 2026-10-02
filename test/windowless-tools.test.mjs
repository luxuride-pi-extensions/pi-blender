// The two windowed-only tools in a session that never ran /blender-watch: the
// DEFAULT session, the one a user reaches through /blender.
//
// They used to raise NoWatchWindowError, whose message ended "run
// /blender-watch to open the one window this session may have". An agent cannot
// run a slash command, so that message gave it nothing to do but stop -- and a
// paint worker's loop, which mandates blender_set_mode before the critic, died
// there with the paint itself already applied. So both now report a skipped
// outcome and the build continues.
//
// This reads index.ts as TEXT for the same reason tool-params.test.mjs does:
// the defect being guarded is a promise made in a description, and nothing
// short of reading the description can show whether it is still made.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

/** One tool's `description:` string, joined across its continuation lines. */
function toolDescription(name) {
	const start = indexSource.indexOf(`name: "${name}"`);
	assert.notEqual(start, -1, `${name} is not registered in index.ts`);
	const from = indexSource.indexOf("description:", start);
	assert.notEqual(from, -1, `${name} has no description`);
	// The description ends at the first line that is only the closing quote and
	// semicolon, which is how every description in this file is written.
	const end = indexSource.indexOf('",', from);
	assert.notEqual(end, -1, `${name}'s description never closes`);
	return indexSource.slice(from, end);
}

test("neither windowed-only tool tells an agent to run a slash command", () => {
	for (const name of ["blender_set_mode", "blender_save_view"]) {
		const description = toolDescription(name);
		assert.doesNotMatch(
			description,
			/NEEDS A WINDOW(?!.*reason)/i,
			`${name}'s description still advertises a hard window requirement, which is what makes an agent treat it as a blocking step.`,
		);
		assert.doesNotMatch(
			description,
			/runs? \/blender-watch first/i,
			`${name}'s description still tells the caller to open a window first. Only the user can do that.`,
		);
	}
});

test("blender_set_mode documents the skipped outcome a windowless run gets", () => {
	const description = toolDescription("blender_set_mode");
	assert.match(description, /switched:\s*false/, "the description must name the field that reports the skip, or a caller cannot check for it");
	assert.match(description, /instead of failing/, "a caller needs to know this is a normal outcome, not an error to catch");
});

test("blender_save_view documents that a skipped capture writes nothing", () => {
	const description = toolDescription("blender_save_view");
	assert.match(description, /savedView:\s*null/, "the description must name the field that reports the skip");
	// The reason it writes nothing rather than a placeholder is that a view
	// bound to a camera that was never created makes every later render through
	// it silently wrong, which is worse than a missing view.
	assert.match(description, /Nothing is written to the manifest/, "the description must say the manifest is left untouched, not that a view is bound anyway");
});

test("the error text no longer tells the caller to run a command it cannot run", () => {
	const bridgeSource = readFileSync(new URL("../blender/bridge.ts", import.meta.url), "utf8");
	const constructor = bridgeSource.slice(bridgeSource.indexOf("export class NoWatchWindowError"));
	assert.match(
		constructor,
		/CANNOT open the window/i,
		"NoWatchWindowError must say an agent cannot open the window itself; the old wording ended 'run /blender-watch', which an agent cannot act on.",
	);
	assert.match(constructor, /do not stop the build/i, "the error must say the build continues, because an agent's only move against a dead end is to stop");
});
