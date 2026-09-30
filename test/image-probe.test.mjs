/**
 * Numeric image measurement, and the PNG decoder underneath it.
 *
 * The decoder is exercised against PNGs written by something other than this
 * code — Blender's renders, and images built here with zlib — because a decoder
 * that agrees with itself is exactly the failure mode a hand-rolled one has.
 * The probe is exercised against images with known geometry, where the expected
 * numbers can be computed by hand rather than read back off the same code that
 * produced them.
 */

import { deflateSync } from "node:zlib";
import { crc32 } from "node:zlib";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTs } from "./paths.mjs";

// The extension is TypeScript with NodeNext ".js" specifiers, so the modules
// are loaded through jiti — the same loader pi uses. A direct `.ts` import
// resolves for png.ts (it has no relative specifier) but fails on image-probe.ts
// (it imports ./png.js), so both go through jiti and one instance.
const { decodePng, looksLikePng } = await loadTs("../blender/png.ts");
const { blenderImageProbe } = await loadTs("../blender/image-probe.ts");
const { loadWorkspaceManifest } = await loadTs("../blender/workspace.ts");

/** Minimal RGBA PNG encoder, so the tests are not testing the decoder against itself. */
function encodePng(width, height, pixels) {
	const raw = Buffer.alloc(height * (width * 4 + 1));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (width * 4 + 1);
		raw[rowStart] = 0;
		pixels.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
	}
	const chunk = (type, body) => {
		const out = Buffer.alloc(body.length + 12);
		out.writeUInt32BE(body.length, 0);
		out.write(type, 4, "ascii");
		body.copy(out, 8);
		out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
		return out;
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

function solid(width, height, r, g, b, a = 255) {
	const pixels = Buffer.alloc(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		pixels[i * 4] = r;
		pixels[i * 4 + 1] = g;
		pixels[i * 4 + 2] = b;
		pixels[i * 4 + 3] = a;
	}
	return pixels;
}

function sandboxes() {
	const created = [];
	return {
		create() {
			const dir = mkdtempSync(join(tmpdir(), "image-probe-"));
			created.push(dir);
			return dir;
		},
		cleanup() {
			for (const dir of created) rmSync(dir, { recursive: true, force: true });
		},
	};
}

/** A workspace manifest is all blenderImageProbe needs from a workspace. */
async function withManifest(dir, fn) {
	await writeFileSync(
		join(dir, "blender-workspace.json"),
		JSON.stringify({
			version: 2,
			workspacePath: dir,
			blendPath: join(dir, "model.blend"),
			manifestPath: join(dir, "blender-workspace.json"),
			latestIteration: 1,
		}),
		"utf-8",
	);
	return fn(await loadWorkspaceManifest(dir, dir));
}

test("png: decodes an 8-bit RGBA image it did not encode itself", () => {
	// A 2x1 image written by hand as a filter-0 stream, which is what any
	// encoder emits for a small image and exercises the unfilter pass directly.
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(2, 0);
	ihdr.writeUInt32BE(1, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	// Pure red, then pure green at 50% alpha, as one filter-0 row.
	const idat = deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 128]));
	const chunk = (type, body) => {
		const out = Buffer.alloc(body.length + 12);
		out.writeUInt32BE(body.length, 0);
		out.write(type, 4, "ascii");
		body.copy(out, 8);
		out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
		return out;
	};
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
	const image = decodePng(png);
	assert.equal(image.width, 2);
	assert.equal(image.height, 1);
	assert.deepEqual([...image.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
});

test("png: a sub filter recovers a gradient that a naive read would not", () => {
	const width = 4;
	const height = 2;
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	// Sub is a per-BYTE filter, so each byte is its predecessor's value plus
	// the filter's residual. Encoding a known absolute row therefore means
	// differencing it: absolute 10,20,30,40 | 50,60,70,80 | ... becomes raw
	// 10,10,10,10 | 20,20,20,20 | 40,40,40,40 | 80,80,80,80.
	const subEncode = (absolute) => absolute.map((value, index) => (index < 4 ? value : value - absolute[index - 4]));
	const row0 = Buffer.from([1, ...subEncode([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160])]);
	const row1 = Buffer.from([1, ...subEncode([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80])]);
	const idat = deflateSync(Buffer.concat([row0, row1]));
	const chunk = (type, body) => {
		const out = Buffer.alloc(body.length + 12);
		out.writeUInt32BE(body.length, 0);
		out.write(type, 4, "ascii");
		body.copy(out, 8);
		out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
		return out;
	};
	const png = Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", idat),
		chunk("IEND", Buffer.alloc(0)),
	]);
	// 4 bytes per pixel: the first pixel of the second row is index 16.
	const image = decodePng(png);
	assert.deepEqual(
		[...image.pixels],
		[10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80],
	);
});

