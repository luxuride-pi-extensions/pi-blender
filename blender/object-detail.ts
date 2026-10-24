import { readFileSync } from "node:fs";
import type { ObjectDetailOptions, ObjectDetailResult } from "./types.js";
import { runBlenderJson } from "./utils.js";
import { loadWorkspaceManifest } from "./workspace.js";

const OBJECT_DETAIL_SCRIPT = readFileSync(new URL("./object_detail.py", import.meta.url), "utf-8");

export async function blenderObjectDetail(options: ObjectDetailOptions): Promise<ObjectDetailResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const target = options.objectName ?? options.targetObject ?? options.name;
	if (!target) {
		throw new Error("objectName (or targetObject, name) is required for blenderObjectDetail.");
	}

	const raw = await runBlenderJson<Omit<ObjectDetailResult, "workspacePath" | "blendPath">>({
		cwd: options.cwd,
		blendPath: manifest.blendPath,
		scriptSource: OBJECT_DETAIL_SCRIPT,
		payload: {
			objectName: target,
		},
		signal: options.signal,
		timeoutMs: 60_000,
	});

	return {
		workspacePath: manifest.workspacePath,
		blendPath: manifest.blendPath,
		...raw,
	};
}
