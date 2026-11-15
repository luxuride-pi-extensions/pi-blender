/**
 * Where jiti is, resolved instead of assumed.
 *
 * pi-blender is TypeScript with NodeNext ".js" specifiers, which
 * `node --experimental-strip-types` cannot resolve, so both the test harness
 * (`test/paths.mjs`) and the calibration CLI (`scripts/critic-calibration.mjs`)
 * load the extension's own modules through jiti -- the same loader pi uses.
 * One implementation, because two copies of this resolution drifted into one
 * that worked in a developer's checkout and failed in CI.
 *
 * A bare `await import("jiti")` is not good enough, for two reasons:
 *
 *   - jiti is not a declared dependency of this package. A plain `npm install`
 *     puts it under node_modules/@earendil-works/pi-coding-agent/node_modules/
 *     (that package ships its own shrinkwrap and pins its own copy), so a bare
 *     specifier resolves only where node_modules happens to be a tree that has
 *     it reachable, and CI answers
 *     `Cannot find package 'jiti' imported from ...`.
 *   - `createRequire(...).resolve("jiti/package.json")` does not find it either:
 *     Node's resolution walks node_modules DIRECTORIES UPWARD from the requiring
 *     file and never descends into another package's nested node_modules.
 *
 * So: resolve a PATH, then `import(path)`. The newest pi release is picked by
 * directory name rather than a pinned version, so upgrading pi does not silently
 * break the suite. If nothing has jiti, the error names every candidate instead
 * of failing as an unresolved module.
 *
 * Overridable, because the "obvious" location is not always the real one:
 *   PI_HOME          defaults to ~/.pi
 *   PI_AGENT_DIR     defaults to $PI_HOME/agent
 *   PI_INSTALL_DIR   defaults to $PI_AGENT_DIR/install
 *   PI_JITI_PATH     point straight at jiti's jiti.mjs
 *
 * Filesystem only: nothing here imports jiti, so this module is testable in a
 * checkout that does not have one.
 */

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const PI_HOME = process.env.PI_HOME ?? join(homedir(), ".pi");
export const PI_AGENT_DIR = process.env.PI_AGENT_DIR ?? join(PI_HOME, "agent");
export const PI_INSTALL_DIR = process.env.PI_INSTALL_DIR ?? join(PI_AGENT_DIR, "install");

/** This repository's node_modules, i.e. the tree the defaults are relative to. */
export const NODE_MODULES = join(import.meta.dirname, "..", "node_modules");

/** Newest pi release directory by name (versions sort correctly as strings). */
export function newestPiRelease() {
	const releases = join(PI_INSTALL_DIR, "releases");
	if (!existsSync(releases)) {
		throw new Error(
			`No pi install directory at ${releases}. Set PI_INSTALL_DIR, or PI_HOME if your pi ` +
				`directory is not at ~/.pi.`,
		);
	}
	const names = readdirSync(releases).filter((name) => existsSync(join(releases, name, "node_modules")));
	if (names.length === 0) {
		throw new Error(`No pi release under ${releases} contains a node_modules directory.`);
	}
	names.sort();
	const newest = names[names.length - 1];
	return join(releases, newest);
}

/**
 * jiti inside a pi install, or undefined when there is no install to look at.
 *
 * A CI runner has no ~/.pi/agent/install/releases, and newestPiRelease throws
 * when it cannot find one. The resolver needs the answer as a candidate, not as
 * a precondition, so it asks this instead and falls through to the repo copy.
 */
function jitiFromPiInstall() {
	try {
		return join(newestPiRelease(), "node_modules", "jiti", "lib", "jiti.mjs");
	} catch {
		return undefined;
	}
}

/**
 * jiti found inside a node_modules tree, by name first and then by walking it.
 *
 * The by-name attempt goes through the package's own exports map, not string
 * concatenation: "jiti/lib/jiti.mjs" is not an exported subpath, so resolving
 * THAT fails with ERR_PACKAGE_PATH_NOT_EXPORTED even when jiti sits right there.
 * "./package.json" IS exported, which makes it the one reliable way in when the
 * package is reachable by name at all.
 *
 * When it is not reachable by name (the normal case: it is nested inside another
 * package), the walk below finds it. It is bounded (a few hundred entries) and
 * only runs after the by-name attempt has failed. Returns undefined rather than
 * throwing, so a tree without jiti falls through to the next candidate and is
 * reported by name.
 *
 * @param {string} nodeModules absolute path to a node_modules directory
 */
export function jitiInTree(nodeModules) {
	const byName = (() => {
		try {
			const require = createRequire(join(nodeModules, "..", "package.json"));
			return join(dirname(require.resolve("jiti/package.json")), "lib", "jiti.mjs");
		} catch {
			return undefined;
		}
	})();
	if (byName) return byName;

	if (!existsSync(nodeModules)) return undefined;
	for (const entry of readdirSync(nodeModules)) {
		// Scoped packages nest one level deeper: node_modules/@scope/pkg.
		const scopes = entry.startsWith("@")
			? readdirSync(join(nodeModules, entry)).map((name) => join(entry, name))
			: [entry];
		for (const name of scopes) {
			const found = join(nodeModules, name, "node_modules", "jiti", "lib", "jiti.mjs");
			if (existsSync(found)) return found;
		}
	}
	return undefined;
}

/**
 * Every place jiti could be, most authoritative first.
 *
 * @param {string} nodeModules the tree to search; tests point this at a fixture
 */
export function jitiCandidates(nodeModules = NODE_MODULES) {
	return [
		// The tree under test comes first. Both callers run inside this checkout,
		// and the loader that ships with its own dependencies is the one that will
		// be present in CI; an unrelated installed pi is a fallback, not a default.
		jitiInTree(nodeModules),
		// A hoisted install, which a bare `import("jiti")` would have found but
		// which is not the layout npm produces for this package.
		join(nodeModules, "jiti", "lib", "jiti.mjs"),
		// Guarded, not called eagerly: an installed-pi path that throws would take
		// the repo-local candidates down with it, and one of those is the answer a
		// CI checkout depends on.
		jitiFromPiInstall(),
	].filter(Boolean);
}

/**
 * Resolve jiti's jiti.mjs to an absolute path, throwing if it is nowhere.
 *
 * @param {string} nodeModules the tree to search; tests point this at a fixture
 */
export function resolveJiti(nodeModules = NODE_MODULES) {
	const explicit = process.env.PI_JITI_PATH;
	if (explicit) {
		if (!existsSync(explicit)) throw new Error(`PI_JITI_PATH is set to ${explicit}, which does not exist.`);
		return explicit;
	}
	const candidates = jitiCandidates(nodeModules);
	const found = candidates.find((path) => existsSync(path));
	if (!found) {
		throw new Error(
			`Could not find jiti. Looked in:\n  ${candidates.join("\n  ")}\nSet PI_JITI_PATH to point at it ` +
				`explicitly. Without jiti nothing here can load this project's TypeScript.`,
		);
	}
	return found;
}
