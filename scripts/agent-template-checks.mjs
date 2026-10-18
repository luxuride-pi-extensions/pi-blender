/**
 * The checks every agent-template installer runs, extracted from the copy that
 * was written first (pi-unity-blender) and shared so the other two cannot ship a
 * template the first would have rejected.
 *
 * These guard SILENT failures, which is why they are worth sharing rather than
 * retyping. An agent template's `tools:` is a strict allowlist and its
 * `extensions:` line is the only provider list, and neither failure mode
 * produces an error anywhere: the agent is simply handed a call it can never
 * make. An installer that writes such a file and reports success is worse than
 * one that refuses, because the breakage surfaces much later, inside a run.
 *
 * Copied into each consumer rather than imported, for the same reason as the
 * manager-core resolver shim: an installer has to work in a checkout that has
 * only one extension. test/resolver-copies.mjs diffs the copies so they cannot
 * drift. (The fallback core that used to be the other reason is gone -- a
 * missing core is a hard error now, so there is no second copy that could
 * drift, and a check that must be copied is kept down to one file.)
 */

/**
 * Words that look like a tool name to the scanner but are not one.
 *
 * The scanner cannot see a registry, so anything in the prompt body that
 * matches the tool-name SHAPE is a candidate. `in_progress` is a todo status,
 * not a tool, and without this exemption every template that mentions a todo
 * state would warn.
 */
export const KNOWN_NON_TOOL_WORDS = new Set([
	"in_progress",
	// Bare bpy attribute and operator names, which cannot be recognised by
	// namespace: `rotation_euler` and `transform_apply` are not prefixed, so
	// only the word itself says where it came from. Curated rather than
	// exhaustive, because these are the ones the shipped Blender prompts
	// actually quote.
	"rotation_euler",
	// The field that is NOT a render colour, quoted by every prompt that has to
	// warn a worker off it. `material.diffuse_color` is namespaced, so the
	// exemption does not cover the bare word.
	"diffuse_color",
	"shade_auto_smooth",
	"shade_smooth",
	"shade_flat",
	"shade_smooth_by_angle",
	"transform_apply",
	"use_auto_smooth",
	"auto_smooth_angle",
]);

/**
 * Names in the bpy namespace, which the scanner must not treat as pi tools.
 *
 * The Blender prompts are written against bpy as much as against the tool
 * surface, and the two share the snake_case shape: `shade_auto_smooth`,
 * `transform_apply`, `data.objects` all match the tool-name rule exactly. They
 * are exempt by NAMESPACE rather than by listing every name, because a list
 * would need a new entry every time the finalizer's script evolves, and every
 * one of those entries is a chance to miss.
 */
const BPY_NAMESPACE = /^(bpy|math|random|os|json|mathutils|re|time)\b|^data\.|^ops\./;

/**
 * Words that turn a backticked tool name into something other than an
 * instruction to call it.
 *
 * Without this, EVERY warning in the agent corpus is a false positive: agent
 * prompts spend a lot of prose on boundaries ("You never edit anything — no
 * `write`, no `blender_execute_python`", "there is no `unity_add_reference`
 * tool", "use `unity_module_run`, which is the only path"), and a scanner that
 * cannot tell a boundary from an instruction reports all of them. A check whose
 * every hit is noise trains the reader to ignore it, which is worse than having
 * no check.
 *
 * Two sub-classes, because they fail differently:
 *  - NEGATION_CUES: the READER is told not to call it.
 *  - THIRD_PARTY_CUES: someone ELSE is the one calling it. A critic's brief
 *    legitimately says "the manager registers it with `blender_add_reference`",
 *    and the critic has no business calling that tool. Reporting it tells the
 *    author to add a tool the agent must never use.
 *
 * Deliberately narrow: each cue is a way English actually writes a prohibition,
 * a rename, or an attribution. A looser list would suppress real findings, and a
 * missed finding is a template shipping broken.
 */
const NEGATION_CUES = [
	"no ",
	"not ",
	"never",
	"don't",
	"do not",
	"without",
	"instead of",
	"rather than",
	"cannot",
	"can't",
	"won't",
	"avoid",
];

/**
 * Attributions: the sentence names the tool as something ANOTHER actor does.
 *
 * Scoped to the clause before the name for the same reason as the negations.
 */
