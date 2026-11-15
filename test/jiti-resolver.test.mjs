// Where jiti is, resolved instead of assumed.
//
// This exists because the resolution was wrong in a way no local run could show:
// the calibration CLI did a bare `import("jiti")`, which resolves in a checkout
// whose node_modules is a link into a tree where jiti is reachable by name, and
// fails in CI with `Cannot find package 'jiti'`. The fix was to resolve a path
// and import that, with the same resolver the test harness uses.
//
// The tests below are filesystem-only and build their own node_modules shape, so
// they say the same thing on a laptop, in CI, and in a tree with no jiti at all.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createRequire } from "node:module";
import test, { after } from "node:test";

import { JITI } from "./paths.mjs";
import { jitiCandidates, resolveJiti } from "../scripts/jiti-resolver.mjs";

const scratch = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A node_modules tree where jiti exists only inside a scoped package. */
function nestedJitiTree() {
	const root = mkdtempSync(join(tmpdir(), "pi-blender-jiti-"));
	scratch.push(root);
	const nested = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
	mkdirSync(join(nested, "node_modules", "jiti", "lib"), { recursive: true });
	writeFileSync(join(root, "package.json"), '{"name":"fixture","type":"module"}\n');
	writeFileSync(join(nested, "package.json"), '{"name":"@earendil-works/pi-coding-agent"}\n');
	writeFileSync(join(nested, "node_modules", "jiti", "package.json"), '{"name":"jiti"}\n');
	writeFileSync(join(nested, "node_modules", "jiti", "lib", "jiti.mjs"), "export const createJiti = () => {};\n");
	return { root, nodeModules: join(root, "node_modules"), nested: join(nested, "node_modules", "jiti", "lib", "jiti.mjs") };
}

/** Run fn with PI_JITI_PATH cleared, so the environment cannot answer for the tree. */
function withoutExplicitPath(fn) {
	const saved = process.env.PI_JITI_PATH;
	delete process.env.PI_JITI_PATH;
	try {
		return fn();
	} finally {
		if (saved !== undefined) process.env.PI_JITI_PATH = saved;
	}
}

test("jiti nested inside another package is found when it is not reachable by name", () => {
	const { root, nodeModules, nested } = nestedJitiTree();

	// The premise: Node's own resolution cannot see it. It walks node_modules
	// upward and never descends into another package's private tree, which is why
	// a bare `import("jiti")` is not a fix for this layout.
	const require = createRequire(join(root, "package.json"));
	assert.throws(() => require.resolve("jiti/package.json"), /Cannot find (module|package)/);

	withoutExplicitPath(() => {
		assert.equal(resolveJiti(nodeModules), nested);
	});
	assert.match(resolveJiti(nodeModules), /@earendil-works[\\/]pi-coding-agent[\\/]node_modules[\\/]jiti[\\/]lib[\\/]jiti\.mjs$/);
	assert.ok(existsSync(resolveJiti(nodeModules)));
});

test("a tree with no jiti falls through to the last candidate instead of throwing early", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-blender-jiti-empty-"));
	scratch.push(root);
	mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true });

	// No throw from jitiCandidates: the caller gets the list so its error message
	// can name every place that was looked at.
	const candidates = jitiCandidates(join(root, "node_modules"));
	assert.ok(candidates.includes(join(root, "node_modules", "jiti", "lib", "jiti.mjs")));
	assert.ok(candidates.every((candidate) => !existsSync(candidate) || !candidate.startsWith(root)));
});

test("PI_JITI_PATH wins, and a wrong one is named rather than ignored", () => {
	const { root, nodeModules, nested } = nestedJitiTree();
	const saved = process.env.PI_JITI_PATH;
	try {
		process.env.PI_JITI_PATH = nested;
		assert.equal(resolveJiti(nodeModules), nested);

		process.env.PI_JITI_PATH = join(root, "no-such-jiti.mjs");
		assert.throws(() => resolveJiti(nodeModules), /PI_JITI_PATH is set to .*no-such-jiti\.mjs, which does not exist/);
	} finally {
		if (saved === undefined) delete process.env.PI_JITI_PATH;
		else process.env.PI_JITI_PATH = saved;
	}
});

test("this checkout resolves to a real jiti file", () => {
	// The suite cannot run at all without one, so "it resolved" is the claim, and
	// the path is asserted against the two layouts npm can produce: hoisted at the
	// top of node_modules, or nested under the package that depends on it.
	assert.ok(existsSync(JITI), `${JITI} does not exist`);
	assert.match(JITI, /[\\/]jiti[\\/]lib[\\/]jiti\.mjs$/);
	const hoisted = `${sep}node_modules${sep}jiti${sep}lib${sep}jiti.mjs`;
	if (!JITI.includes(hoisted)) {
		assert.match(
			JITI,
			/@earendil-works[\\/]pi-coding-agent[\\/]node_modules[\\/]jiti[\\/]lib[\\/]jiti\.mjs$/,
			`${JITI} is neither hoisted nor the nested copy, so the walk found something unexpected`,
		);
	}
});

