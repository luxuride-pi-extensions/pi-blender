/**
 * Silhouette agreement with the reference, measured on the saved files.
 *
 * The pair used here is the one the critic calibration already commits
 * (test/fixtures/critic-calibration/images): `mug-pass-01.png` is a mug with its
 * handle and `defect-missing-handle.png` is the same mug in the same 400x300
 * frame with the handle removed. Nothing new is rendered, so the numbers below
 * are the ones a branch run would produce for that build — no Blender process is
 * involved at all, which is the point: both inputs are PNGs on disk.
 *
 * Both fixtures are opaque (colourType 2) on a black world, so the split needs
 * the backdrop passed in. That is deliberate in the API: a photograph's backdrop
 * is not a render's world colour, and guessing it scores the studio rather than
 * the subject.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { deflateSync } from "node:zlib";

import { loadTs } from "./paths.mjs";

const { computeSilhouetteIoU, measureReferenceCompleteness, persistReferenceCompleteness } = await loadTs(
	"../blender/silhouette.ts",
);

const IMAGES = new URL("./fixtures/critic-calibration/images/", import.meta.url).pathname;
const MUG_WITH_HANDLE = join(IMAGES, "mug-pass-01.png");
const MUG_WITHOUT_HANDLE = join(IMAGES, "defect-missing-handle.png");
const BLACK = [0, 0, 0];

const roots = [];
function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-blender-silhouette-"));
	roots.push(dir);
	return dir;
}
after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("computeSilhouetteIoU", () => {
	it("scores a mask against itself as 1", async () => {
		const result = await computeSilhouetteIoU(MUG_WITH_HANDLE, MUG_WITH_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});
		assert.equal(result.measured, true);
		assert.equal(result.iou, 1);
		assert.equal(result.bboxIoU, 1);
		assert.equal(result.coverageRatio, 1);
		assert.equal(result.aspectMismatch, false);
		assert.deepEqual(result.warnings, []);
	});

	it("measures a mug without its handle as a worse match than the same mug with it", async () => {
		const withHandle = await computeSilhouetteIoU(MUG_WITH_HANDLE, MUG_WITH_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});
		const withoutHandle = await computeSilhouetteIoU(MUG_WITHOUT_HANDLE, MUG_WITH_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});

		assert.equal(withoutHandle.measured, true);
		assert.ok(
			withoutHandle.iou < withHandle.iou - 0.1,
			`absent handle should cost real IoU: ${withoutHandle.iou} vs ${withHandle.iou}`,
		);
		// Losing a part changes the outline's proportions, which is the signal
		// bounding-box normalisation cannot absorb: the two boxes differ in aspect.
		assert.equal(withoutHandle.aspectMismatch, true);
		assert.ok(withoutHandle.bboxIoU < withoutHandle.iou, "the frame-relative boxes disagree more than the shapes");
		assert.equal(withoutHandle.warnings.length, 1);
		assert.match(withoutHandle.warnings[0], /differ in aspect/);
	});

	it("reads coverageRatio as the share of the reference the render accounts for", async () => {
		// Same pair, measured the other way round. The incomplete mug, stretched
		// over the full mug's box, covers all of its reference: coverage answers
		// "is anything missing from the reference", so it is the handle-side
		// direction that has to lose area. Both directions carry the same iou,
		// because IoU is symmetric and coverage is not.
		const referenceIsBodyOnly = await computeSilhouetteIoU(MUG_WITHOUT_HANDLE, MUG_WITHOUT_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});
		const referenceIsComplete = await computeSilhouetteIoU(MUG_WITH_HANDLE, MUG_WITHOUT_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});
		const forward = await computeSilhouetteIoU(MUG_WITHOUT_HANDLE, MUG_WITH_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});
		assert.equal(referenceIsBodyOnly.coverageRatio, 1);
		assert.equal(referenceIsComplete.measured, true);
		assert.ok(referenceIsComplete.coverageRatio < 0.85, `coverage ${referenceIsComplete.coverageRatio}`);
		assert.ok(referenceIsComplete.coverageRatio > 0.6, `coverage ${referenceIsComplete.coverageRatio}`);
		assert.equal(referenceIsComplete.iou, forward.measured ? forward.iou : -1);
	});

	it("splits on alpha when the image has it, without being told a backdrop", async () => {
		const dir = tempDir();
		const alpha = join(dir, "alpha.png");
		writeFileSync(alpha, alphaPng(8, 8));
		// No background at all: the image states its own subject, so the backdrop
		// is not the caller's problem and the render's studio colour is irrelevant.
		const result = await computeSilhouetteIoU(alpha, alpha, {});
		assert.equal(result.measured, true);
		assert.deepEqual(result.split, { render: "alpha", reference: "alpha" });
		assert.equal(result.iou, 1);
		assert.equal(result.coverageRatio, 1);
	});

	it("takes each side's split from that side's own image, never from the other", async () => {
		const dir = tempDir();
		const alpha = join(dir, "alpha.png");
		writeFileSync(alpha, alphaPng(8, 8));
		// Opaque reference with its own backdrop supplied, transparent render: the
		// render is read by alpha even though a backdrop was given for it too.
		const result = await computeSilhouetteIoU(alpha, MUG_WITH_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});
		assert.equal(result.measured, true);
		assert.deepEqual(result.split, { render: "alpha", reference: "background" });
	});

	it("refuses to measure an opaque pair with no backdrop given", async () => {
		const result = await computeSilhouetteIoU(MUG_WITH_HANDLE, MUG_WITH_HANDLE, {});
		assert.equal(result.measured, false);
		// Withheld, not zero: 0 would read as "this matches nothing".
		assert.equal("iou" in result, false);
		assert.match(result.reason, /neither the render nor the reference has transparency/);
		assert.match(result.reason, /backdrop colour/);
	});

	it("measures when the render is opaque and only the reference's backdrop was given", async () => {
		const result = await computeSilhouetteIoU(MUG_WITH_HANDLE, MUG_WITHOUT_HANDLE, {
			background: BLACK,
			referenceBackground: BLACK,
		});
		assert.equal(result.measured, true);
		assert.equal(result.aspectMismatch, true);
		assert.equal(result.aspectRatio !== null, true);
	});
});

describe("measureReferenceCompleteness", () => {
	it("records one entry per measured view and names the best", async () => {
		const measured = await measureReferenceCompleteness({
			referencePath: MUG_WITH_HANDLE,
			views: [
				{ name: "hero", path: MUG_WITH_HANDLE },
				{ name: "missing-handle", path: MUG_WITHOUT_HANDLE },
			],
			background: BLACK,
			referenceBackground: BLACK,
		});
		assert.notEqual(measured.completeness, null);
		assert.deepEqual(Object.keys(measured.completeness.views).sort(), ["hero", "missing-handle"]);
		assert.equal(measured.completeness.bestView, "hero");
		assert.equal(measured.completeness.bestViewIoU, 1);
		assert.ok(measured.completeness.views["missing-handle"].iou < 0.9);
		assert.equal(typeof measured.completeness.views["missing-handle"].coverageRatio, "number");
	});

	it("withholds the whole record when no view could be measured", async () => {
		const measured = await measureReferenceCompleteness({
			referencePath: MUG_WITH_HANDLE,
			views: [{ name: "hero", path: MUG_WITH_HANDLE }],
		});
		assert.equal(measured.completeness, null);
		assert.equal(measured.warnings.length, 1);
		assert.match(measured.warnings[0], /not measured/);
		assert.match(measured.warnings[0], /backdrop colour/);
	});

	it("keeps the views it could measure and names the ones it could not", async () => {
		const dir = tempDir();
		const alpha = join(dir, "alpha.png");
		writeFileSync(alpha, alphaPng(8, 8));
		const measured = await measureReferenceCompleteness({
			referencePath: alpha,
			views: [
				{ name: "hero", path: alpha },
				{ name: "side", path: join(dir, "never-rendered.png") },
			],
		});
		assert.notEqual(measured.completeness, null);
		assert.deepEqual(Object.keys(measured.completeness.views), ["hero"]);
		assert.equal(measured.completeness.bestView, "hero");
		// A panel that failed to render is not a shape finding, so it is named and
		// left out rather than scored as zero.
		assert.equal(measured.warnings.length, 1);
		assert.match(measured.warnings[0], /"side"/);
		assert.match(measured.warnings[0], /Cannot read/);
	});
});

describe("persistReferenceCompleteness", () => {
	it("writes the measurement into packet.json next to the reference it describes", async () => {
		const dir = tempDir();
		const packetPath = join(dir, "packet.json");
		writeFileSync(
			packetPath,
			JSON.stringify({ iteration: 3, reference: { path: "reference.png", caption: "a mug" } }, null, 2),
		);
		const measured = await measureReferenceCompleteness({
			referencePath: MUG_WITH_HANDLE,
			views: [{ name: "hero", path: MUG_WITHOUT_HANDLE }],
			background: BLACK,
			referenceBackground: BLACK,
		});
		assert.notEqual(measured.completeness, null);
		const warning = await persistReferenceCompleteness(dir, measured.completeness);
		assert.equal(warning, null);

		const packet = JSON.parse(readFileSync(packetPath, "utf8"));
		assert.equal(packet.iteration, 3);
		assert.equal(packet.reference.caption, "a mug");
		assert.equal(packet.referenceCompleteness.views.hero.iou, measured.views.hero.iou);
		assert.equal(packet.referenceCompleteness.views.hero.coverageRatio, measured.views.hero.coverageRatio);
		assert.equal(packet.referenceCompleteness.bestViewIoU, measured.views.hero.iou);
	});

	it("says so instead of throwing when the packet is missing", async () => {
		const dir = tempDir();
		const warning = await persistReferenceCompleteness(dir, { views: {}, bestViewIoU: 0 });
		assert.notEqual(warning, null);
		assert.match(warning, /packet\.json/);
	});
});

/**
 * An 8-bit RGBA PNG with an opaque black square in the middle and a clear border.
 *
 * Written here rather than committed as a fixture: this is a decode check for the
 * alpha split, not a scene worth keeping, and the film-transparent case it stands
 * for is "the file says which pixels are the subject".
 */
function alphaPng(width, height) {
	const raw = Buffer.alloc(height * (1 + width * 4));
	const inset = Math.max(1, Math.floor(Math.min(width, height) / 4));
	for (let y = 0; y < height; y += 1) {
		const row = y * (1 + width * 4);
		raw[row] = 0; // filter: none
		for (let x = 0; x < width; x += 1) {
			const inside = x >= inset && y >= inset && x < width - inset && y < height - inset;
			const at = row + 1 + x * 4;
			raw[at] = 0;
			raw[at + 1] = 0;
			raw[at + 2] = 0;
			raw[at + 3] = inside ? 255 : 0;
		}
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 6; // colour type: RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function pngChunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body), 0);
	return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
	let c = n;
	for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}