const THIRD_PARTY_CUES = [
	"the manager",
	"the worker",
	"the critic",
	"the user",
	"already registered",
	"registers it with",
	"registers the",
];

/** The `tools:` entries of a template, as a Set. */
export function declaredTools(source) {
	return new Set(
		(/^tools:.*$/m.exec(source)?.[0] ?? "")
			.split(":")[1]
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean) ?? [],
	);
}

/** Does this template's tools: list name the given tool? */
export function namesTool(source, name) {
	return declaredTools(source).has(name);
}

/** Does this template's tools: list name a tool that `todo` provides? */
export function usesTodo(source) {
	return namesTool(source, "todo");
}

/**
 * Tools the prompt tells the agent to call that `tools:` does not list.
 *
 * The candidate scan is deliberately narrow. Pi tool names are snake_case with
 * an underscore (unity_scene_info, blender_scene_info); tool PARAMETERS are
 * camelCase or a bare lowercase word (objectNames, saveAfter, mode). Requiring
 * an underscore is what separates the two. Only BACKTICKED names are scanned,
 * so a tool referenced in plain prose is not checked — a known gap, accepted
 * because a looser rule produces more noise than signal.
 *
 * The scan is LINE-scoped for negations, not sentence-scoped: a prompt often
 * states a boundary in one clause and a real instruction in the next, and
 * scanning the whole paragraph would suppress the instruction too.
 */
/**
 * Every pi tool name the prompt names as something to CALL, negations removed.
 *
 * The inverse of `toolsMissingFromAllowlist`, and it exists for a different
 * defect: a prompt (or a README) telling an agent to use a tool that was never
 * registered. `unity_capture_view` was implemented, dispatched in C#, listed in
 * the README and named in the manager prompt -- and never passed to
 * registerTool. Nothing failed: tsc was clean, the tests were green, and every
 * document was correct about a tool that did not exist.
 *
 * So the caller supplies the set of tools that actually exist, and this returns
 * what the prose promises. Negation handling is the same machinery and for the
 * same reason: a prompt that says "you never call `x` directly" is handing the
 * name to a reader, not asking for a call.
 */
export function advisedToolNames(source) {
	const body = source.replace(/^---[\s\S]*?\n---\n/, "");
	const mentioned = new Map();
	for (const match of body.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
		const name = match[1];
		const negated = isNegated(body, match.index ?? 0, name);
		mentioned.set(name, (mentioned.get(name) ?? true) && negated);
	}
	return [...mentioned]
		.filter(([name, negated]) => !negated && !KNOWN_NON_TOOL_WORDS.has(name) && !BPY_NAMESPACE.test(name))
		.map(([name]) => name);
}

/**
 * Tools the prompt tells the agent to call that `tools:` does not list.
 *
 * The candidate scan is delegated to `advisedToolNames` above, which is the
 * same list filtered one step further. The note on the scan (snake_case vs
 * camelCase, backticks only, line-scoped negations) belongs there.
 */
export function toolsMissingFromAllowlist(source) {
	const declared = declaredTools(source);
	return advisedToolNames(source).filter((name) => !declared.has(name));
}

/**
 * Is this mention a boundary rather than an instruction?
 *
 * `body` must be the SAME string the match index came from. Slicing the
 * unstripped source by a body-relative index lands in the frontmatter, and
 * every mention then reads as unnegated.
 *
 * Only the text BEFORE the name on its own line is examined, and only the
 * portion of it a single clause could plausibly reach: a negation separated
 * from the name by a semicolon, a sentence end, or a line break is describing
 * something else, and treating it as covering the name would hide a real
 * finding.
 */
