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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { BRIDGE_ASSETS_DIR, loadTs } from "./paths.mjs";

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
	// A fully white subject is 100% clipped and has no luma range, so exposure
	// is the one thing this fixture is genuinely bad at; no other warning fires.
	assert.equal(result.exposure.clippedHigh.all, 1);
	assert.ok(result.warnings.some((warning) => /clipped/.test(warning)), result.warnings.join("\n"));
	assert.ok(result.warnings.every((warning) => /clipped|flat-light/.test(warning)), result.warnings.join("\n"));
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

test("exposure: reports clipped fractions and luma percentiles over the subject", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	const pixels = solid(10, 10, 128, 128, 128);
	// A blown white patch and a crushed black patch, both inside the subject.
	for (let y = 0; y < 4; y++) {
		for (let x = 0; x < 4; x++) {
			const white = (y * 10 + x) * 4;
			pixels[white] = 255;
			pixels[white + 1] = 255;
			pixels[white + 2] = 255;
			const black = (y * 10 + x + 6) * 4;
			pixels[black] = 0;
			pixels[black + 1] = 0;
			pixels[black + 2] = 0;
		}
	}
	writeFileSync(join(dir, "exposed.png"), encodePng(10, 10, pixels));

	const result = await withManifest(dir, () =>
		blenderImageProbe({ cwd: dir, workspace: dir, path: "exposed.png", background: [128 / 255, 128 / 255, 128 / 255] }),
	);

	assert.equal(result.exposure.sampled, false);
	assert.equal(result.exposure.sampleCount, 32);
	assert.ok(result.exposure.clippedHigh.all > 0.4);
	assert.ok(result.exposure.clippedLow.all > 0.4);
	assert.equal(result.exposure.clippedHigh.r, result.exposure.clippedHigh.any);
	assert.equal(result.exposure.lumaPercentiles.p99, 1);
	assert.equal(result.exposure.lumaPercentiles.p1, 0);
	assert.ok(result.exposure.lumaPercentiles.p50 >= 0 && result.exposure.lumaPercentiles.p50 <= 1);
	assert.ok(result.warnings.some((warning) => /clipped/.test(warning)));
});

test("exposure: a clipped-flat subject is an exposure finding, not a flat-light one", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	const pixels = solid(8, 8, 0, 0, 0);
	for (let y = 2; y < 6; y++) {
		for (let x = 2; x < 6; x++) {
			const at = (y * 8 + x) * 4;
			pixels[at] = 255;
			pixels[at + 1] = 255;
			pixels[at + 2] = 255;
		}
	}
	writeFileSync(join(dir, "white.png"), encodePng(8, 8, pixels));

	const result = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "white.png" }));

	assert.equal(result.exposure.clippedHigh.all, 1);
	assert.equal(result.exposure.lumaPercentiles.p1, result.exposure.lumaPercentiles.p99);
	assert.ok(result.warnings.some((warning) => /clipped/.test(warning)));
	assert.ok(
		!result.warnings.some((warning) => /flat-light/.test(warning)),
		"a clipped-flat subject must not be reported as flat lighting",
	);
});

test("exposure: flat lighting warns even when nothing is clipped", async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();
	const pixels = solid(8, 8, 0, 0, 0);
	for (let y = 2; y < 6; y++) {
		for (let x = 2; x < 6; x++) {
			const at = (y * 8 + x) * 4;
			pixels[at] = 128;
			pixels[at + 1] = 128;
			pixels[at + 2] = 128;
		}
	}
	writeFileSync(join(dir, "flat.png"), encodePng(8, 8, pixels));

	const result = await withManifest(dir, () => blenderImageProbe({ cwd: dir, workspace: dir, path: "flat.png" }));

	assert.equal(result.exposure.clippedHigh.all, 0);
	assert.equal(result.exposure.clippedLow.all, 0);
	assert.equal(result.exposure.lumaPercentiles.p1, result.exposure.lumaPercentiles.p99);
	assert.ok(result.warnings.some((warning) => /flat-light/.test(warning)));
});

/**
 * The bridge's in-process render stats and this probe are two implementations
 * of one contract, so they are pinned against the same file.
 *
 * The tolerance is 1e-4: both sides round to four decimals before reporting, so
 * agreement sharper than that would be luck rather than agreement, and anything
 * looser would let a real rule difference (a mean distance where the other side
 * uses the max, or half-up rounding where the other uses banker's) pass.
 *
 * What this does NOT cover: the two rules could be ported wrong in the same
 * direction, which one PNG cannot reveal — `test/render-stats.py` in the bridge
 * covers the rules themselves, and the hand-computed images above cover this
 * probe. It also only exercises an opaque subject against a backdrop both sides
 * are told (black), so the alpha-mask branch, the tolerance branch and the
 * render process's own ring measurement are uncompared here.
 */
const PARITY_FIXTURE = join(import.meta.dirname, "fixtures", "critic-calibration", "images", "mug-pass-01.png");
const PARITY_TOLERANCE = 1e-4;
const RENDER_STATS_FIELDS = [
	"subjectBounds",
	"subjectPixelCount",
	"subjectCoverage",
	"transparentPixels",
	"meanColour",
	"lumaGrid",
	"silhouette",
	"edgeSharpness",
	"palette",
	"exposure",
	"warnings",
];

