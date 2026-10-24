/**
 * blender/doc-grounding.ts
 *
 * Bridge-free offline documentation grounding tools for Blender 4.2 LTS.
 *
 * These utilities provide query and search access over the curated Blender 4.2
 * API reference and user manual corpus under docs/reference/. They are purely
 * host-bound file/in-memory operations: they NEVER take bridge.lock or require
 * running a live Blender instance.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { getBlenderDocsReferenceDir } from "../config.js";

export interface BlenderDocParam {
	name: string;
	type?: string;
	description?: string;
	default?: string;
}

export interface BlenderApiDocResult {
	identifier: string;
	found: boolean;
	kind?: "operator" | "type" | "data" | "context" | "property" | "wildcard" | "module";
	signature?: string | null;
	doc?: string | null;
	parameters?: BlenderDocParam[];
	source?: string | null;
	count?: number;
	matches?: Array<{ identifier: string; summary?: string; signature?: string }>;
	message?: string;
}

export interface BlenderSearchMatch {
	identifier?: string;
	title?: string;
	topic?: string;
	signature?: string;
	file: string;
	snippet: string;
	score?: number;
}

export interface BlenderSearchResult {
	query: string;
	totalMatches: number;
	matches: BlenderSearchMatch[];
}

interface ParsedApiEntry {
	identifier: string;
	kind: "operator" | "type" | "data" | "context" | "property" | "module";
	signature: string;
	summary: string;
	fullDoc: string;
	parameters: BlenderDocParam[];
	file: string;
}

interface ParsedManualSection {
	title: string;
	topic: string;
	content: string;
	file: string;
}

// In-memory cache per docs directory
let cachedApiEntries: { docsDir: string; entries: ParsedApiEntry[] } | null = null;
let cachedManualSections: { docsDir: string; sections: ParsedManualSection[] } | null = null;

function resolveDocsDir(customDir?: string): string {
	if (customDir && existsSync(customDir)) {
		return customDir;
	}
	const defaultDir = getBlenderDocsReferenceDir();
	if (existsSync(defaultDir)) {
		return defaultDir;
	}
	// Fallback relative to import.meta if configured dir differs
	return defaultDir;
}

/**
 * Parse an API markdown file into individual symbol entries.
 */
