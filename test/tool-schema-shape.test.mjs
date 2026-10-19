// A tool schema that is valid draft-07 but that strict providers reject takes
// down the ENTIRE request, not just the one tool: the 400 comes back before any
// tool runs, so the session cannot start at all.
//
// That is what happened with blender_geometry_probe's `points`. It was declared
// as `Type.Array(Type.Tuple([Type.Number(), Type.Number()]))`, and a TypeBox
// tuple serializes to a POSITIONAL `items` array:
//
//     { "items": [ { "type": "number" }, { "type": "number" } ] }
//
// The JSON-Schema spec allows that (draft-07 tuples), but OpenAI-style function
// schemas do not: `items` must be a schema object. StreamLake rejected it with
//
//     Tool 22 function has invalid 'parameters' schema:
//     [{'type': 'number'}, {'type': 'number'}] is not of type 'object', 'boolean'
//
// and every message in the session failed with a 400.
//
// The fix expresses "two numbers" as a BOUNDED ARRAY, which serializes `items`
// as an object plus minItems/maxItems — the form every provider accepts. This
// file pins both halves of that: the mechanism (below, executable) and the
// absence of the trap in index.ts (by text, for the same reason tool-params
// .test.mjs reads text — index.ts cannot be imported without the manager-core
// extension, which is not installed in a bare checkout).

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Type } from "typebox";

const sourcePath = existsSync(new URL("../core/tools.ts", import.meta.url))
	? "../core/tools.ts"
	: "../index.ts";
const indexSource = readFileSync(new URL(sourcePath, import.meta.url), "utf8");

/**
 * Tool source with comment lines removed.
 *
 * Comments here DOCUMENT the ban, quoting the very call that is banned, so a
 * naive text scan fires on its own explanation. Only real code is checked.
 */
const indexCode = indexSource
	.split("\n")
	.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
	.join("\n");

test("a TypeBox tuple serializes to a positional items array, which is the rejected shape", () => {
	// This is the trap itself. If TypeBox ever starts emitting object-form items
	// for tuples, this test fails loudly and the ban in index.ts can be revisited
	// rather than staying as folklore.
	const tuple = Type.Tuple([Type.Number(), Type.Number()]);
	assert.ok(
		Array.isArray(tuple.items),
		"Type.Tuple no longer emits a positional items array; the reason for banning it in index.ts may no longer hold",
	);
	assert.equal(tuple.items.length, 2);
});

test("the bounded-array form serializes items as an object, which providers accept", () => {
	const bounded = Type.Array(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 }));
	assert.equal(Array.isArray(bounded.items), false, "items must be a schema object, not a positional array");
	assert.equal(bounded.items.type, "array");
	assert.equal(bounded.items.minItems, 2);
	assert.equal(bounded.items.maxItems, 2);
	// And the arity contract survives: still exactly two numbers per point.
	assert.equal(bounded.items.items.type, "number");
});

test("index.ts declares no positional tuple anywhere", () => {
	// General, not just `points`: a second tuple added anywhere in the roster
	// re-breaks the whole session, and the failure points at a tool number rather
	// than a name, so it is worth banning outright.
	assert.doesNotMatch(
		indexCode,
		/\bType\.Tuple\s*\(/,
		"index.ts uses Type.Tuple, which serializes to a positional `items` array that strict providers reject with a 400",
	);
});

test("blender_geometry_probe's points parameter uses the bounded-array form", () => {
	const label = 'name: "blender_geometry_probe"';
	const toolStart = indexSource.indexOf(label);
	assert.notEqual(toolStart, -1, "blender_geometry_probe is not registered in index.ts");

	const pointsStart = indexSource.indexOf("points: Type.Optional(", toolStart);
	assert.notEqual(
		pointsStart,
		-1,
		"blender_geometry_probe no longer declares a `points` parameter; this guard has gone vacuous",
	);

	// Up to the next top-level parameter key, so the assertion cannot be satisfied
	// by a bounded array belonging to some later parameter.
	const rest = indexSource.slice(pointsStart);
	const nextKey = rest.slice(1).search(/\n\t{2,4}[a-zA-Z_][a-zA-Z0-9_]*: Type\./);
	const pointsBlock = nextKey === -1 ? rest : rest.slice(0, nextKey + 1);

	assert.match(
		pointsBlock,
		/Type\.Array\(Type\.Array\(Type\.Number\(\), \{ minItems: 2, maxItems: 2 \}\)/,
		"`points` must be a bounded array of two numbers so `items` serializes as an object",
	);
});
