/**
 * Host paths the test harness needs, resolved instead of hardcoded.
 *
 * pi-blender is TypeScript with NodeNext ".js" specifiers, which
 * `node --experimental-strip-types` cannot resolve, so the tests load the
 * extension's own modules through jiti -- the same loader pi uses.
 *
 * Where jiti is lives in scripts/jiti-resolver.mjs, not here: the calibration
 * CLI needs the same answer, and one implementation is the only way the two stay
 * agreed. That module documents the resolution order and the PI_JITI_PATH
 * override; this one re-exports the result for the suite.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { PI_AGENT_DIR, PI_HOME, PI_INSTALL_DIR, newestPiRelease, resolveJiti } from "../scripts/jiti-resolver.mjs";

export { PI_AGENT_DIR, PI_HOME, PI_INSTALL_DIR, newestPiRelease };

export const JITI = resolveJiti();

/**
 * The GPL-3.0 bridge package: the Python that runs inside Blender.
 *
 * Mirrors the resolution in config.ts, because a test that finds the Python by a
 * path the extension would never use proves nothing about the install. What is
 * deliberately NOT mirrored is the fallback list's last two entries
 * (~/.pi/agent/extensions/...): the suite must not silently test against
 * whatever happens to be installed on the developer's machine when the checkout
 * under test is missing its sibling.
 *
 * `PI_BLENDER_BRIDGE_ASSETS_DIR` wins, so the launch harness can stage a
 * deliberately broken package.
 */
function resolveBridgePackageDir() {
	const explicit = process.env.PI_BLENDER_BRIDGE_ASSETS_DIR?.trim();
	const candidates = [
		explicit,
		// The development layout: the two checkouts side by side, which is what
		// ~/.pi/agent/git/github.com/<org>/ holds for every extension here.
		join(import.meta.dirname, "..", "..", "pi-blender-bridge"),
		join(import.meta.dirname, "..", "..", "blender-bridge"),
	];
	try {
		const require = createRequire(join(import.meta.dirname, "..", "package.json"));
		candidates.push(dirname(require.resolve("@luxuride-pi/blender-bridge/package.json")));
	} catch {
		// Not installed as a dependency; the sibling checkout above is the case
		// this repo is developed in.
	}
	const found = candidates.filter(Boolean).find((dir) => existsSync(join(dir, "blender", "live-bridge.py")));
	if (!found) {
		throw new Error(
			`Could not find the bridge package (${candidates.filter(Boolean).join(", ")}). Clone ` +
				`https://github.com/luxuride-pi-extensions/pi-blender-bridge next to this checkout, or set ` +
				`PI_BLENDER_BRIDGE_ASSETS_DIR to its root. The suite cannot run the Python probes without it.`,
		);
	}
	return found;
}

export const BRIDGE_DIR = resolveBridgePackageDir();

/** `blender/` inside the bridge package: the scripts Blender executes. */
export const BRIDGE_ASSETS_DIR = join(BRIDGE_DIR, "blender");

/** `test/` inside the bridge package: the `--background` probes. */
export const BRIDGE_PROBES_DIR = join(BRIDGE_DIR, "test");

/**
 * Load a TypeScript module from this repo, with fresh evaluation.
 *
 * `isolated: true` is required, not a nicety: several modules here publish
 * process.env and cache the result in module scope (config.ts mints an
 * instance id at load time), so a cached instance would carry the first
 * test's environment into every later one. Each test that cares passes its own
 * env and gets its own copy of the module.
 */
export async function loadTs(relativePath, env) {
	const { createJiti } = await import(JITI);
	const jiti = createJiti(import.meta.url, { isolated: true, interopDefault: true });
	if (env) {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
	return jiti.import(relativePath);
}
