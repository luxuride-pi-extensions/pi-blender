import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getBlenderTempDir } from "../config.js";
import { NoWatchWindowError, requestLiveBlenderWindowLayout } from "./bridge.js";
import type { WindowLayoutOptions, WindowLayoutResult } from "./types.js";
import { loadWorkspaceManifest } from "./workspace.js";

export type { WindowLayoutOptions, WindowLayoutResult };

export async function blenderWindowLayout(options: WindowLayoutOptions = {}): Promise<WindowLayoutResult> {
	let blendPath: string | undefined;
	if (options.workspace) {
		try {
			const cwd = options.cwd ?? process.cwd();
			const manifest = await loadWorkspaceManifest(cwd, options.workspace);
			blendPath = manifest.blendPath;
		} catch {
			// Without a manifest, continue with unpinned live inspection
		}
	}

	const format = options.format ?? (options.screenshot || options.as_image ? "image" : "json");
	const screenshot = format === "image" || Boolean(options.screenshot || options.as_image);
	const as_json = options.as_json ?? !screenshot;

	let outputPath = options.output_path;
	if (screenshot && !outputPath) {
		outputPath = join(getBlenderTempDir(), "screenshots", `screenshot-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
	}

	try {
		return await requestLiveBlenderWindowLayout({
			blendPath,
			format,
			screenshot,
			as_image: options.as_image,
			as_json,
			area_type: options.area_type,
			max_bytes: options.max_bytes,
			output_path: outputPath,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
		});
	} catch (error) {
		if (error instanceof NoWatchWindowError) {
			return {
				ok: false,
				layout: null,
				areas: [],
				activeObject: null,
				selection: null,
				captured: false,
				reason: error.message,
			};
		}
		throw error;
	}
}