test("png: refuses a non-PNG and an interlaced one by name", () => {
	assert.equal(looksLikePng(Buffer.from("not a png at all, really")), false);
	assert.throws(() => decodePng(Buffer.from("not a png at all, really")), /Not a PNG file/);
});

test("png: refuses a truncated file rather than reporting partial pixels", () => {
	const png = encodePng(2, 2, solid(2, 2, 10, 20, 30));
	assert.throws(() => decodePng(png.subarray(0, png.length - 20)), /IEND|ends first|claims/);
});

test("image probe: finds a rectangle exactly", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	// 100x100 black, with a white 20x10 block at x 30..49, y 40..49.
	const pixels = solid(100, 100, 0, 0, 0);
	for (let y = 40; y < 50; y++) {
		for (let x = 30; x < 50; x++) {
			pixels[(y * 100 + x) * 4] = 255;
			pixels[(y * 100 + x) * 4 + 1] = 255;
			pixels[(y * 100 + x) * 4 + 2] = 255;
		}
	}
	writeFileSync(join(dir, "render.png"), encodePng(100, 100, pixels));

	const result = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "render.png" }));

	assert.equal(result.width, 100);
	assert.equal(result.height, 100);
	assert.deepEqual(result.subjectBounds, { x0: 30, x1: 49, y0: 40, y1: 49 });
	assert.equal(result.subjectPixelCount, 20 * 10);
	assert.equal(result.subjectCoverage, 0.02);
	assert.deepEqual(result.meanColour, [255, 255, 255]);
	assert.equal(result.silhouette.rowsOccupied, 10);
	assert.equal(result.silhouette.widestRow, 20);
	assert.deepEqual(result.silhouette.coverageByRow, [{ from: 40, to: 49, maxWidth: 20 }]);
	// A hard black/white edge: 20 crossing pixels, all at full contrast.
	assert.equal(result.edgeSharpness, 1);
	// Two occupied cells in the 8x8 grid, both fully white.
	const occupied = result.lumaGrid.flat().filter((cell) => cell !== null);
	assert.equal(occupied.length, 2);
	for (const cell of occupied) assert.ok(cell > 0.99, `expected a white cell, got ${cell}`);
	// The palette is quantised to 4 bits per channel.
	assert.equal(result.palette[0].hex, "#ffffff");
	assert.ok(result.meanColour.every((channel) => channel > 250), `expected near-white mean, got ${result.meanColour}`);
	assert.deepEqual(result.warnings, []);
});

test("image probe: an empty frame is a warning, not a division by zero", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	writeFileSync(join(dir, "black.png"), encodePng(10, 10, solid(10, 10, 0, 0, 0)));
	const result = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "black.png" }));
	assert.equal(result.subjectPixelCount, 0);
	assert.equal(result.subjectBounds, null);
	assert.equal(result.subjectCoverage, 0);
	assert.equal(result.edgeSharpness, null);
	assert.equal(result.meanColour[0], 0);
	assert.ok(result.warnings.some((w) => /background/.test(w)));
});

test("image probe: a wrong background colour reads the background as subject", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	writeFileSync(join(dir, "white.png"), encodePng(10, 10, solid(10, 10, 255, 255, 255)));
	// White image, black background assumed: every pixel is "subject".
	const wrong = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "white.png" }));
	assert.equal(wrong.subjectPixelCount, 100);
	// White image, white background: nothing is subject.
	const right = await withManifest(dir, () =>
		blenderImageProbe({ cwd: dir, workspace: dir, path: "white.png", background: [1, 1, 1] }),
	);
	assert.equal(right.subjectPixelCount, 0);
	assert.equal(right.subjectBounds, null);
});

test("image probe: tolerance absorbs a near-background gradient", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	// A 20x20 image at value 5/255: essentially background, but not exactly.
	writeFileSync(join(dir, "near.png"), encodePng(20, 20, solid(20, 20, 5, 5, 5)));
	const strict = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "near.png" }));
	assert.equal(strict.subjectPixelCount, 400);
	const loose = await withManifest(dir, () =>
		blenderImageProbe({ cwd: dir, workspace: dir, path: "near.png", tolerance: 0.05 }),
	);
	assert.equal(loose.subjectPixelCount, 0);
	assert.equal(loose.tolerance, 0.05);
});

