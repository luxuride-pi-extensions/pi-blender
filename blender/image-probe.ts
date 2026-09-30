import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { decodePng, looksLikePng, type DecodedImage } from "./png.js";
import type { ImageProbeOptions, ImageProbeResult } from "./types.js";
import { getIterationPaths, loadWorkspaceManifest } from "./workspace.js";

/**
 * Numeric measurement of a rendered image, so a visual verdict can be checked
 * rather than asserted.
 *
 * Everything here is arithmetic over decoded pixels: where the subject is, how
 * much of the frame it covers, what colour it is, how brightness is
 * distributed, and whether the silhouette edge is a boundary or a gradient. No
 * model, no render, no live bridge — the pixels are the whole input, which is
 * what lets a read-only role use it.
 *
 * The background colour is a parameter rather than something inferred, because
 * "the background" is a property of the shot (a white cyclorama, a dark world,
 * a film-transparent alpha) and inferring it from a corner pixel makes a light
 * background read as subject.
 */

const DEFAULT_GRID_SIDE = 8;
const MAX_GRID_SIDE = 32;
const ALPHA_CUTOFF = 8;

/** Perceived-luminance weights, so a luma grid matches what a critic sees. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

const DEFAULT_PALETTE_LIMIT = 6;
const MAX_PALETTE_LIMIT = 16;
const PALETTE_SQUARE_TOLERANCE = 0.06;

interface SubjectMask {
	mask: Uint8Array;
	pixels: number;
	transparentPixels: number;
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
	sumR: number;
	sumG: number;
	sumB: number;
}

export async function blenderImageProbe(options: ImageProbeOptions): Promise<ImageProbeResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const path = resolveImagePath(options.path, manifest.workspacePath);
	const { image, byteLength } = await readImage(path);

	const background = options.background ?? [0, 0, 0];
	const grid = normalizeGrid(options.grid);
	const paletteLimit = normalizePaletteLimit(options.paletteLimit);
	const tolerance = normalizeTolerance(options.tolerance);
	const subject = findSubject(image, background, tolerance);

	const warnings: string[] = [];
	const total = image.width * image.height;
	if (subject.pixels === 0) {
		warnings.push(
			`No pixel differs from the background ${JSON.stringify(background)} by more than the tolerance, so every measurement is empty. The background colour is probably wrong for this image — read it from the render settings rather than re-probing with another guess.`,
		);
	}
	if (subject.transparentPixels > 0) {
		warnings.push(
			`${subject.transparentPixels} of ${total} pixels are transparent and were counted as subject. On a film-transparent render the alpha channel is the subject mask and the background colour is irrelevant.`,
		);
	}

	const rowRuns = runsOfOccupiedRows(image, subject.mask);
	const occupiedRows = rowRuns.reduce((sum, run) => sum + (run.to - run.from + 1), 0);

	const meanDivisor = subject.pixels > 0 ? subject.pixels : 1;
	const result: ImageProbeResult = {
		path,
		workspacePath: manifest.workspacePath,
		width: image.width,
		height: image.height,
		bitDepth: image.bitDepth,
		colorType: image.colorType,
		alphaPresent: subject.transparentPixels > 0,
		imageSizeBytes: byteLength,
		grid: { nx: grid.nx, ny: grid.ny },
		background,
		tolerance,
		subjectBounds:
			subject.pixels > 0 ? { x0: subject.minX, x1: subject.maxX, y0: subject.minY, y1: subject.maxY } : null,
		subjectPixelCount: subject.pixels,
		subjectCoverage: round(subject.pixels / total, 5),
		transparentPixels: subject.transparentPixels,
		meanColour: [round(subject.sumR / meanDivisor, 2), round(subject.sumG / meanDivisor, 2), round(subject.sumB / meanDivisor, 2)],
		lumaGrid: lumaGrid(image, subject.mask, grid),
		silhouette: {
			rowsOccupied: occupiedRows,
			rowCount: image.height,
			widestRow: rowRuns.reduce((widest, run) => Math.max(widest, run.maxWidth), 0),
			coverageByRow: rowRuns.map((run) => ({ from: run.from, to: run.to, maxWidth: run.maxWidth })),
		},
		edgeSharpness: measureEdgeSharpness(image, subject.mask),
		palette: dominantPalette(image, subject.mask, paletteLimit),
		warnings,
	};

	const iteration = manifest.latestIteration > 0 ? manifest.latestIteration : 1;
	const { iterationDir } = getIterationPaths(manifest.workspacePath, iteration);
	await mkdir(iterationDir, { recursive: true });
	await writeFile(join(iterationDir, "image-probe.json"), JSON.stringify(result, null, 2), "utf-8");
	return result;
}

function resolveImagePath(path: string, workspacePath: string): string {
	return isAbsolute(path) ? path : resolve(workspacePath, path);
}

async function readImage(path: string): Promise<{ image: DecodedImage; byteLength: number }> {
	let buffer: Buffer;
	try {
		buffer = await readFile(path);
	} catch (error) {
		throw new Error(`Cannot read image ${path}: ${(error as Error).message}`);
	}
	if (!looksLikePng(buffer)) {
		throw new Error(`${path} is not a PNG. Only PNG can be sampled; re-render it, or convert it to .png first.`);
	}
	return { image: decodePng(buffer), byteLength: buffer.length };
}

function normalizeGrid(grid: [number, number] | undefined): { nx: number; ny: number } {
	const side = (value: number | undefined): number => {
		if (value === undefined || !Number.isFinite(value)) return DEFAULT_GRID_SIDE;
		return Math.min(MAX_GRID_SIDE, Math.max(1, Math.round(value)));
	};
	return { nx: side(grid?.[0]), ny: side(grid?.[1]) };
}

function normalizeTolerance(tolerance: number | undefined): number {
	if (tolerance === undefined || !Number.isFinite(tolerance)) return 0;
	return Math.max(0, Math.min(1, tolerance));
}

function normalizePaletteLimit(limit: number | undefined): number {
	if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_PALETTE_LIMIT;
	return Math.min(MAX_PALETTE_LIMIT, Math.max(0, Math.round(limit)));
}

function findSubject(image: DecodedImage, background: [number, number, number], tolerance: number): SubjectMask {
	const { width, height, pixels } = image;
	const mask = new Uint8Array(width * height);
	const backgroundR = background[0] * 255;
	const backgroundG = background[1] * 255;
	const backgroundB = background[2] * 255;
	// Mean per-channel distance, so `tolerance` reads as "how far a pixel may
	// sit from the background and still count as background".
	const threshold = tolerance * 255;

	let pixels_found = 0;
	let transparent = 0;
	let minX = width;
	let maxX = -1;
	let minY = height;
	let maxY = -1;
	let sumR = 0;
	let sumG = 0;
	let sumB = 0;

	for (let index = 0; index < width * height; index++) {
		const base = index * 4;
		const r = pixels[base] ?? 0;
		const g = pixels[base + 1] ?? 0;
		const b = pixels[base + 2] ?? 0;
		const a = pixels[base + 3] ?? 255;
		if (a <= ALPHA_CUTOFF) {
			transparent++;
			continue;
		}
		const distance = (Math.abs(r - backgroundR) + Math.abs(g - backgroundG) + Math.abs(b - backgroundB)) / 3;
		if (distance <= threshold) continue;

		mask[index] = 1;
		pixels_found++;
		sumR += r;
		sumG += g;
		sumB += b;
		const x = index % width;
		const y = (index - x) / width;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}

	return { mask, pixels: pixels_found, transparentPixels: transparent, minX, maxX, minY, maxY, sumR, sumG, sumB };
}

function lumaOf(image: DecodedImage, pixelIndex: number): number {
	const base = pixelIndex * 4;
	const r = image.pixels[base] ?? 0;
	const g = image.pixels[base + 1] ?? 0;
	const b = image.pixels[base + 2] ?? 0;
	return LUMA_R * r + LUMA_G * g + LUMA_B * b;
}

function runsOfOccupiedRows(image: DecodedImage, mask: Uint8Array): { from: number; to: number; maxWidth: number }[] {
	const runs: { from: number; to: number; maxWidth: number }[] = [];
	let start: number | null = null;
	let maxWidth = 0;
	for (let y = 0; y <= image.height; y++) {
		let count = 0;
		if (y < image.height) {
			const offset = y * image.width;
			for (let x = 0; x < image.width; x++) {
				if (mask[offset + x]) count++;
			}
		}
		if (count > 0) {
			if (start === null) start = y;
			if (count > maxWidth) maxWidth = count;
			continue;
		}
		if (start !== null) {
			runs.push({ from: start, to: y - 1, maxWidth });
			start = null;
			maxWidth = 0;
		}
	}
	return runs;
}

function lumaGrid(image: DecodedImage, mask: Uint8Array, grid: { nx: number; ny: number }): (number | null)[][] {
	const cells: number[][] = Array.from({ length: grid.ny }, () => new Array<number>(grid.nx).fill(0));
	const counts: number[][] = Array.from({ length: grid.ny }, () => new Array<number>(grid.nx).fill(0));

	for (let y = 0; y < image.height; y++) {
		const cellY = Math.min(grid.ny - 1, Math.floor((y * grid.ny) / image.height));
		const offset = y * image.width;
		for (let x = 0; x < image.width; x++) {
			if (!mask[offset + x]) continue;
			const cellX = Math.min(grid.nx - 1, Math.floor((x * grid.nx) / image.width));
			const base = (offset + x) * 4;
			const r = image.pixels[base] ?? 0;
			const g = image.pixels[base + 1] ?? 0;
			const b = image.pixels[base + 2] ?? 0;
			const row = cells[cellY];
			const rowCounts = counts[cellY];
			if (!row || !rowCounts) continue;
			row[cellX] = (row[cellX] ?? 0) + (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;			rowCounts[cellX] = (rowCounts[cellX] ?? 0) + 1;
		}
	}

	return cells.map((row, y) =>
		row.map((sum, x) => {
			const count = counts[y]?.[x] ?? 0;
			return count > 0 ? round(sum / count, 4) : null;
		}),
	);
}

/**
 * Mean contrast across a subject/background boundary, 0..1.
 *
 * Only the pixels that straddle the silhouette count: a step between two
 * interior pixels says nothing about an edge, and averaging those in would
 * report a hard-edged subject as blurry simply because most of it is
 * interior. A hard boundary reads near 1.0, a ten-pixel ramp near 0.1, and a
 * subject that matches its own background has no boundary and no score.
 */
