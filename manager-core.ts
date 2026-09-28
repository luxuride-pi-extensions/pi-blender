/**
 * The canonical resolver shim. Copy this file — byte for byte — into each
 * consuming extension as `manager-core.ts`, next to its own copy of
 * `manager-core.local.ts`.
 *
 * The reason a shim exists at all: a consumer needs the core's exported
 * functions, and it must get them by a plain ESM `import` of a path it
 * computes at runtime. A static relative import cannot be written, because the
 * core lives in a DIFFERENT extension, installed at a path no source file can
 * name. The core itself ships as plain `.js` so that once the path IS known,
 * loading it needs no transform — that is why this is `createRequire` and not
 * a second jiti.
 *
 * Everything below is typed against `./manager-core.local.js`, the fallback in
 * the same directory. That is deliberate: the shim's contract is "give me
 * something shaped like the local core", so the local core IS the type, and a
 * shared core that grew an export the local copy lacks fails to typecheck here
 * rather than at a call site in some consumer weeks later.
 *
 * DO NOT EDIT THE COPY. `test/resolver-copies.mjs` in pi-manager-core diffs
 * every copy against this file and fails when they differ; `--fix` rewrites
 * them. The whole point of this shim is that the resolution ORDER is identical
 * in all three consumers, and a hand-edited copy is exactly the drift it
 * prevents.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Override for a non-default install location. Mirrors the install script. */
const ENV_CORE_DIR = "PI_MANAGER_CORE_DIR";
/** The directory name pi installs the core extension under. */
const CORE_EXTENSION_NAME = "manager-core";
/**
 * Sibling checkout directory names, in the order they are tried.
 *
 * Both, because the two names are both real and which one a developer used is
 * not something the consumer can know: pi installs by the first, and the
 * working title of the repo is the second. Probing only the first would make
 * every uninstalled dev checkout silently run on the local fallback — which
 * works, and so reports nothing, and so is indistinguishable from a correct
 * shared-core install. A silent fallback is the one outcome this file exists to
 * prevent, so both names are probed and the message names the one that worked.
 */
const SIBLING_DIR_NAMES = ["manager-core", "pi-manager-core"];

const CONSUMER_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/** The shape every consumer expects, and the shape the local copy provides. */
export type ManagerCore = typeof import("./manager-core.local.js");

/**
 * Where this consumer's own directory sits inside pi's extensions dir, and the
 * per-user override. Duplicated from the install scripts on purpose: importing
 * them would mean depending on a script that is not a module, and a consumer
 * that resolves the core differently from its own installer is a consumer whose
 * templates get stamped against the wrong tree.
 */
function getPiAgentDir(): string {
	const override = process.env.PI_AGENT_DIR?.trim();
	if (override) {
		if (override === "~") return homedir();
		if (override.startsWith("~/")) return homedir() + override.slice(1);
		return resolve(process.cwd(), override);
	}
	return join(homedir(), ".pi", "agent");
}

function candidateDirs(): { dir: string; why: string }[] {
	const installed = join(getPiAgentDir(), "extensions", CORE_EXTENSION_NAME);
	return [
		// A dev checkout may point the core at another checkout.
		...(process.env[ENV_CORE_DIR]?.trim()
			? [{ dir: resolve(process.cwd(), process.env[ENV_CORE_DIR]!.trim()), why: `${ENV_CORE_DIR}` }]
			: []),
		// The normal production case, and a symlinked dev install of both repos.
		{ dir: installed, why: `pi's installed extensions dir (${installed})` },
		// Two checkouts side by side in a parent dir, neither installed.
		...SIBLING_DIR_NAMES.map((name) => ({
			dir: join(CONSUMER_DIR, "..", name),
			why: `a sibling checkout of ${name}`,
		})),
	];
}

/** The property the stand-in module uses to identify itself. */
const UNAVAILABLE_MARKER = "__managerCoreUnavailable";

/** Why the core could not be found, naming every place that was tried. */
export function describeMissingCore(): string {
	return (
		`manager-core could not be found. Looked in: ${candidateDirs().map((c) => c.why).join("; ")}. ` +
		`Set ${ENV_CORE_DIR} to its directory, or install the manager-core extension alongside this one. ` +
		"This extension keeps a working built-in copy of the shared behaviour, so it still runs — but the " +
		"shared core has forked, which is the drift pi-manager-core exists to prevent."
	);
}

/**
 * The shared core, or a module whose every export explains the same failure.
 *
 * On failure the stand-in is a Proxy rather than a thrown error, so a consumer
 * that forgot to check still fails loudly and legibly at the call site instead
 * of crashing on a destructured `undefined` — and `loadManagerCoreOrLocal`
 * below can detect the stand-in by calling through it.
 */
export function loadManagerCore(): ManagerCore {
	for (const { dir } of candidateDirs()) {
		const path = join(dir, "shared", "core.js");
		if (!existsSync(path)) continue;
		return createRequire(import.meta.url)(path) as ManagerCore;
	}
	return unavailable();
}

/**
 * A stand-in module: every property access returns a function that throws with
 * the one explanation.
 */
function unavailable(): ManagerCore {
	const message = describeMissingCore();
	return new Proxy({} as ManagerCore, {
		get(_target, prop) {
			// The marker is read by loadManagerCoreOrLocal, and by nothing else.
			// A boolean cannot be confused for an export a real core would have.
			if (prop === UNAVAILABLE_MARKER) return true;
			// `then` is checked by every await, and a symbol key is not a call.
			if (prop === "then" || typeof prop === "symbol") return undefined;
			return () => {
				throw new Error(message);
			};
		},
	});
}

/**
 * The shared core if it resolved, else this extension's local copy.
 *
 * The fallback is why each consumer ships `manager-core.local.ts`: a user who
 * installs one Blender extension should get a working Blender extension, and a
 * manager extension whose features collapse because an optional sibling is
 * absent would be a worse product than the duplication it replaces. The
 * fallback is only ever the mechanism — paths, gate, command registration,
 * prompt composition — and never an application's policy.
 *
 * Detection is the marker the stand-in exposes, not a type check on an export.
 * A Proxy makes `typeof` useless: every property reads as a function, so a
 * probe of the form `typeof core.x !== "function"` passes against a core that
 * is not there at all — which is exactly the bug this replaced.
 */
export function loadManagerCoreOrLocal(local: ManagerCore): ManagerCore {
	try {
		const core = loadManagerCore();
		if ((core as Record<string, unknown>)[UNAVAILABLE_MARKER] === true) return local;
		return core;
	} catch {
		return local;
	}
}
