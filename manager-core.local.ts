/**
 * The fallback copy of the shared core, for a consumer running WITHOUT
 * manager-core installed.
 *
 * This exists because a user who installs one extension should get a working
 * extension. pi-manager-core is a third package to install, and a manager
 * extension whose whole feature set collapses because an optional sibling is
 * absent would be a worse product than the duplication it replaces.
 *
 * It is a COPY, and that is the point at which the anti-drift claim has to be
 * honest. `test/resolver-copies.mjs` diffs this file against every consumer's
 * copy and fails on any difference, so a fix to the mechanism still has to be
 * made in four places — which is better than six and worse than one. What is
 * NOT duplicated here is any application's policy: no allowed-tool list, no
 * refusal message, no agent names, no bridge anything. This is the mechanism
 * only, and the policy that rides on it stays in the application.
 *
 * The functions below therefore differ from `shared/core.js` in exactly one
 * way: they are the same logic in TypeScript rather than a re-export, and they
 * must stay behaviourally identical to it.
 *
 * WHY SO MUCH IS DUPLICATED HERE
 *
 * Every consumer of the core needs four things from it, and the core is an
 * OPTIONAL install:
 *
 *   1. Read a prompt file, degrading loudly when it is missing.
 *   2. Tell a child subagent apart from a manager session.
 *   3. Hold the manager gate, which is state and therefore cannot be a
 *      stateless helper.
 *   4. Register an engage and an exit command with identical argument
 *      handling.
 *
 * Anything a consumer calls during module evaluation must be available
 * synchronously, before the core has resolved. That rules out a lazy
 * `await import()`, and it is why this is a real copy rather than a thin
 * forwarding shim to something that may not be there.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/* ------------------------------------------------------------------ paths -- */

export function xdgCacheHome(): string {
	return process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
}

export function expandUserPath(raw: unknown, cwd: string = process.cwd()): string {
	const value = String(raw ?? "").trim();
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return homedir() + value.slice(1);
	return isAbsolute(value) ? value : resolve(cwd, value);
}

export function getPiAgentDir(): string {
	const override = process.env.PI_AGENT_DIR?.trim();
	if (override) return expandUserPath(override);
	return join(homedir(), ".pi", "agent");
}

export function getInstalledExtensionDir(name: string): string {
	return join(getPiAgentDir(), "extensions", name);
}

/* ---------------------------------------------------------------- prompts -- */

export function stripFrontmatter(source: unknown): string {
	return String(source ?? "").replace(/^---[\s\S]*?\n---\n/, "").trim();
}

export function readPromptFile(path: string, role: string): string {
	try {
		const body = stripFrontmatter(readFileSync(path, "utf8"));
		if (!body) throw new Error("the file is empty after its frontmatter was stripped");
		return body;
	} catch (error) {
		return (
			`The ${role} prompt could not be read from ${path}, so this session is missing that half of ` +
			`its instructions (${error instanceof Error ? error.message : String(error)}). ` +
			"Say so plainly when the task touches that side; do not fall back to guessing at its " +
			"loops, its agents, or its acceptance rules."
		);
	}
}