function measureEdgeSharpness(image: DecodedImage, mask: Uint8Array): number | null {
	let total = 0;
	let crossings = 0;
	for (let y = 0; y < image.height; y++) {
		const offset = y * image.width;
		for (let x = 0; x < image.width - 1; x++) {
			const here = mask[offset + x];
			const next = mask[offset + x + 1];
			if (here === next) continue;
			if ((image.pixels[(offset + x + 1) * 4 + 3] ?? 255) <= ALPHA_CUTOFF) continue;
			total += Math.abs(lumaOf(image, offset + x) - lumaOf(image, offset + x + 1)) / 255;
			crossings++;
		}
	}
	return crossings === 0 ? null : round(total / crossings, 5);
}

function dominantPalette(image: DecodedImage, mask: Uint8Array, limit: number): { hex: string; fraction: number }[] {
	if (limit === 0) return [];
	const buckets = new Map<number, number>();
	let subjectPixels = 0;
	for (let index = 0; index < mask.length; index++) {
		if (!mask[index]) continue;
		const base = index * 4;
		const r = Math.round(((image.pixels[base] ?? 0) / 255) * 15);
		const g = Math.round(((image.pixels[base + 1] ?? 0) / 255) * 15);
		const b = Math.round(((image.pixels[base + 2] ?? 0) / 255) * 15);
		const key = (r << 8) | (g << 4) | b;
		buckets.set(key, (buckets.get(key) ?? 0) + 1);
		subjectPixels++;
	}
	const divisor = subjectPixels > 0 ? subjectPixels : 1;
	const step = 255 / 15;
	return [...buckets.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([key, count]) => ({
			hex: toHex(Math.round(((key >> 8) & 15) * step), Math.round(((key >> 4) & 15) * step), Math.round((key & 15) * step)),
			fraction: round(count / divisor, 4),
		}));
}

function toHex(r: number, g: number, b: number): string {
	const channel = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