test("image probe: a transparent render is masked by alpha, not by colour", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	// Half transparent, half opaque white, on a black background: only the
	// opaque half is subject, and the transparent count is reported.
	const pixels = Buffer.alloc(20 * 10 * 4);
	for (let y = 0; y < 10; y++) {
		for (let x = 0; x < 20; x++) {
			const base = (y * 20 + x) * 4;
			pixels[base] = 255;
			pixels[base + 1] = 255;
			pixels[base + 2] = 255;
			pixels[base + 3] = x < 10 ? 0 : 255;
		}
	}
	writeFileSync(join(dir, "film.png"), encodePng(20, 10, pixels));
	const result = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "film.png" }));
	assert.equal(result.transparentPixels, 100);
	assert.equal(result.subjectPixelCount, 100);
	assert.equal(result.alphaPresent, true);
	assert.equal(result.subjectBounds.x0, 10);
	assert.ok(result.warnings.some((w) => /alpha/.test(w)));
});

test("image probe: two silhouettes are two row runs, not one", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	// A wide band at the top and a narrower one at the bottom, with a gap.
	const pixels = solid(40, 40, 0, 0, 0);
	for (let y = 5; y < 10; y++) for (let x = 0; x < 40; x++) pixels[(y * 40 + x) * 4] = pixels[(y * 40 + x) * 4 + 1] = pixels[(y * 40 + x) * 4 + 2] = 255;
	for (let y = 30; y < 35; y++) for (let x = 10; x < 20; x++) pixels[(y * 40 + x) * 4] = pixels[(y * 40 + x) * 4 + 1] = pixels[(y * 40 + x) * 4 + 2] = 255;
	writeFileSync(join(dir, "two.png"), encodePng(40, 40, pixels));
	const result = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "two.png" }));
	assert.equal(result.silhouette.coverageByRow.length, 2);
	assert.deepEqual(result.silhouette.coverageByRow[0], { from: 5, to: 9, maxWidth: 40 });
	assert.deepEqual(result.silhouette.coverageByRow[1], { from: 30, to: 34, maxWidth: 10 });
	assert.equal(result.silhouette.rowsOccupied, 10);
	assert.equal(result.silhouette.widestRow, 40);
});

test("image probe: a soft edge measures softer than a hard one", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	const hard = solid(40, 10, 0, 0, 0);
	for (let x = 20; x < 40; x++) for (let y = 0; y < 10; y++) hard[(y * 40 + x) * 4] = hard[(y * 40 + x) * 4 + 1] = hard[(y * 40 + x) * 4 + 2] = 255;
	writeFileSync(join(dir, "hard.png"), encodePng(40, 10, hard));
	// A 10px ramp from 0 to 255: no single step jumps as far.
	const soft = solid(40, 10, 0, 0, 0);
	for (let x = 10; x < 40; x++) for (let y = 0; y < 10; y++) soft[(y * 40 + x) * 4] = soft[(y * 40 + x) * 4 + 1] = soft[(y * 40 + x) * 4 + 2] = Math.round(((x - 10) / 29) * 255);
	writeFileSync(join(dir, "soft.png"), encodePng(40, 10, soft));

	const hardResult = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "hard.png" }));
	const softResult = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "soft.png" }));
	assert.ok(hardResult.edgeSharpness > softResult.edgeSharpness * 3, `hard ${hardResult.edgeSharpness} vs soft ${softResult.edgeSharpness}`);
});

test("image probe: a non-PNG path is named in the error", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	writeFileSync(join(dir, "frame.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
	await withManifest(dir, () =>
		assert.rejects(() => blenderImageProbe({ cwd: dir, workspace: dir, path: "frame.jpg" }), /frame\.jpg.*not a PNG/),
	);
	await withManifest(dir, () => assert.rejects(() => blenderImageProbe({ cwd: dir, workspace: dir, path: "missing.png" }), /Cannot read image/));
});

test("image probe: the grid is clamped rather than trusted", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	writeFileSync(join(dir, "solid.png"), encodePng(8, 8, solid(8, 8, 255, 255, 255)));
	const result = await withManifest(dir, () =>
		blenderImageProbe({ cwd: dir, workspace: dir, path: "solid.png", background: [0, 0, 0], grid: [1000, 0] }),
	);
	assert.deepEqual(result.grid, { nx: 32, ny: 1 });
	assert.equal(result.lumaGrid.length, 1);
});

test("image probe: writes its numbers next to the iteration artifacts", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	writeFileSync(join(dir, "solid.png"), encodePng(8, 8, solid(8, 8, 255, 255, 255)));
	await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "solid.png" }));
	const iterationDir = join(dir, "iteration_01");
	assert.ok(existsSync(join(iterationDir, "image-probe.json")), "expected image-probe.json in the iteration dir");
	const saved = JSON.parse(readFileSync(join(iterationDir, "image-probe.json"), "utf-8"));
	assert.equal(saved.subjectPixelCount, 64);
});