function isNegated(body, index, name) {
	const lineStart = body.lastIndexOf("\n", index) + 1;
	const before = body.slice(lineStart, index).toLowerCase();
	// Trim to the current clause: a period or semicolon ends a negation's reach.
	const clause = before.split(/[.;!?]/).pop() ?? "";
	// And to a bounded window, so a negation eight clauses back on a long line
	// cannot silently cover an unrelated name.
	const window = clause.slice(-120);
	if (THIRD_PARTY_CUES.some((cue) => window.includes(cue))) return true;
	if (NEGATION_CUES.some((cue) => window.includes(cue))) return true;

	// A WRAPPED negation: markdown wraps prose, so "you do not need to" can end
	// one line with the tool name opening the next. Reached only across a line
	// break that did not end a sentence, so a negation in a finished sentence
	// cannot leak into the next one.
	//
	// The cue must sit at the very END of the previous line. That is what makes
	// this safe: "you do not need to" then a wrap really is one thought, whereas
	// "you do not need to know anything about the scene before you start" then
	// a wrap is a finished clause with a long tail, and treating its negation as
	// covering the next line would hide a real finding.
	if (clause.trim().length > CONTINUATION_MAX_CHARS) return false;
	const previous = body.slice(0, lineStart - 1);
	const previousLineStart = previous.lastIndexOf("\n") + 1;
	const previousLine = previous.slice(previousLineStart).toLowerCase().trimEnd();
	if (!previousLine || /[.:;!?]$/.test(previousLine)) return false;
	for (const cue of NEGATION_CUES) {
		const at = previousLine.lastIndexOf(cue);
		if (at !== -1 && previousLine.length - (at + cue.length) <= WRAPPED_CUE_TAIL_CHARS) return true;
	}
	for (const cue of THIRD_PARTY_CUES) {
		const at = previousLine.lastIndexOf(cue);
		if (at !== -1 && previousLine.length - (at + cue.length) <= WRAPPED_CUE_TAIL_CHARS) return true;
	}
	return false;
}

/**
 * How much text may precede a wrapped mention for it to count as a
 * continuation. Small on purpose: a longer prefix is a clause of its own, and
 * its own negation would have been found in the window above.
 */
const CONTINUATION_MAX_CHARS = 12;

/**
 * How much text may follow the negation on the previous line. This is the
 * guard that matters: it is what tells a wrapped clause apart from a finished
 * one that merely happens to end the line.
 */
const WRAPPED_CUE_TAIL_CHARS = 24;

/**
 * Extensions a template needs but cannot reach, read from the tool prefixes its
 * `tools:` line actually uses.
 *
 * prefix-matched because the tool names carry the application name, and derived
 * from the template rather than hardcoded: a hardcoded list is a second source
 * of truth that can disagree with the file being installed.
 *
 * `isResolvable` is supplied by the caller because resolving an extension
 * directory is per-repo (an installed copy, or a checkout).
 */
export function unresolvedToolProviders(source, isResolvable) {
	const tools = declaredTools(source);
	const missing = [];
	for (const [prefix, extension] of TOOL_PROVIDERS) {
		if ([...tools].some((tool) => tool.startsWith(prefix)) && !isResolvable(extension)) {
			missing.push({ prefix, extension });
		}
	}
	return missing;
}

/** The application prefixes a tool name can carry, and the extension that registers them. */
const TOOL_PROVIDERS = [
	["unity_", "pi-unity-vrchat"],
	["blender_", "pi-blender"],
	["vrchat-", "pi-unity-vrchat"],
];

/**
 * Every problem with one template, as human-readable lines.
 *
 * Returns a list rather than printing, so the caller decides whether a problem
 * is a warning or a failure and each installer keeps its own reporting style.
 * `providers` is the caller's extension resolver; omit it to skip that check.
 */
export function checkTemplate(source, { isResolvable } = {}) {
	const problems = [];

	const missingTools = toolsMissingFromAllowlist(source);
	if (missingTools.length > 0) {
		problems.push(
			`the prompt tells the agent to call ${missingTools.join(", ")}, which tools: does not list. ` +
				`tools: is a strict allowlist, so the installed agent will not have them. Add each to tools:.`,
		);
	}

	if (usesTodo(source) && !hasExtensionsLine(source)) {
		problems.push(
			"names `todo` in tools: but the template has no extensions: line, so the installed agent " +
				"cannot call it.",
		);
	}

	// A surviving placeholder means the file has more than one `extensions:`
	// line and the stamp hit the wrong one.
	if (source.includes("__PI_AGENT_EXTENSION_DIR__")) {
		problems.push("the placeholder survived substitution; the file has more than one extensions: line.");
	}

	if (isResolvable) {
		for (const { prefix, extension } of unresolvedToolProviders(source, isResolvable)) {
			problems.push(
				`tools: names a ${prefix}* tool but the ${extension} extension is not resolvable, so the ` +
					`installed agent cannot call it.`,
			);
		}
	}

	return problems;
}

/** Does the template declare an extensions: line at all? */
function hasExtensionsLine(source) {
	return /^extensions:.*$/m.test(source);
}
