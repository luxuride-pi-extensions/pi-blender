#!/usr/bin/env node
/**
 * One-command setup for a fresh clone of pi-blender.
 *
 * A clone is deliberately not self-sufficient. Three things must be true before
 * the extension works, and all three point outside the repository:
 *
 *   1. pi must find the extension. It loads from ~/.pi/agent/extensions, so the
 *      clone needs a symlink there — the repo itself is never modified.
 *   2. jiti must resolve `typebox`, which pi bundles but does not install into
 *      third-party extensions. node_modules/typebox is a symlink into the pi
 *      release, so it is gitignored and has to be recreated per machine.
 *   3. The agent definitions carry /path/to placeholders that only
 *      install-agents.mjs can resolve, and blender-manager additionally needs
 *      the todo extension listed as a provider (a foreground child does not
 *      inherit ambient extensions).
 *
 * Blender itself is NOT launched or required here. Resolution follows launch.ts
 * (BLENDER_PATH, macOS app, flatpak autodetect, PATH) and is only reported, so
 * a machine that configures Blender later is not blocked at setup time.
 *
 * Usage:
 *   node scripts/dev-setup.mjs              # check everything, fix what is safe
 *   node scripts/dev-setup.mjs --check      # report only, change nothing
 *   node scripts/dev-setup.mjs --quiet      # only report problems
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_DIR = join(homedir(), ".pi", "agent");
const EXTENSIONS_DIR = join(AGENT_DIR, "extensions");
const INSTALLED_AGENTS_DIR = join(AGENT_DIR, "agents");
const LINK_PATH = join(EXTENSIONS_DIR, "pi-blender");
const TODO_PACKAGE = "@juicesharp/rpiv-todo";
const INSTALL_DIR_RE = /^(\d+)\.(\d+)\.(\d+)/;

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has("--check");
const QUIET = args.has("--quiet");

let problems = 0;
let fixed = 0;

/** Report a step. `detail` is the one line worth reading; `ok` gates the exit code. */
function report(label, ok, detail, { repaired = false } = {}) {
	if (!ok) problems += 1;
	if (repaired) fixed += 1;
	if (QUIET && ok && !repaired) return;
	const mark = ok ? (repaired ? "fixed " : "ok    ") : "FAIL  ";
	console.log(`${mark} ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * Pick the newest pi release directory by semver, not by mtime. pi keeps every
 * installed release side by side (0.87.1, 0.88.0, …) and a lexicographic sort
 * puts 0.9.0 after 0.87.1, which would point typebox at an old release.
 */
function findPiReleaseDir() {
	const releasesRoot = join(AGENT_DIR, "install", "releases");
	if (!existsSync(releasesRoot)) return undefined;
	const versions = readdirSync(releasesRoot)
		.map((name) => ({ name, match: INSTALL_DIR_RE.exec(name) }))
		.filter((entry) => entry.match)
		.map((entry) => ({
			name: entry.name,
			parts: entry.match.slice(1, 4).map((part) => Number.parseInt(part, 10)),
		}))
		.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2]);
	return versions[0]?.name;
}

function ensureExtensionLink() {
	if (!existsSync(EXTENSIONS_DIR)) {
		if (CHECK_ONLY) {
			report("extension symlink", false, `${EXTENSIONS_DIR} does not exist; run without --check to create it`);
			return;
		}
		mkdirSync(EXTENSIONS_DIR, { recursive: true });
	}

	if (existsSync(LINK_PATH) || isSymlink(LINK_PATH)) {
		const current = isSymlink(LINK_PATH) ? readlinkSync(LINK_PATH) : undefined;
		// Compare RESOLVED paths, not the strings. $HOME and the repo path can be
		// the same directory under two names (e.g. /home/lux and /var/home/lux),
		// in which case a string compare reports a correct link as wrong and then
		// needlessly deletes and recreates it.
		if (current !== undefined && samePath(current, REPO_ROOT)) {
			report("extension symlink", true, `${LINK_PATH} -> ${current}`);
			return;
		}
		if (!CHECK_ONLY) {
			// A real directory here is someone's installed copy, not something
			// this script should delete to make room for a symlink. Say so and
			// let the human decide.
			if (current === undefined) {
				report(
					"extension symlink",
					false,
					`${LINK_PATH} is a real directory, not a symlink. Move it aside, then re-run; this script will not delete it.`,
				);
				return;
			}
			rmSync(LINK_PATH, { force: true });
		}
	}

	if (CHECK_ONLY) {
		report("extension symlink", false, `not linked to ${REPO_ROOT}; run without --check`);
		return;
	}
	symlinkSync(REPO_ROOT, LINK_PATH);
	report("extension symlink", true, `${LINK_PATH} -> ${REPO_ROOT}`, { repaired: true });
}

function isSymlink(path) {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** Whether two paths name the same location, however each is spelled. */
function samePath(a, b) {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return resolve(a) === resolve(b);
	}
}

/**
 * jiti resolves imports by walking up from the extension directory, so a
 * resolvable node_modules anywhere above REPO_ROOT works. The repo's own
 * node_modules is the right place: it is already gitignored, so a symlink there
 * never lands in a commit.
 */
function ensureTypebox() {
	const link = join(REPO_ROOT, "node_modules", "typebox");
	if (existsSync(link)) {
		let where = "in place";
		if (isSymlink(link)) {
			const target = readlinkSync(link);
			const release = INSTALL_DIR_RE.exec(target)?.[0];
			where = release ? `pi ${release}` : target;
		}
		report("typebox resolvable", true, `node_modules/typebox (${where})`);
		return;
	}

	const release = findPiReleaseDir();
	if (!release) {
		report(
			"typebox resolvable",
			false,
			`node_modules/typebox is missing and no pi release was found under ${join(AGENT_DIR, "install", "releases")}`,
		);
		return;
	}
	const target = join(AGENT_DIR, "install", "releases", release, "node_modules", "typebox");
	if (!existsSync(target)) {
		report("typebox resolvable", false, `pi release ${release} has no bundled typebox at ${target}`);
		return;
	}
	if (CHECK_ONLY) {
		report("typebox resolvable", false, `node_modules/typebox missing; would link to pi ${release}`);
		return;
	}
	mkdirSync(join(REPO_ROOT, "node_modules"), { recursive: true });
	symlinkSync(target, link);
	report("typebox resolvable", true, `node_modules/typebox -> pi ${release}`, { repaired: true });
}

function runInstallAgents() {
	// In --check mode the installer MUST run with its own --check. Installing
	// first and verifying second looks equivalent but is not: the install would
	// repair the very drift this step exists to detect, and the run would report
	// success on a machine that was in fact out of date. A check has to be able
	// to fail, so nothing may be written before the comparison.
	const installArgs = [join(REPO_ROOT, "scripts", "install-agents.mjs")];
	if (!CHECK_ONLY) {
		const result = spawnSync(process.execPath, installArgs, { encoding: "utf-8" });
		if (result.status !== 0) {
			const message = (result.stderr || result.stdout || "").trim().split("\n").slice(0, 3).join(" | ");
			report("agent definitions", false, `install-agents.mjs failed: ${message || `exit ${result.status}`}`);
			return;
		}
	}
	// --check then proves the installed copies match the repo, which is the
	// property that matters on both paths.
	const check = spawnSync(process.execPath, [...installArgs, "--check"], {
		encoding: "utf-8",
	});
	// Count the per-file lines only. A bare /in sync/ also matches the summary
	// line ("All N agent definitions are in sync."), which inflates the count by
	// one and reports 7 files when there are 6.
	const count = (check.stdout.match(/^in sync\s+\S+$/gm) ?? []).length;
	if (check.status === 0) {
		report("agent definitions", true, `${count} in sync in ${INSTALLED_AGENTS_DIR}`);
	} else {
		report("agent definitions", false, `${check.stderr.trim().split("\n")[0] ?? "installed copies are out of sync"}`);
	}
}

function checkTodoProvider() {
	const entry = join(AGENT_DIR, "npm", "node_modules", TODO_PACKAGE, "index.ts");
	if (existsSync(entry)) {
		// Named for the manager PROMPT, not for an installed template:
		// blender-manager.md is no longer installed (the /blender command session
		// is the manager), but the prompt it injects still names `todo`, so the
		// provider this checks is exactly the one that prompt will be missing.
		report("todo provider for the manager prompt", true, TODO_PACKAGE);
		return;
	}
	report(
		"todo provider for blender-manager",
		false,
		`${TODO_PACKAGE} not found. blender-manager lists a \`todo\` tool, and a foreground child does not inherit ambient extensions, so without this package the child launches holding a tool it can never call. Install it into ${join(AGENT_DIR, "npm")}.`,
	);
}

