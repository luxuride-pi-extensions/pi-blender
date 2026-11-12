import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { writeFile } from "node:fs/promises";

/** Sources whose licences allow commercial use without an account. */
export type ReferenceSource = "polyhaven" | "ambientcg";

export interface ReferenceCandidate {
	source: ReferenceSource;
	id: string;
	name: string;
	kind: "model" | "texture" | "hdri";
	pageUrl: string;
	previewUrl?: string;
	license: string;
	credit: string;
	tags: string[];
}

export interface ReferenceSearchOptions {
	query: string;
	source?: ReferenceSource;
	kind?: "model" | "texture" | "hdri";
	limit?: number;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

const POLYHAVEN_TYPES = { model: "models", texture: "textures", hdri: "hdris" } as const;

/**
 * Poly Haven returns one object keyed by asset id. Its search is not a query
 * endpoint: the catalogue is small enough to fetch and filter here, which also
 * keeps the result deterministic when the API changes ranking.
 */
export function parsePolyHaven(
	payload: Record<string, { name?: string; tags?: string[]; categories?: string[] }>,
	kind: "model" | "texture" | "hdri",
	query: string,
	limit: number,
): ReferenceCandidate[] {
	const needle = query.trim().toLowerCase();
	const words = needle.split(/\s+/).filter(Boolean);
	return Object.entries(payload)
		.map(([id, asset]) => {
			const name = asset.name ?? id;
			const tags = [...(asset.tags ?? []), ...(asset.categories ?? [])];
			const haystack = [id, name, ...tags].join(" ").toLowerCase();
			return { id, name, tags, haystack };
		})
		.filter((asset) => words.every((word) => asset.haystack.includes(word)))
		.slice(0, limit)
		.map((asset) => ({
			source: "polyhaven" as const,
			id: asset.id,
			name: asset.name,
			kind,
			pageUrl: `https://polyhaven.com/a/${asset.id}`,
			previewUrl: `https://cdn.polyhaven.com/asset_img/thumbs/${asset.id}.png?width=256`,
			license: "CC0-1.0",
			credit: `Poly Haven — ${asset.name}`,
			tags: asset.tags,
		}));
}

/** ambientCG returns `{foundAssets: [...]}` and CC0 metadata per asset. */
export function parseAmbientCg(payload: unknown, query: string, limit: number): ReferenceCandidate[] {
	const found = (payload as { foundAssets?: Array<Record<string, unknown>> })?.foundAssets;
	if (!Array.isArray(found)) return [];
	return found
		.filter((asset) => typeof asset.assetId === "string")
		.slice(0, limit)
		.map((asset) => ({
			source: "ambientcg" as const,
			id: String(asset.assetId),
			name: String(asset.displayName ?? asset.assetId),
			kind: "texture" as const,
			pageUrl: `https://ambientcg.com/view?id=${encodeURIComponent(String(asset.assetId))}`,
			license: "CC0-1.0",
			credit: `ambientCG — ${String(asset.displayName ?? asset.assetId)}`,
			tags: Array.isArray(asset.tags) ? asset.tags.map(String) : query.split(/\s+/),
		}));
}

/**
 * Search CC0 catalogues. Network access is deliberate and bounded: a caller
 * gets metadata and a preview URL, not bytes, so a bad query cannot fill the
 * workspace with downloads.
 */
export async function searchReferenceSources(options: ReferenceSearchOptions): Promise<ReferenceCandidate[]> {
	const source = options.source ?? "polyhaven";
	const kind = options.kind ?? "model";
	const limit = Math.min(Math.max(options.limit ?? 8, 1), 24);
	const request = options.fetchImpl ?? fetch;
	if (source === "ambientcg") {
		const query = new URLSearchParams({
			type: "Material",
			q: options.query,
			limit: String(limit),
			include: "displayData",
		});
		const response = await request(`https://ambientcg.com/api/v2/full_json?${query}`, { signal: options.signal });
		if (!response.ok) throw new Error(`ambientCG search failed: HTTP ${response.status}`);
		return parseAmbientCg(await response.json(), options.query, limit).slice(0, limit);
	}
	const response = await request(`https://api.polyhaven.com/assets?t=${POLYHAVEN_TYPES[kind]}`, {
		signal: options.signal,
		headers: { "User-Agent": "pi-blender/reference-search" },
	});
	if (!response.ok) throw new Error(`Poly Haven search failed: HTTP ${response.status}`);
	return parsePolyHaven(
		(await response.json()) as Record<string, { name?: string; tags?: string[]; categories?: string[] }>,
		kind,
		options.query,
		limit,
	);
}

const DOWNLOAD_HOSTS = new Set(["cdn.polyhaven.com", "dl.polyhaven.org"]);
const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/bmp": ".bmp",
};

/**
 * Download one image into `directory` and return its path.
 *
 * Only hosts that serve CC0 previews are accepted, the size is checked before
 * reading and while streaming, and the extension is chosen from the content
 * type rather than a caller-supplied path. Downloading is a separate step from
 * search so a licence decision stays visible.
 */
export async function downloadReferenceImage(
	url: string,
	directory: string,
	options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<string> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Reference URL is not a URL: ${url}`);
	}
	if (parsed.protocol !== "https:") throw new Error("Reference downloads must use HTTPS.");
	if (!DOWNLOAD_HOSTS.has(parsed.hostname)) {
		throw new Error(
			`Reference downloads are limited to CC0 hosts (${[...DOWNLOAD_HOSTS].join(", ")}); ${parsed.hostname} is not one.`,
		);
	}
	const request = options.fetchImpl ?? fetch;
	const response = await request(parsed, { signal: options.signal });
	if (!response.ok) throw new Error(`Reference download failed: HTTP ${response.status}`);
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (declared > MAX_BYTES) {
		throw new Error(`Reference image is ${declared} bytes; the limit is ${MAX_BYTES}.`);
	}
	const extension = IMAGE_TYPES[response.headers.get("content-type")?.split(";")[0] ?? ""] ?? extname(parsed.pathname);
	if (!Object.values(IMAGE_TYPES).includes(extension)) {
		throw new Error(`Reference download is not a supported image (content-type ${response.headers.get("content-type")}).`);
	}
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.byteLength > MAX_BYTES) {
		throw new Error(`Reference image is ${buffer.byteLength} bytes; the limit is ${MAX_BYTES}.`);
	}
	const path = `${directory}/download-${randomUUID()}${extension}`;
	await writeFile(path, buffer);
	return path;
}
