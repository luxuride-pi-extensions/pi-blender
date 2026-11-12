import { copyFile, mkdir, open, rm, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import type {
	AddReferenceOptions,
	AddReferenceResult,
	BlenderReference,
	BlenderWorkspaceManifest,
} from "./types.js";
import { nowIso } from "./utils.js";
import { downloadReferenceImage } from "./reference-sources.js";
import { getManifestPath, loadWorkspaceManifest, readManifest, updateManifest } from "./workspace.js";

/** Extensions the manager and critics can actually reason about. */
const REFERENCE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

/**
 * Make a safe, collision-free filename from a caller-supplied id.
 *
 * The id reaches us from a model, so it is treated as untrusted: anything that
 * is not a letter, digit, dash, or underscore becomes a dash, and the result is
 * capped so a long caption-derived id cannot run past filesystem limits.
 */
function sanitizeReferenceId(raw: string): string {
	const cleaned = raw
		.trim()
		.replace(/[^A-Za-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return cleaned.length > 0 ? cleaned : "reference";
}

async function cleanupDownloaded(path: string | undefined): Promise<void> {
	if (path) await rm(path, { force: true }).catch(() => undefined);
}

function describeFailure(action: string, target: string, error: unknown): Error {
	const reason = error instanceof Error ? error.message : String(error);
	return new Error(`Unable to ${action} ${target}: ${reason}`);
}

async function assertReadableImage(path: string): Promise<number> {
	try {
	 const stats = await stat(path);
		if (!stats.isFile()) {
			throw new Error("it is not a regular file");
		}
		if (stats.size === 0) {
			throw new Error("the file is empty");
		}
		const handle = await open(path, "r");
		const magic = Buffer.alloc(12);
		let bytesRead = 0;
		try {
			({ bytesRead } = await handle.read(magic, 0, 12, 0));
		} finally {
			await handle.close();
		}
		const header = magic.subarray(0, bytesRead);
		const isPng = header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
		const isGif = header.subarray(0, 4).toString("ascii") === "GIF8";
		const isWebp =
			header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
		const isBmp = header.subarray(0, 2).toString("ascii") === "BM";
		if (!isPng && !isJpeg && !isGif && !isWebp && !isBmp) {
			throw new Error("the bytes are not a PNG, JPEG, GIF, WebP or BMP image");
		}
		return stats.size;
	} catch (error) {
		throw describeFailure("read reference image", path, error);
	}
}

export function getReferencesDir(workspacePath: string): string {
	return join(workspacePath, "references");
}

/**
 * Register a reference image with a workspace.
 *
 * The file is COPIED into `<workspace>/references/` rather than referenced in
 * place. That costs disk once per reference and buys three things: the
 * workspace stays self-contained if the user moves or deletes the original, a
 * critic reading the path cannot be handed a path that no longer exists, and
 * the manifest can list every reference the build is being judged against.
 */
export async function blenderAddReference(options: AddReferenceOptions): Promise<AddReferenceResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const referencesDir = getReferencesDir(manifest.workspacePath);
	await mkdir(referencesDir, { recursive: true });

	if (!options.path && !options.url) {
		throw new Error("A reference needs either a local path or an HTTPS url.");
	}
	if (options.path && options.url) {
		throw new Error("Pass either a local path or a url, not both.");
	}
	let downloaded: string | undefined;
	let sourcePath: string;
	try {
		sourcePath = options.url
			? (downloaded = await downloadReferenceImage(options.url, referencesDir, { signal: options.signal }))
			: isAbsolute(options.path as string)
				? (options.path as string)
				: resolve(options.cwd, options.path as string);
	} catch (error) {
		throw describeFailure("download reference image", options.url ?? String(options.path), error);
	}
	try {
	const extension = extname(sourcePath).toLowerCase();
	if (!REFERENCE_EXTENSIONS.has(extension)) {
		throw new Error(
			`Reference "${options.url ?? options.path}" is not a supported image. Supported: ${[...REFERENCE_EXTENSIONS].join(", ")}.`,
		);
	}
	await assertReadableImage(sourcePath);

	const caption = options.caption.trim();
	if (caption.length === 0) {
		// A caption is the only thing the manager can know about an image it is
		// forbidden to read. Without one, a reference is a wasted pairing: the
		// worker cannot build from it and the critic cannot judge against it.
		throw new Error(
			'A reference needs a caption describing what the image depicts. The manager cannot read image files, so this text is the only thing that will tell the worker what to build or the critic what to compare against.',
		);
	}

	const stem = sanitizeReferenceId(options.id ?? basename(sourcePath, extname(sourcePath)));

	// Disambiguate rather than overwrite: re-adding the same id is how a user
	// swaps in a corrected image, and silently replacing the old bytes would
	// make a critic's earlier verdict unreproducible.
	let id = stem;
	let targetPath = join(referencesDir, `${id}${extension}`);
	let suffix = 2;
	while (true) {
		const existing = await readManifest(manifest.workspacePath);
		const taken = existing?.references?.some((reference) => reference.id === id) ?? false;
		if (!taken) {
			break;
		}
		id = `${stem}-${suffix}`;
		targetPath = join(referencesDir, `${id}${extension}`);
		suffix += 1;
	}

	try {
		await copyFile(sourcePath, targetPath);
	} catch (error) {
		throw describeFailure("copy reference image into the workspace", sourcePath, error);
	}

	const reference: BlenderReference = {
		id,
		path: targetPath,
		sourcePath: options.url ? undefined : sourcePath,
		caption,
		suggestedView: options.suggestedView?.trim() || undefined,
		sourceUrl: options.url,
		license: options.license?.trim() || undefined,
		credit: options.credit?.trim() || undefined,
		addedAt: nowIso(),
	};

	let references: BlenderReference[] = [];
	// Merge into the manifest on disk rather than writing back the snapshot read
	// at the top: a module run may have finished during the copy above, and its
	// claims would be clobbered.
	await updateManifest(getManifestPath(manifest.workspacePath), (current: BlenderWorkspaceManifest) => {
		current.references = [...(current.references ?? []), reference];
		references = current.references;
	});

	return {
		workspacePath: manifest.workspacePath,
		manifestPath: manifest.manifestPath,
		referencesDir,
		reference,
		references,
	};
	} finally {
		await cleanupDownloaded(downloaded);
	}
}
