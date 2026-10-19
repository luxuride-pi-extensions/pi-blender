import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderAssetsDir } from "../config.js";
import type { UsageGuessOptions, UsageGuessResult } from "./types.js";
import { fileExists, normalizeUserPath, normalizeWorkspacePath, runBlenderJson } from "./utils.js";
import { readManifest } from "./workspace.js";

let cachedScript: string | null = null;

async function getUsageGuessScript(): Promise<string> {
	if (!cachedScript) {
		const scriptPath = join(getBlenderAssetsDir(), "usage_guess.py");
		cachedScript = await readFile(scriptPath, "utf-8");
	}
	return cachedScript;
}

export async function blenderUsageGuess(options: UsageGuessOptions): Promise<UsageGuessResult> {
	let blendPath: string;
	let workspacePath: string | undefined;

	if (options.workspace) {
		workspacePath = normalizeWorkspacePath(options.cwd, options.workspace);
		const manifest = await readManifest(workspacePath);
		if (manifest) {
			blendPath = manifest.blendPath;
		} else {
			blendPath = join(workspacePath, "model.blend");
		}
	} else if (options.blendPath) {
		blendPath = normalizeUserPath(options.cwd, options.blendPath);
	} else {
		throw new Error("Either workspace or blendPath must be provided to blender_usage_guess.");
	}

	if (!(await fileExists(blendPath))) {
		throw new Error(`Blend file not found: ${blendPath}`);
	}

	const scriptSource = await getUsageGuessScript();
	const raw = await runBlenderJson<Omit<UsageGuessResult, "blendPath" | "workspacePath">>({
		cwd: options.cwd,
		blendPath,
		scriptSource,
		payload: {},
		signal: options.signal,
		timeoutMs: 60_000,
	});

	return {
		blendPath,
		workspacePath,
		categories: raw.categories,
		primaryGuess: raw.primaryGuess,
		allSignals: raw.allSignals,
	};
}
