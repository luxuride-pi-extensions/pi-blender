import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getBridgeAssetsDir } from "../config.js";
import type { ObjectDetailOptions, ObjectDetailResult } from "./types.js";
import { runBlenderJson } from "./utils.js";
import { loadWorkspaceManifest } from "./workspace.js";

// Read on first use rather than at module load: the script lives in the GPL
// bridge package, and a missing install must surface as this tool's error (with
// the resolver's list of candidates it tried), not as a failed extension load.
let cachedObjectDetailScript: string | undefined;
function objectDetailScript(): string {
	cachedObjectDetailScript ??= readFileSync(join(getBridgeAssetsDir(), "object_detail.py"), "utf-8");
	return cachedObjectDetailScript;
}

export async function blenderObjectDetail(options: ObjectDetailOptions): Promise<ObjectDetailResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const target = options.objectName ?? options.targetObject ?? options.name;
	if (!target) {
		throw new Error("objectName (or targetObject, name) is required for blenderObjectDetail.");
	}

	const raw = await runBlenderJson<Omit<ObjectDetailResult, "workspacePath" | "blendPath">>({
		cwd: options.cwd,
		blendPath: manifest.blendPath,
		scriptSource: objectDetailScript(),
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
