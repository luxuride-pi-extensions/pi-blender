/**
 * Export the workspace blend to an interchange format, headlessly.
 *
 * This is the boundary that makes the harness usable for anything downstream:
 * until now every result of a build was a .blend and a set of PNGs, and a .blend
 * is not an interchange format. The handler lives in the bridge so the export
 * runs the same way windowed and headless, and so it opens the blend itself --
 * headless there is no session holding the file open.
 */

import { existsSync } from "node:fs";
import { requestBridge } from "./bridge.js";
import type { AssetExportOptions, AssetExportResult, ExportFormat } from "./types.js";
import { loadWorkspaceManifest } from "./workspace.js";

/** Formats the handler dispatches to. Kept here so a bad value fails before a spawn. */
const EXPORT_FORMATS: ExportFormat[] = ["glb", "gltf", "obj", "stl"];

export async function blenderExportAsset(options: AssetExportOptions): Promise<AssetExportResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const format = (options.format ?? "glb").toLowerCase() as ExportFormat;
	if (!EXPORT_FORMATS.includes(format)) {
		throw new Error(
			`Unsupported export format "${format}". Supported: ${EXPORT_FORMATS.join(", ")}. USD is deliberately not offered: no exporter is guaranteed present in a stock Blender build, and a format that fails on one machine is worse than one not offered.`,
		);
	}

	const result = await requestBridge<{
		format: string;
		exportPath: string;
		bytes: number;
		meshCount: number;
		blendPath: string | null;
	}>({
		payload: {
			type: "export",
			blendPath: manifest.blendPath,
			format,
			objects: options.objects,
			outputDir: options.outputDir,
			name: options.name,
			animations: options.animations,
		},
		label: "export",
		timeoutMs: options.timeoutMs,
		signal: options.signal,
	});

	// The handler checks this too, and both checks are wanted: the handler's
	// catches a lie from inside Blender, and this catches a file that existed
	// before and was not rewritten. Trusting the reported size alone would let
	// a stale export be reported as a fresh one.
	if (!existsSync(result.exportPath)) {
		throw new Error(
			`Blender reported the ${result.format} export at ${result.exportPath} but no file is there. The exporter returned success and wrote nothing, so nothing was exported.`,
		);
	}

	return {
		workspacePath: manifest.workspacePath,
		exportPath: result.exportPath,
		format: result.format as ExportFormat,
		bytes: result.bytes,
		meshCount: result.meshCount,
		objects: options.objects,
	};
}