/**
 * Mirror launch.ts's resolution order so setup reports what the extension will
 * actually launch. The macOS default and flatpak autodetect are checked the same
 * way launch.ts checks them.
 */
function checkBlender() {
	const configured = process.env.BLENDER_PATH?.trim();
	if (configured) {
		const command = configured.split(/\s+/).find(Boolean);
		const ok = spawnSync(command, ["--version"], { encoding: "utf-8", timeout: 15_000 }).status === 0;
		report("Blender resolvable", ok, `BLENDER_PATH=${configured}${ok ? "" : " (did not run --version)"}`);
		return;
	}

	const macosPath = "/Applications/Blender.app/Contents/MacOS/Blender";
	if (existsSync(macosPath)) {
		report("Blender resolvable", true, macosPath);
		return;
	}

	const flatpak = spawnSync("flatpak", ["info", "--show-ref", "org.blender.Blender"], {
		encoding: "utf-8",
		timeout: 10_000,
	});
	if (flatpak.status === 0) {
		report("Blender resolvable", true, "flatpak org.blender.Blender (autodetected)");
		return;
	}

	const onPath = spawnSync("blender", ["--version"], { encoding: "utf-8", timeout: 15_000 });
	if (onPath.status === 0) {
		report("Blender resolvable", true, "blender on PATH");
		return;
	}

	report(
		"Blender resolvable",
		false,
		"no Blender found. Set BLENDER_PATH, install org.blender.Blender via flatpak, or put blender on PATH. This is not fatal for setup — the extension only needs Blender when a task starts.",
	);
}

console.log(CHECK_ONLY ? "pi-blender setup check (read-only)" : "pi-blender setup");
console.log(`repo: ${REPO_ROOT}\n`);

ensureExtensionLink();
ensureTypebox();
runInstallAgents();
checkTodoProvider();
checkBlender();

console.log("");
if (problems > 0) {
	console.log(`${problems} problem(s) found.`);
	if (CHECK_ONLY) console.log("Re-run without --check to fix what can be fixed automatically.");
	process.exit(1);
}
console.log(fixed > 0 ? `Setup complete (${fixed} repaired).` : "Setup complete. Nothing to do.");
