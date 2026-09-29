/**
 * The canonical resolver shim. Copy this file — byte for byte — into each
 * consuming extension as `manager-core.ts`.
 *
 * The reason a shim exists at all: a consumer needs the core's exported
 * functions, and it must get them by a plain ESM `import` of a path it
 * computes at runtime. A static relative import cannot be written, because the
 * core lives in a DIFFERENT extension, installed at a path no source file can
 * name. The core itself ships as plain `.js` so that once the path IS known,
 * loading it needs no transform — that is why this is `createRequire` and not
 * a second jiti.
 *
 * A MISSING CORE IS A HARD ERROR, deliberately. There used to be a fallback
 * copy in every consumer, so an extension installed on its own still ran. That
 * bought a friendly solo install and cost the one thing this repository exists
 * to protect: the fallback was the only code here that could go stale with no
 * test shipping beside it, because a consumer installed alone never runs
 * pi-manager-core's suite. So the fallback ran, worked, and reported nothing
 * while being a fork. A startup error naming every path tried is the better
 * failure. `describeMissingCore()` is written to be read by a human.
 *
 * The `ManagerCore` interface below is the shim's contract, written out rather
 * than imported. It cannot be `typeof import(".../shared/core.js")`, because
 * that path is computed at runtime and does not exist for the compiler. What
 * used to make this type safe was the local fallback doubling as the type
 * source; now `test/core.test.mjs` checks every export the shim declares
 * actually exists in the shared core, and that a core export the shim does NOT
 * declare is a failure too — so an added or removed export cannot pass
 * unnoticed on either side.
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
 * every uninstalled dev checkout fail to find a core that is sitting right
 * next to it.
 */
const SIBLING_DIR_NAMES = ["manager-core", "pi-manager-core"];

const CONSUMER_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

/** pi's tool_call refusal: block, and the reason the model reads. */
export interface ToolCallRefusal {
	block: true;
	reason: string;
}

export interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

export interface ManagerMode {
	markEngaged(): void;
	clearGate(): boolean;
	isEngaged(): boolean;
	isManagerSession(systemPrompt: string | null | undefined): boolean;
	reset(): void;
	checkToolCall(event: ToolCallEvent, systemPrompt: string | null | undefined): ToolCallRefusal | null;
	install(pi: unknown): void;
}

export interface ManagerModeOptions {
	allowedTools?: readonly string[];
	onGateMessage?: (event: ToolCallEvent) => ToolCallRefusal | null;
}

export interface SystemPromptEventLike {
	systemPrompt: string;
	systemPromptOptions?: { sections?: Record<string, string> };
}

export interface ContextInjectionOptions {
	section: string;
	customType: string;
	timeoutMs?: number;
	shouldInject?: () => boolean;
	getPrompt: () => string;
	staticContent?: string | null;
	sectionReachesChildren?: boolean;
	fetchState?: (ctx: unknown) => Promise<unknown>;
	formatState?: (
		state: unknown,
		options: { timeoutMs: number; extraGuidance: () => string[] },
	) => string;
	extraGuidance?: () => string[];
	failureGuidance?: (error: unknown) => string;
	assumeNothingAbout?: string;
}

export type ContextInjectionHandler = (
	event: SystemPromptEventLike,
	ctx: { cwd?: string },
) => Promise<{ message: { customType: string; content: string; display: boolean } } | undefined>;

export interface CommandContextLike {
	ui: { notify(message: string, level?: string): void };
	isIdle(): boolean;
}

export interface EngageCommandOptions {
	name: string;
	description?: string;
	usage?: string;
	engagedMessage?: string;
	onEngage?: () => void;
	fallbackTask?: string;
	getArgumentCompletions?: (argumentPrefix: string) => unknown[] | null | Promise<unknown[] | null>;
}

export interface ExitCommandOptions {
	name: string;
	description?: string;
	notEngagedMessage?: string;
	exitedMessage?: string;
	onExit?: () => boolean;
}

export interface ManagerPromptSide {
	label: string;
	extension: string;
	primary: string;
	extra?: string | null;
	extensionDir?: string;
}

export interface ManagerPromptParts {
	connectorPath: string;
	connectorRole: string;
	sides?: readonly ManagerPromptSide[];
}

/**
 * Everything a consumer may call. Kept in step with the shared core by
 * test/core.test.mjs, in both directions: a name declared here that the core
 * lacks, and a name the core has that is not declared here, both fail.
 */
export interface ManagerCore {
	xdgCacheHome(): string;
	expandUserPath(raw: unknown, cwd?: string): string;
	getPiAgentDir(): string;
	getInstalledExtensionDir(name: string): string;

	stripFrontmatter(source: unknown): string;
	readPromptFile(path: string, role: string): string;
	isDegradedPrompt(text: unknown): boolean;
	composeManagerPrompt(parts: ManagerPromptParts): string;

	CHILD_AGENT_PROMPT_PATTERN: RegExp;
	readActiveAgentName(systemPrompt: string | null | undefined): string | null;

	createManagerMode(options?: ManagerModeOptions): ManagerMode;
	createContextInjection(options: ContextInjectionOptions): ContextInjectionHandler;

	registerEngageCommand(
		pi: { registerCommand: unknown; sendUserMessage: unknown },
		options: EngageCommandOptions,
	): void;
	registerExitCommand(pi: { registerCommand: unknown }, options: ExitCommandOptions): void;
}

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

/** Why the core could not be found, naming every place that was tried. */
export function describeMissingCore(): string {
	return (
		`manager-core could not be found. Looked in: ${candidateDirs().map((c) => c.why).join("; ")}. ` +
		`Set ${ENV_CORE_DIR} to its directory, or install the manager-core extension alongside this one. ` +
		"This is a hard error rather than a fallback: a stale copy of the core that still runs is the " +
		"exact drift pi-manager-core exists to prevent, so it is better to stop here and say so."
	);
}

/** Where the core actually came from, or null when it could not be found. */
export function describeResolvedCoreSource(): string | null {
	for (const { dir } of candidateDirs()) {
		if (existsSync(join(dir, "shared", "core.js"))) return dir;
	}
	return null;
}

/**
 * The shared core, or a thrown error naming every path that was tried.
 *
 * There is no stand-in and no local copy. A Proxy that answers every property
 * with a throwing function used to be the fallback's detection mechanism, which
 * was itself a bug waiting: `typeof` cannot tell that Proxy from a real module,
 * so the check that guarded the fallback could not detect a missing core.
 * Throwing has no such blind spot.
 */
export function loadManagerCore(): ManagerCore {
	for (const { dir } of candidateDirs()) {
		const path = join(dir, "shared", "core.js");
		if (!existsSync(path)) continue;
		return createRequire(import.meta.url)(path) as ManagerCore;
	}
	throw new Error(describeMissingCore());
}
