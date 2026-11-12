import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const { parsePolyHaven, parseAmbientCg, searchReferenceSources, downloadReferenceImage } = await loadTs(
	"../blender/reference-sources.ts",
);

test("polyhaven candidates carry a licence, credit and preview URL", () => {
	const candidates = parsePolyHaven(
		{
			"wooden-crate": { name: "Wooden Crate", tags: ["crate", "wood"] },
			"metal-panel": { name: "Metal Panel", tags: ["metal"] },
		},
		"model",
		"wood crate",
		5,
	);
	assert.equal(candidates.length, 1);
	assert.equal(candidates[0].id, "wooden-crate");
	assert.equal(candidates[0].license, "CC0-1.0");
	assert.match(candidates[0].credit, /Poly Haven/);
	assert.match(candidates[0].previewUrl, /^https:\/\/cdn\.polyhaven\.com\//);
});

test("ambiguous queries intersect words instead of matching any", () => {
	const candidates = parsePolyHaven(
		{ a: { name: "Wooden Crate", tags: ["wood", "crate"] }, b: { name: "Wooden Chair", tags: ["wood"] } },
		"model",
		"wood crate",
		10,
	);
	assert.deepEqual(candidates.map((candidate) => candidate.id), ["a"]);
});

test("ambientCG parsing tolerates a missing list and maps CC0 metadata", () => {
	assert.deepEqual(parseAmbientCg({}, "brick", 5), []);
	const candidates = parseAmbientCg(
		{ foundAssets: [{ assetId: "Bricks001", displayName: "Bricks 001", tags: ["brick"], previewImage: { 512: "https://ambientcg.com/preview/Bricks001.png" } }] },
		"brick",
		5,
	);
	assert.equal(candidates[0].source, "ambientcg");
	assert.equal(candidates[0].license, "CC0-1.0");
	assert.match(candidates[0].pageUrl, /view\?id=Bricks001/);
});

test("search passes the catalogue kind and limit, and rejects a bad response", async () => {
	let requested = "";
	const fetchImpl = async (url) => {
		requested = String(url);
		return new Response(JSON.stringify({ "wooden-crate": { name: "Wooden Crate" } }), { status: 200 });
	};
	const candidates = await searchReferenceSources({ query: "crate", kind: "texture", limit: 99, fetchImpl });
	assert.match(requested, /api\.polyhaven\.com\/assets\?t=textures/);
	assert.equal(candidates.length, 1);
	await assert.rejects(
		searchReferenceSources({ query: "x", fetchImpl: async () => new Response("no", { status: 500 }) }),
		/HTTP 500/,
	);
});

test("downloads are limited to CC0 hosts and https", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-reference-"));
	try {
		await assert.rejects(downloadReferenceImage("http://cdn.polyhaven.com/x.png", dir), /HTTPS/);
		await assert.rejects(downloadReferenceImage("https://example.com/x.png", dir), /CC0 hosts/);
		const fetchImpl = async () =>
			new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
				status: 200,
				headers: { "content-type": "image/png", "content-length": "4" },
			});
		const path = await downloadReferenceImage("https://cdn.polyhaven.com/asset_img/thumbs/x.png", dir, {
			fetchImpl,
		});
		assert.match(path, /download-[0-9a-f-]+\.png$/);
		assert.deepEqual([...await readFile(path)], [0x89, 0x50, 0x4e, 0x47]);
		const huge = async () =>
			new Response(Buffer.alloc(4), { status: 200, headers: { "content-type": "image/png", "content-length": "999999999" } });
		await assert.rejects(downloadReferenceImage("https://cdn.polyhaven.com/x.png", dir, { fetchImpl: huge }), /limit/);
		const redirected = async () =>
			new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } });
		await assert.rejects(downloadReferenceImage("https://cdn.polyhaven.com/x.png", dir, { fetchImpl: redirected }), /redirects are not followed/);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