export function isDegradedPrompt(text: unknown): boolean {
	return typeof text === "string" && text.includes("could not be read from");
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

export function composeManagerPrompt(parts: ManagerPromptParts): string {
	const sections: string[] = [readPromptFile(parts.connectorPath, parts.connectorRole)];
	for (const side of parts.sides ?? []) {
		const dir = side.extensionDir ?? getInstalledExtensionDir(side.extension);
		const body = [readPromptFile(join(dir, side.primary), `${side.label} manager`)];
		if (side.extra) body.push(readPromptFile(join(dir, side.extra), `${side.label} exchange contract`));
		sections.push(
			[
				`# ---- ${side.label} manager prompt (from the ${side.extension} extension) ----`,
				"",
				"Everything below this line is the procedure that side's own manager uses, read from the",
				`installed ${side.extension} extension at runtime so it cannot drift from it. Read it as that`,
				"SIDE's procedure, not as a second manager: this session is the manager of every side,",
				"and the connector prompt above — which is the only part written knowing about the",
				"other applications — wins wherever the two disagree. The side prompt names agents you",
				"may spawn, tools you may call, and the acceptance rules for work on that side; all of",
				"those apply here unchanged.",
				"",
				body.join("\n\n"),
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

/* ---------------------------------------------------------- manager mode -- */

export const CHILD_AGENT_PROMPT_PATTERN = /<active_agent\s+name="([^"]*)"/;

export function readActiveAgentName(systemPrompt: string | null | undefined): string | null {
	const match = CHILD_AGENT_PROMPT_PATTERN.exec(systemPrompt ?? "");
	// `?? null` rather than truthiness: noUncheckedIndexedAccess makes the group
	// string | undefined, and a named group always matched when the pattern
	// matched, so an empty capture stays "" and only a missing group is null.
	return match?.[1] ?? null;
}

export interface ToolCallRefusal {
	block: true;
	reason: string;
}

export interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

export interface ManagerModeOptions {
	allowedTools?: readonly string[];
	onGateMessage?: (event: ToolCallEvent) => ToolCallRefusal | null;
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

export function createManagerMode(options: ManagerModeOptions = {}): ManagerMode {
	const allowed = new Set(options.allowedTools ?? []);
	let engaged = false;
	let gated = false;

	function markEngaged(): void {
		engaged = true;
		gated = true;
	}

	function clearGate(): boolean {
		if (!gated) return false;
		gated = false;
		return true;
	}

	function isEngaged(): boolean {
		return engaged;
	}

	function isManagerSession(systemPrompt: string | null | undefined): boolean {
		return gated && readActiveAgentName(systemPrompt) === null;
	}

	function reset(): void {
		engaged = false;
		gated = false;
	}

	function checkToolCall(
		event: ToolCallEvent,
		systemPrompt: string | null | undefined,
	): ToolCallRefusal | null {
		if (!isManagerSession(systemPrompt)) return null;
		// Refusals are consulted BEFORE the allowlist: the allowlist is coarse (a
		// manager may `read` files) while a refusal is specific (a manager may not
		// `read` an image, though `read` is allowed). Checking the allowlist first
		// lets it short-circuit the refusals, which is a silent loss of policy —
		// nothing reports the refusal unreachable, it just stops firing.
		const extra = options.onGateMessage?.(event) ?? null;
		if (extra) return extra;
		if (allowed.has(event.toolName)) return null;
		return {
			block: true,
			reason:
				`Manager role: \`${event.toolName}\` is not available to this session. The manager plans, ` +
				"briefs and integrates; the subagents it spawns author and judge. Delegate with the subagent " +
				"tool, and say so in your report if no agent covers a capability you need.",
		};
	}

	/**
	 * Install the gate on a pi instance.
	 *
	 * Typed as `unknown` and cast, because pi's ExtensionAPI declares `on` as a
	 * set of OVERLOADS keyed by event name. A structural parameter type can
	 * never match it: the compiler compares the overload set against one
	 * signature and every one of them fails. Re-declaring pi's event surface
	 * here would be the alternative, and it would go stale the first time pi
	 * adds an event. The cast is confined to this one line, and the handler it
	 * installs is type-checked.
	 */
	function install(pi: unknown): void {
		const host = pi as {
			on(event: string, handler: (event: ToolCallEvent, ctx: { getSystemPrompt(): string }) => unknown): void;
		};
		host.on("tool_call", (event, ctx) => checkToolCall(event, ctx.getSystemPrompt()));
	}

	return { markEngaged, clearGate, isEngaged, isManagerSession, reset, checkToolCall, install };
}

/* ------------------------------------------------------ context injection -- */

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
	/** Fixed text injected verbatim as the per-turn message, with no fetch. */
	staticContent?: string | null;
	/**
	 * Whether a CHILD session also receives the system-prompt section.
	 *
	 * Default true: the constant prompt is what tells a subagent which side of
	 * the bridge it is on. The two-application manager sets this false, because
	 * its workers already state their own side and its prompt is the connector's
	 * instructions rather than a side's procedure.
	 */
	sectionReachesChildren?: boolean;
	/** Fetch the live state. Required unless `staticContent` is set. */
	fetchState?: (ctx: unknown) => Promise<unknown>;
	/** Render the live state. Required unless `staticContent` is set. */
	formatState?: (state: unknown, options: { timeoutMs: number; extraGuidance: () => string[] }) => string;
	extraGuidance?: () => string[];
	/** The recovery sentence for a failed fetch; each side names its own tool. */
	failureGuidance?: (error: unknown) => string;
	/** What the failed-turn notice forbids assuming. Unity names its open scene. */
	assumeNothingAbout?: string;
}

export interface InjectedMessage {
	message: { customType: string; content: string; display: boolean };
}

export type ContextInjectionHandler = (
	event: SystemPromptEventLike,
	ctx: { cwd?: string },
) => Promise<InjectedMessage | undefined>;

/**
 * The before_agent_start handler that injects the constant manager prompt and
 * the per-turn live snapshot. The three rules it enforces, and why each is
 * load-bearing, are in `shared/core.js`; the local copy must behave identically,
 * which `test/core.test.mjs` checks.
 */
export function createContextInjection(options: ContextInjectionOptions): ContextInjectionHandler {
	const timeoutMs = options.timeoutMs ?? 30_000;
	// Static content is injected verbatim, so passing a fetch as well would pay
	// for a round trip and discard it. Throwing beats honouring one quietly.
	if (options.staticContent != null && options.fetchState) {
		throw new Error(
			`createContextInjection("${options.section}"): pass staticContent or fetchState, not both. ` +
				"Static content is injected verbatim, so a fetch would be paid for and discarded.",
		);
	}
	return async function injectContext(event, ctx) {
		if (options.shouldInject && !options.shouldInject()) return undefined;

		// The constant prompt first, unconditionally, including for children —
		// it is what teaches a subagent which side of the bridge it is on. The
		// two-application manager opts out: its workers already know their side,
		// and its prompt is the connector's instructions rather than a side's
		// procedure, so the argument does not apply there.
		if ((options.sectionReachesChildren ?? true) || readActiveAgentName(event.systemPrompt) === null) {
			if (event.systemPromptOptions?.sections) event.systemPromptOptions.sections[options.section] = options.getPrompt();
		}

		// Static path: no snapshot rule, no failure rule, nothing to fetch.
		if (options.staticContent != null) {
			return { message: { customType: options.customType, content: options.staticContent, display: true } };
		}

		// The snapshot is the parent's: a subagent's brief already names the
		// objects it owns, and the snapshot's deictic framing would point it at
		// its own empty selection while reading as authoritative.
		if (readActiveAgentName(event.systemPrompt) !== null) return undefined;

		let content: string;
		try {
			content = options.formatState!(await options.fetchState!(ctx), {
				timeoutMs,
				extraGuidance: options.extraGuidance ?? (() => []),
			});
		} catch (error) {
			const recover = options.failureGuidance
				? options.failureGuidance(error)
				: "Call the session-context tool before mutating anything, and ask the user if it also fails.";
			content = [
				`Live ${options.section} state is UNAVAILABLE for this turn (the bridge did not answer within ` +
					`${timeoutMs} ms: ${error instanceof Error ? error.message : String(error)}).`,
				`Do NOT assume any ${options.assumeNothingAbout ?? "selection, active object, viewport, or camera state"} from earlier turns.`,
				recover,
			].join("\n");
		}

		if (!content || content.trim().length === 0) return undefined;
		return { message: { customType: options.customType, content, display: true } };
	};
}

/* -------------------------------------------------------------- commands -- */

export interface EngageCommandOptions {
	name: string;
	description?: string;
	usage?: string;
	engagedMessage?: string;
	onEngage?: () => void;
	fallbackTask?: string;
	/** Forwarded to pi unchanged, `null` included. Never wrapped. */
	getArgumentCompletions?: (argumentPrefix: string) => unknown[] | null | Promise<unknown[] | null>;
}

export function registerEngageCommand(
	pi: {
		registerCommand(
			name: string,
			options: {
				description?: string;
				getArgumentCompletions?: (prefix: string) => unknown[] | null | Promise<unknown[] | null>;
				handler(args: string, ctx: unknown): Promise<void>;
			},
		): void;
		sendUserMessage(text: string, options?: { deliverAs?: string }): void;
	},
	options: EngageCommandOptions,
): void {
	pi.registerCommand(options.name, {
		description: options.description ?? `Send a task — everything after /${options.name} is the prompt`,
		...(options.getArgumentCompletions ? { getArgumentCompletions: options.getArgumentCompletions } : {}),
		async handler(args, rawCtx) {
			const ctx = rawCtx as { ui: { notify(message: string, level?: string): void }; isIdle(): boolean };
			const task = String(args ?? "").trim();
			if (!task && !options.fallbackTask) {
				ctx.ui.notify(`Usage: /${options.name} ${options.usage ?? "<what to build or change>"}`, "info");
				return;
			}
			options.onEngage?.();
			ctx.ui.notify(options.engagedMessage ?? "Engaged — this session is the manager.", "info");
			pi.sendUserMessage(task || (options.fallbackTask as string), {
				deliverAs: ctx.isIdle() ? undefined : "steer",
			});
		},
	});
}

export interface ExitCommandOptions {
	name: string;
	description?: string;
	notEngagedMessage?: string;
	exitedMessage?: string;
	onExit?: () => boolean;
}

export function registerExitCommand(
	pi: { registerCommand(name: string, options: { description?: string; handler(args: string, ctx: unknown): Promise<void> }): void },
	options: ExitCommandOptions,
): void {
	pi.registerCommand(options.name, {
		description: options.description ?? "Leave manager mode — lift the write/edit/image gate",
		async handler(_args, rawCtx) {
			const ctx = rawCtx as { ui: { notify(message: string, level?: string): void } };
			const cleared = options.onExit ? options.onExit() : true;
			if (!cleared) {
				ctx.ui.notify(options.notEngagedMessage ?? "Not in manager mode — nothing to exit.", "info");
				return;
			}
			ctx.ui.notify(
				options.exitedMessage ?? "Left manager mode. The session and the tools are still available.",
				"info",
			);
		},
	});
}


