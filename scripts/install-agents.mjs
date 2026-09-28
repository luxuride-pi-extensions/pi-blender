#!/usr/bin/env node
/**
 * Generate the machine-specific copies of the bundled agent definitions.
 *
 * The files in blender/agents/ are the source of truth and stay portable. Their
 * `extensions:` frontmatter cannot be: pi-subagents resolves only `./` and
 * `../` entries, relative to the agent file itself, with no `~` and no
 * environment-variable expansion (src/agents/agents.js:1802-1813). The extension
 * under test and the todo package both live outside the agents directory, so a
 * relative path cannot reach them either — a placeholder plus this script is the
 * only way to keep a real absolute path out of version control.
 *
 * One file in the source directory is NOT installed: blender-manager.md is a
 * PROMPT read at runtime by getManagerPrompt() in config.ts, because the
 * /blender command session IS the manager. Installing it would leave a spawnable
 * `blender-manager` in ~/.pi/agent/agents whose prompt drifts from the one the
 * user is actually watching. `retired` below deletes an already-installed copy
 * of it, because an add-only installer would leave that stale shadow in place
 * forever.
 *
 * Usage:
 *   npm run install:agents                  # infer both paths
 *   npm run install:agents -- --todo=DIR    # pin the todo package directory
 *   npm run install:agents -- --out=DIR     # write somewhere other than ~/.pi/agent/agents
 *   npm run install:agents -- --check       # verify installed copies are in sync, write nothing
 *   npm run install:agents -- --extension=DIR  # pin the vibe-blender extension directory
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(REPO_ROOT, "blender", "agents");

const EXTENSION_PLACEHOLDER = "/path/to/pi-vibe-blender";
const TODO_PLACEHOLDER = "/path/to/rpiv-todo/index.ts";
const TODO_PACKAGE = "@juicesharp/rpiv-todo";

function parseArgs(argv) {
	const options = { out: join(homedir(), ".pi", "agent", "agents"), check: false };
	for (const arg of argv) {
		if (arg === "--check") {
			options.check = true;
		} else if (arg.startsWith("--out=")) {
			options.out = resolve(arg.slice("--out=".length));
		} else if (arg.startsWith("--extension=")) {
			options.extensionDir = resolve(arg.slice("--extension=".length));
		} else if (arg.startsWith("--todo=")) {
			options.todoDir = resolve(arg.slice("--todo=".length));
		} else {
			throw new Error(`Unrecognised argument: ${arg}`);
		}
	}
	return options;
}

/**
 * Locate the installed vibe-blender extension. It is normally a copy of this repo
 * under ~/.pi/agent/extensions/, but a developer running from a checkout would
 * point that at the checkout instead, so prefer an explicit flag and then an
 * already-installed copy, and fall back to the repo itself.
 */
function resolveExtensionDir(options) {
	if (options.extensionDir) return options.extensionDir;
	const installed = join(homedir(), ".pi", "agent", "extensions", "vibe-blender");
	if (existsSync(join(installed, "package.json"))) return installed;
	return REPO_ROOT;
}

function resolveTodoEntry(options) {
	if (options.todoDir) return join(options.todoDir, "index.ts");
	const candidate = join(homedir(), ".pi", "agent", "npm", "node_modules", TODO_PACKAGE, "index.ts");
	if (existsSync(candidate)) return candidate;
	throw new Error(
		`Could not find ${TODO_PACKAGE}. Install it into the agent npm tree, or pass --todo=DIR pointing at the package directory.`,
	);
}

function substitute(source, replacements) {
	let output = source;
	for (const [placeholder, value] of replacements) {
		output = output.replaceAll(placeholder, value);
	}
	return output;
}

/**
 * Files that used to be installed here and must NOT be any more.
 *
 * The first is a prompt, not a template: /blender no longer spawns a manager,
 * the session that ran the command is the manager. Delete the installed copy so
 * nothing can spawn the stale one.
 */
const retired = ["blender-manager.md"];

const options = parseArgs(process.argv.slice(2));
const extensionDir = resolveExtensionDir(options);
const todoEntry = resolveTodoEntry(options);
const replacements = [
	[EXTENSION_PLACEHOLDER, extensionDir],
	[TODO_PLACEHOLDER, todoEntry],
];

const sources = readdirSync(SOURCE_DIR)
	.filter((name) => name.endsWith(".md") && !retired.includes(name))
	.sort();

if (sources.length === 0) {
	console.error(`No agent definitions found in ${SOURCE_DIR}`);
	process.exit(1);
}

let drifted = 0;
for (const name of sources) {
	const target = join(options.out, name);
	const expected = substitute(readFileSync(join(SOURCE_DIR, name), "utf8"), replacements);

	if (options.check) {
		if (!existsSync(target)) {
			console.error(`MISSING  ${target}`);
			drifted += 1;
			continue;
		}
		const actual = readFileSync(target, "utf8");
		// Comparing digests keeps this to a single line of output per file and
		// avoids dumping a whole agent definition into the terminal.
		const a = createHash("sha256").update(actual).digest("hex");
		const b = createHash("sha256").update(expected).digest("hex");
		if (a !== b) {
			console.error(`DRIFT    ${name}`);
			drifted += 1;
		} else {
			console.log(`in sync  ${name}`);
		}
		continue;
	}

	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, expected);
	console.log(`wrote    ${target}`);
}

for (const file of retired) {
	const destination = join(options.out, file);
	if (!existsSync(destination)) continue;
	if (options.check) {
		console.error(`RETIRED  ${destination}`);
		drifted += 1;
		continue;
	}
	unlinkSync(destination);
	console.log(`retired  ${destination}`);
}

if (options.check) {
	if (drifted > 0) {
		console.error(`\n${drifted} of ${sources.length} agent definition(s) are not in sync. Run: npm run install:agents`);
		process.exit(1);
	}
	console.log(`\nAll ${sources.length} agent definitions are in sync.`);
} else {
	console.log(`\nInstalled ${sources.length} agent definition(s) into ${options.out}`);
	console.log(`  extension: ${extensionDir}`);
	console.log(`  todo:      ${todoEntry}`);
}