function parseApiFile(filePath: string, content: string, rootDocsDir: string): ParsedApiEntry[] {
	const relPath = relative(rootDocsDir, filePath);
	const lines = content.split("\n");
	const entries: ParsedApiEntry[] = [];

	let currentHeading = "";
	let currentLines: string[] = [];

	function flushSection() {
		if (!currentHeading || currentLines.length === 0) return;

		// Extract identifier from heading, e.g. "### bpy.ops.mesh.primitive_cube_add"
		// or "### bpy.types.Object"
		const rawTitle = currentHeading.replace(/^#+\s*/, "").trim();
		const idMatch = rawTitle.match(/^(bpy\.[a-zA-Z0-9_.]+)/);
		if (!idMatch || !idMatch[1]) return;

		const identifier = idMatch[1];
		const fullText = currentLines.join("\n").trim();

		// Detect signature from first ```python ... ``` block
		let signature = "";
		const sigMatch = fullText.match(/```python\s*([\s\S]*?)\s*```/);
		if (sigMatch && sigMatch[1]) {
			signature = sigMatch[1].trim();
		}

		// Detect summary (first line after signature or heading that is not empty/code)
		let summary = "";
		for (const line of currentLines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```") || trimmed.startsWith("-")) {
				continue;
			}
			summary = trimmed;
			break;
		}

		// Parse parameter bullet lines
		const parameters: BlenderDocParam[] = [];
		for (const line of currentLines) {
			const paramMatch = line.match(/^-\s*`([a-zA-Z0-9_]+)`(?:\s*\(([^)]+)\))?:\s*(.*)$/);
			if (paramMatch && paramMatch[1]) {
				const paramName = paramMatch[1];
				const paramType = paramMatch[2] || "";
				const paramDesc = paramMatch[3] || "";
				let defVal: string | undefined;
				const defMatch = paramType.match(/default\s+([^,]+)/);
				if (defMatch && defMatch[1]) defVal = defMatch[1].trim();

				parameters.push({
					name: paramName,
					type: paramType,
					description: paramDesc,
					default: defVal,
				});
			}
		}

		// Determine kind
		let kind: ParsedApiEntry["kind"] = "operator";
		if (identifier.startsWith("bpy.types.")) {
			kind = "type";
		} else if (identifier.startsWith("bpy.data.")) {
			kind = "data";
		} else if (identifier.startsWith("bpy.context.")) {
			kind = "context";
		} else if (identifier.startsWith("bpy.props.")) {
			kind = "property";
		}

		entries.push({
			identifier,
			kind,
			signature: signature || identifier,
			summary,
			fullDoc: fullText,
			parameters,
			file: relPath,
		});
	}

	for (const line of lines) {
		if (/^#{2,3}\s+bpy\./.test(line)) {
			flushSection();
			currentHeading = line;
			currentLines = [line];
		} else if (currentHeading) {
			currentLines.push(line);
		}
	}
	flushSection();

	return entries;
}

/**
 * Load and index all API entries across docs/reference/api.
 */
function loadApiEntries(docsDir: string): ParsedApiEntry[] {
	if (cachedApiEntries && cachedApiEntries.docsDir === docsDir) {
		return cachedApiEntries.entries;
	}

	const apiDir = join(docsDir, "api");
	const entries: ParsedApiEntry[] = [];

	if (existsSync(apiDir)) {
		const files = readdirSync(apiDir).filter((f) => f.endsWith(".md") || f.endsWith(".rst"));
		for (const file of files) {
			const fullPath = join(apiDir, file);
			const content = readFileSync(fullPath, "utf8");
			const parsed = parseApiFile(fullPath, content, docsDir);
			entries.push(...parsed);
		}
	}

	cachedApiEntries = { docsDir, entries };
	return entries;
}

/**
 * Load and index all manual sections across docs/reference/manual.
 */
function loadManualSections(docsDir: string): ParsedManualSection[] {
	if (cachedManualSections && cachedManualSections.docsDir === docsDir) {
		return cachedManualSections.sections;
	}

	const manualDir = join(docsDir, "manual");
	const sections: ParsedManualSection[] = [];

	if (existsSync(manualDir)) {
		const files = readdirSync(manualDir).filter((f) => f.endsWith(".md") || f.endsWith(".rst"));
		for (const file of files) {
			const fullPath = join(manualDir, file);
			const relPath = relative(docsDir, fullPath);
			const topic = basename(file, file.endsWith(".md") ? ".md" : ".rst");
			const content = readFileSync(fullPath, "utf8");

			const lines = content.split("\n");
			let currentTitle = "";
			let currentLines: string[] = [];

			function flushSection() {
				if (!currentTitle || currentLines.length === 0) return;
				sections.push({
					title: currentTitle.replace(/^#+\s*/, "").trim(),
					topic,
					content: currentLines.join("\n").trim(),
					file: relPath,
				});
			}

			for (const line of lines) {
				if (/^#{1,3}\s+/.test(line)) {
					flushSection();
					currentTitle = line;
					currentLines = [line];
				} else if (currentTitle) {
					currentLines.push(line);
				}
			}
			flushSection();
		}
	}

	cachedManualSections = { docsDir, sections };
	return sections;
}

/**
 * Extract a concise snippet around query match occurrences.
 */
function extractSnippet(text: string, queryWords: string[], maxLength = 260): string {
	const lower = text.toLowerCase();
	let firstIndex = -1;

	for (const word of queryWords) {
		const idx = lower.indexOf(word);
		if (idx !== -1 && (firstIndex === -1 || idx < firstIndex)) {
			firstIndex = idx;
		}
	}

	if (firstIndex === -1) {
		return text.slice(0, maxLength).replace(/\s+/g, " ").trim();
	}

	const start = Math.max(0, firstIndex - 60);
	const end = Math.min(text.length, start + maxLength);
	let snippet = text.slice(start, end).replace(/\s+/g, " ").trim();

	if (start > 0) snippet = "..." + snippet;
	if (end < text.length) snippet = snippet + "...";

	return snippet;
}

/**
 * Retrieve documentation for a specific bpy identifier or list submodules via wildcard *.
 */
export async function blenderGetPythonApiDocs(options: {
	identifier: string;
	docsDir?: string;
}): Promise<BlenderApiDocResult> {
	const rawId = (options.identifier || "").trim();
	if (!rawId) {
		return {
			identifier: "",
			found: false,
			signature: null,
			doc: null,
			message: "Identifier must not be empty.",
		};
	}

	const docsDir = resolveDocsDir(options.docsDir);
	const entries = loadApiEntries(docsDir);

	// Wildcard search (e.g. bpy.ops.mesh.* or bpy.types.* or bpy.*)
	if (rawId.endsWith("*")) {
		const prefix = rawId.slice(0, -1);
		const matches = entries
			.filter((e) => e.identifier.startsWith(prefix))
			.map((e) => ({
				identifier: e.identifier,
				summary: e.summary,
				signature: e.signature,
			}));

		return {
			identifier: rawId,
			found: matches.length > 0,
			kind: "wildcard",
			count: matches.length,
			matches,
			message:
				matches.length > 0
					? `Found ${matches.length} matching API entries for '${rawId}' in Blender 4.2 LTS`
					: `No matching API entries found for wildcard '${rawId}' in Blender 4.2 LTS`,
		};
	}

	// Exact identifier search
	const exactMatch = entries.find(
		(e) => e.identifier.toLowerCase() === rawId.toLowerCase(),
	);

	if (exactMatch) {
		return {
			identifier: exactMatch.identifier,
			found: true,
			kind: exactMatch.kind,
			signature: exactMatch.signature,
			doc: exactMatch.fullDoc,
			parameters: exactMatch.parameters,
			source: exactMatch.file,
		};
	}

	// Check if identifier refers to a module prefix without * (e.g. "bpy.ops.mesh")
	const subMatches = entries.filter((e) =>
		e.identifier.toLowerCase().startsWith(rawId.toLowerCase() + "."),
	);

	if (subMatches.length > 0) {
		return {
			identifier: rawId,
			found: true,
			kind: "module",
			count: subMatches.length,
			matches: subMatches.map((e) => ({
				identifier: e.identifier,
				summary: e.summary,
				signature: e.signature,
			})),
			message: `Module '${rawId}' in Blender 4.2 LTS contains ${subMatches.length} documented items`,
		};
	}

	// Unknown identifier: return empty result without throwing
	return {
		identifier: rawId,
		found: false,
		signature: null,
		doc: null,
		message: `No API documentation found for '${rawId}' in Blender 4.2 LTS reference corpus`,
	};
}

/**
 * Full-text search across the API reference corpus.
 */
export async function blenderSearchApiDocs(options: {
	query: string;
	limit?: number;
	docsDir?: string;
}): Promise<BlenderSearchResult> {
	const rawQuery = (options.query || "").trim();
	if (!rawQuery) {
		return { query: rawQuery, totalMatches: 0, matches: [] };
	}

	const docsDir = resolveDocsDir(options.docsDir);
	const entries = loadApiEntries(docsDir);
	const limit = Math.max(1, Math.min(options.limit ?? 10, 50));

	const lowerQuery = rawQuery.toLowerCase();
	const queryTokens = lowerQuery.split(/\s+/).filter((t) => t.length > 0);

	const scored: BlenderSearchMatch[] = [];

	for (const entry of entries) {
		const idLower = entry.identifier.toLowerCase();
		const sigLower = entry.signature.toLowerCase();
		const docLower = entry.fullDoc.toLowerCase();

		let score = 0;

		// Exact matches
		if (idLower === lowerQuery) {
			score += 150;
		} else if (idLower.includes(lowerQuery)) {
			score += 80;
		}

		if (sigLower.includes(lowerQuery)) {
			score += 50;
		}

		// Token-based matching
		let allTokensFound = true;
		for (const token of queryTokens) {
			const inId = idLower.includes(token);
			const inSig = sigLower.includes(token);
			const inDoc = docLower.includes(token);

			if (inId) score += 30;
			if (inSig) score += 20;
			if (inDoc) score += 10;

			if (!inId && !inSig && !inDoc) {
				allTokensFound = false;
			}
		}

		if (allTokensFound && queryTokens.length > 1) {
			score += 40;
		}

		if (score > 0) {
			scored.push({
				identifier: entry.identifier,
				signature: entry.signature,
				file: entry.file,
				snippet: extractSnippet(entry.fullDoc, queryTokens),
				score,
			});
		}
	}

	scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	return {
		query: rawQuery,
		totalMatches: scored.length,
		matches: scored.slice(0, limit),
	};
}

/**
 * Full-text search across user manual excerpts.
 */
export async function blenderSearchManualDocs(options: {
	query: string;
	limit?: number;
	docsDir?: string;
}): Promise<BlenderSearchResult> {
	const rawQuery = (options.query || "").trim();
	if (!rawQuery) {
		return { query: rawQuery, totalMatches: 0, matches: [] };
	}

	const docsDir = resolveDocsDir(options.docsDir);
	const sections = loadManualSections(docsDir);
	const limit = Math.max(1, Math.min(options.limit ?? 10, 50));

	const lowerQuery = rawQuery.toLowerCase();
	const queryTokens = lowerQuery.split(/\s+/).filter((t) => t.length > 0);

	const scored: BlenderSearchMatch[] = [];

	for (const section of sections) {
		const titleLower = section.title.toLowerCase();
		const topicLower = section.topic.toLowerCase();
		const contentLower = section.content.toLowerCase();

		let score = 0;

		// Exact matches in title or topic
		if (titleLower === lowerQuery || topicLower === lowerQuery) {
			score += 120;
		} else if (titleLower.includes(lowerQuery) || topicLower.includes(lowerQuery)) {
			score += 70;
		}

		if (contentLower.includes(lowerQuery)) {
			score += 40;
		}

		// Token-based matching
		let allTokensFound = true;
		for (const token of queryTokens) {
			const inTitle = titleLower.includes(token);
			const inTopic = topicLower.includes(token);
			const inContent = contentLower.includes(token);

			if (inTitle) score += 30;
			if (inTopic) score += 20;
			if (inContent) score += 10;

			if (!inTitle && !inTopic && !inContent) {
				allTokensFound = false;
			}
		}

		if (allTokensFound && queryTokens.length > 1) {
			score += 35;
		}

		if (score > 0) {
			scored.push({
				title: section.title,
				topic: section.topic,
				file: section.file,
				snippet: extractSnippet(section.content, queryTokens),
				score,
			});
		}
	}

	scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

	return {
		query: rawQuery,
		totalMatches: scored.length,
		matches: scored.slice(0, limit),
	};
}
