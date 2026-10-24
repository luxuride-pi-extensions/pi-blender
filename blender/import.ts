/**
 * Ingress for external 3D geometry into the workspace blend.
 *
 * Checkpoints the workspace before importing so partial imports are cleanly revertible.
 * Guards against path traversal and sanitizes asset names before passing to Blender.
 * Works headlessly or into an active live session through live-bridge.
 */

import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { requestBridge } from "./bridge.js";
import type { ImportAssetOptions, ImportAssetResult, ImportFormat, ImportReport } from "./types.js";
import { loadWorkspaceManifest } from "./workspace.js";

interface BridgeImportResponse {
	success: boolean;
	status?: string;
	format?: string;
	sourcePath?: string;
	assetName?: string;
	blendPath?: string | null;
	importedObjects?: string[];
	report?: ImportReport;
	error?: string;
}

function isPathInside(target: string, parent: string): boolean {
	const rel = relative(parent, target);
	return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Sanitize asset name to protect against special characters or path separators.
 */
export function sanitizeAssetName(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/^[./\\]+/, "")
		.replace(/[./\\]+/g, "_")
		.replace(/[^A-Za-z0-9_-]+/g, "_")
		.replace(/_{2,}/g, "_")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : "asset";
}

export async function blenderImportAsset(options: ImportAssetOptions): Promise<ImportAssetResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);

	const sourcePath = isAbsolute(options.path) ? options.path : resolve(options.cwd, options.path);
	if (!existsSync(sourcePath)) {
		throw new Error(`Source asset file does not exist: "${sourcePath}".`);
	}

	// Path traversal guard: validate source file against allowed roots
	const allowedRoots = (options.allowedPaths && options.allowedPaths.length > 0)
		? options.allowedPaths.map((p) => resolve(options.cwd, p))
		: [resolve(options.cwd), resolve(manifest.workspacePath)];

	const canonicalSource = realpathSync(sourcePath);
	const isAllowed = allowedRoots.some((root) => {
		try {
			const canonicalRoot = existsSync(root) ? realpathSync(root) : root;
			return isPathInside(canonicalSource, canonicalRoot);
		} catch {
			return false;
		}
	});

	if (!isAllowed) {
		throw new Error(
			`Path traversal guard rejected source path "${options.path}" (${canonicalSource}). ` +
				`Path is outside allowed paths: ${allowedRoots.join(", ")}.`,
		);
	}

	const ext = extname(sourcePath).replace(/^\./, "").toLowerCase();
	const format = (options.format ?? ext).toLowerCase() as ImportFormat;

	// Sanitize asset name
	const rawName = options.name ?? basename(sourcePath, extname(sourcePath));
	const sanitizedName = sanitizeAssetName(rawName);

	// Checkpoint workspace before mutation so partial imports are cleanly revertible
	const checkpointsDir = join(manifest.workspacePath, "checkpoints");
	await mkdir(checkpointsDir, { recursive: true });
	const timestamp = Date.now();
	const checkpointPath = join(checkpointsDir, `pre-import-${timestamp}.blend`);
	await copyFile(manifest.blendPath, checkpointPath);

	let bridgeResult: BridgeImportResponse;
	try {
		bridgeResult = await requestBridge<BridgeImportResponse>({
			payload: {
				type: "import",
				blendPath: manifest.blendPath,
				sourcePath: canonicalSource,
				format,
				name: sanitizedName,
			},
			label: "import",
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
	} catch (error) {
		// Revert to checkpoint on crash or communication error
		await copyFile(checkpointPath, manifest.blendPath).catch(() => undefined);
		throw error;
	}

	if (!bridgeResult.success) {
		// Revert to checkpoint if import failed inside Blender
		await copyFile(checkpointPath, manifest.blendPath).catch(() => undefined);
		return {
			success: false,
			status: bridgeResult.status ?? "failed",
			format: bridgeResult.format ?? format,
			sourcePath: canonicalSource,
			assetName: sanitizedName,
			workspacePath: manifest.workspacePath,
			checkpointPath,
			importedObjects: [],
			error: bridgeResult.error ?? "Import failed",
		};
	}

	return {
		success: true,
		status: "imported",
		format: (bridgeResult.format ?? format) as ImportFormat,
		sourcePath: canonicalSource,
		assetName: sanitizedName,
		workspacePath: manifest.workspacePath,
		checkpointPath,
		importedObjects: bridgeResult.importedObjects ?? [],
		report: bridgeResult.report,
	};
}