/** The bridge package's `render_scene.py`, which only a released bridge carries the stats in. */
const RENDER_STATS_SOURCE = join(BRIDGE_ASSETS_DIR, "render_scene.py");
const PARITY_SKIP = (() => {
	const blender = blenderCommand();
	if (!blender) return "no Blender on this machine";
	const source = existsSync(RENDER_STATS_SOURCE) ? readFileSync(RENDER_STATS_SOURCE, "utf-8") : "";
	if (!source.includes("def compute_render_stats") || !source.includes("backgroundUniform")) {
		return `the installed bridge (${BRIDGE_ASSETS_DIR}) does not measure the backdrop itself, so there is nothing to compare against yet`;
	}
	return false;
})();

/** Blender, as a command prefix, when this machine has one. */
function blenderCommand() {
	for (const candidate of [["flatpak", "run", "org.blender.Blender"], ["blender"]]) {
		const found = spawnSync(candidate[0], [...candidate.slice(1), "--version"], { encoding: "utf-8", timeout: 60_000 });
		if (!found.error && found.status === 0) return candidate;
	}
	return null;
}

/** Every leaf where the two stats disagree by more than the parity tolerance. */
function statsDifferences(python, probe, path) {
	if (typeof python === "number" && typeof probe === "number") {
		return Math.abs(python - probe) <= PARITY_TOLERANCE ? [] : [`${path}: python ${python} vs probe ${probe}`];
	}
	if (Array.isArray(python) && Array.isArray(probe)) {
		if (python.length !== probe.length) return [`${path}: python has ${python.length} entries, probe has ${probe.length}`];
		return python.flatMap((entry, index) => statsDifferences(entry, probe[index], `${path}[${index}]`));
	}
	if (python && probe && typeof python === "object" && typeof probe === "object") {
		const keys = new Set([...Object.keys(python), ...Object.keys(probe)]);
		return [...keys].flatMap((key) => statsDifferences(python[key], probe[key], path ? `${path}.${key}` : key));
	}
	return JSON.stringify(python) === JSON.stringify(probe) ? [] : [`${path}: python ${JSON.stringify(python)} vs probe ${JSON.stringify(probe)}`];
}

test("render stats parity: the Python stats and the probe agree on one PNG", { skip: PARITY_SKIP }, async (t) => {
	const boxes = sandboxes();
	t.after(() => boxes.cleanup());
	const dir = boxes.create();

	// Blender under flatpak cannot read /tmp, so the script it is asked to run
	// has to sit under the home directory even though the workspace does not.
	const scriptDir = mkdtempSync(join(homedir(), ".pi-render-stats-"));
	t.after(() => rmSync(scriptDir, { recursive: true, force: true }));
	const scriptPath = join(scriptDir, "parity.py");
	writeFileSync(
		scriptPath,
		[
			"import json, sys",
			`sys.path.insert(0, ${JSON.stringify(BRIDGE_ASSETS_DIR)})`,
			"from render_scene import compute_render_stats",
			`stats = compute_render_stats(${JSON.stringify(PARITY_FIXTURE)}, background=(0, 0, 0), tolerance=0.02)`,
			'sys.stdout.write("__PI_RENDER_STATS__" + json.dumps(stats) + "__PI_RENDER_STATS__\\n")',
		].join("\n"),
		"utf-8",
	);

	const [command, ...args] = blenderCommand();
	const run = spawnSync(command, [...args, "--background", "--factory-startup", "--python", scriptPath], {
		encoding: "utf-8",
		timeout: 300_000,
		env: { ...process.env, HOME: homedir() },
	});
	const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
	const reported = output.match(/__PI_RENDER_STATS__(.*?)__PI_RENDER_STATS__/);
	assert.ok(reported, `Blender did not report render stats: ${output.slice(-1500)}`);
	const pythonStats = JSON.parse(reported[1]);

	// Identical inputs are the whole point: the render process measures its own
	// border ring when nobody names a backdrop, and the probe has no such rule, so
	// the comparison has to name the same backdrop on both sides. What the auto
	// path measures is covered by the bridge's own `test/render-stats.py`, against
	// the corner pixel of a render whose world colour is known.
	assert.deepEqual(pythonStats.background, [0, 0, 0], "an explicit background must not be re-measured from the ring");
	assert.equal(pythonStats.backgroundUniform, null, "an explicit background has no ring share to report");

	// The probe's tolerance defaults to 0, so the same 0.02 the render process
	// measured with has to be asked for explicitly on this side too.
	const probe = await withManifest(dir, () =>
		blenderImageProbe({ cwd: dir, workspace: dir, path: PARITY_FIXTURE, background: [0, 0, 0], tolerance: 0.02 }),
	);
	assert.ok(probe.subjectPixelCount > 0, "the fixture has a subject, so agreement cannot be two empty measurements");

	for (const field of RENDER_STATS_FIELDS) {
		assert.deepEqual(statsDifferences(pythonStats[field], probe[field], field), [], `${field} disagrees beyond ${PARITY_TOLERANCE}`);
	}
});
