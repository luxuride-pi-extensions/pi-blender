import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { findSubject, type SubjectMask } from "./image-probe.js";
import { decodePng, looksLikePng, type DecodedImage } from "./png.js";
import type {
	ReferenceCompleteness,
	SilhouetteIoUMeasured,
	SilhouetteIoUOptions,
	SilhouetteIoUResult,
	SilhouetteMaskSummary,
} from "./types.js";

/**
 * How much of a reference's silhouette a render actually reproduces.
 *
 * ## Why the masks are normalised to their bounding boxes
 *
 * A reference and a render are almost never framed alike: the reference is a
 * photograph taken at some distance, through some lens, at some aspect, and the
 * render is this module's camera. A raw full-frame IoU therefore measures how
 * similarly the two images were CROPPED — the photographer, not the model — and
 * a perfectly built object loses most of its score to a framing difference.
 * Both masks are instead mapped from their own bounding box onto one square
 * grid, so the comparison is scale-, crop- and translation-invariant: what
 * survives is the shape.
 *
 * What bounding-box normalisation CANNOT see is exactly what that buys: a
 * squashed or stretched subject scores the same as a correct one, because the
 * box is stretched to the grid either way. That is why `bboxIoU` (where the
 * subject sits and how it is proportioned in its own frame) and `aspectRatio`
 * are reported alongside `iou`, and why an aspect difference raises a warning
 * instead of being silently absorbed. Neither number is resampled away.
 *
 * The grid is square, so the aspect difference is absorbed by the sampling, not
 * by a silent resize of one mask to the other's dimensions: each mask is read on
 * its own terms and the two sampled grids are compared cell by cell.
 */

/** Cells per side of the comparison grid. 128 keeps the measurement stable: measured 0.765 / 0.760 / 0.765 for one fixture pair at 128 / 64 / 200 cells. */
const DEFAULT_GRID = 128;
const MIN_GRID = 16;
const MAX_GRID = 512;
/** Box aspect ratios further apart than this are reported as different framing, not noise. */
/**
 * Per-channel tolerance for the backdrop comparison, 0.02.
 *
 * Must agree with the backdrop facts' own tolerance: if the palette calls a pixel
 * backdrop and the mask does not (or the other way round), the two disagree about
 * what the subject is, and a handful of code values of dither or film grain is
 * enough to make the difference the whole frame. #133/#144 owns a second copy of
 * this number; it must be unified into one constant when that lands.
 */
const DEFAULT_BACKDROP_TOLERANCE = 0.02;

const ASPECT_MISMATCH_RATIO = 1.15;
/** Subject coverage above this means the mask is the frame, so the background colour is wrong for the image. */
const FRAME_FILLED_COVERAGE = 0.9;

/**
 * Silhouette agreement between a render and a reference image.
 *
 * `iou` is the headline: 1.0 means the two subjects have the same shape once
 * each is normalised to its own bounding box. `coverageRatio` is the share of
 * the REFERENCE silhouette the render covers — 1.0 means nothing of the
 * reference is missing from the render, which is the number a missing part moves
 * and a piece of extra geometry does not.
 */
export async function computeSilhouetteIoU(
	renderPath: string,
	referencePath: string,
	options: SilhouetteIoUOptions = {},
): Promise<SilhouetteIoUResult> {
	const grid = normalizeGrid(options.grid);
	const renderImage = await readImage(renderPath, "render");
	const referenceImage = await readImage(referencePath, "reference");
	const renderSide = splitForeground(
		renderImage.image,
		"render",
		options.background,
		options.tolerance ?? DEFAULT_BACKDROP_TOLERANCE,
	);
	const referenceSide = splitForeground(
		referenceImage.image,
		"reference",
		options.referenceBackground,
		options.referenceTolerance ?? options.tolerance ?? DEFAULT_BACKDROP_TOLERANCE,
	);
	if (!renderSide.measured || !referenceSide.measured) {
		const reasons = [renderSide, referenceSide]
			.filter((side): side is Extract<SideSplit, { measured: false }> => !side.measured)
			.map((side) => side.reason);
		return {
			measured: false,
			renderPath: renderImage.path,
			referencePath: referenceImage.path,
			reason:
				!renderSide.measured && !referenceSide.measured
					? "neither the render nor the reference has transparency, so both foregrounds can only be told apart by a backdrop colour of their own, and none was given."
					: `${reasons.join(" ")}.`,
			warnings: [],
		};
	}

	const renderSummary = summarise(renderImage.image, renderSide.mask);
	const referenceSummary = summarise(referenceImage.image, referenceSide.mask);
	const renderCells = resample(renderImage.image, renderSide.mask, grid);
	const referenceCells = resample(referenceImage.image, referenceSide.mask, grid);

	let intersection = 0;
	let union = 0;
	let referenceFilled = 0;
	for (let cell = 0; cell < renderCells.length; cell++) {
		const inRender = renderCells[cell] === 1;
		const inReference = referenceCells[cell] === 1;
		if (inRender || inReference) union++;
		if (inRender && inReference) intersection++;
		if (inReference) referenceFilled++;
	}

	const aspectRatio =
		renderSummary.aspect !== null && referenceSummary.aspect !== null
			? round(renderSummary.aspect / referenceSummary.aspect, 3)
			: null;
	const aspectMismatch =
		aspectRatio !== null && (aspectRatio > ASPECT_MISMATCH_RATIO || aspectRatio < 1 / ASPECT_MISMATCH_RATIO);

	const warnings: string[] = [];
	if (renderSummary.pixels === 0) {
		warnings.push(
			`The render's subject mask is empty: no pixel differs from the background ${JSON.stringify(options.background)} by more than the tolerance, so the silhouette comparison is 0 by construction. The background colour is probably wrong for this render — read it from the render settings.`,
		);
	}
	if (referenceSummary.pixels === 0) {
		warnings.push(
			`The reference's subject mask is empty: no pixel differs from ${JSON.stringify(options.referenceBackground)} by more than the tolerance. A photograph's backdrop is not a render's world colour, so pass the reference's own background before reading any number here.`,
		);
	}
	for (const [label, summary] of [
		["reference", referenceSummary],
		["render", renderSummary],
	] as const) {
		if (summary.coverage >= FRAME_FILLED_COVERAGE) {
			warnings.push(
				`The ${label}'s subject mask covers ${round(summary.coverage * 100, 1)}% of its frame, so the mask is the backdrop rather than a subject and the IoU below compares two backgrounds. The background colour is wrong for this image.`,
			);
		}
	}
	if (aspectMismatch && aspectRatio !== null) {
		warnings.push(
			`The masks' bounding boxes differ in aspect (render ${round(renderSummary.aspect ?? 0, 2)}:1, reference ${round(referenceSummary.aspect ?? 0, 2)}:1). Bounding-box normalisation absorbs that difference, so it does not lower \`iou\` — a squashed or stretched subject still scores as a match. \`aspectRatio\` and \`bboxIoU\` are where the difference shows, and a missing part that changes the outline's proportions is usually visible there first.`,
		);
	}
	if (union > 0 && intersection === 0) {
		warnings.push(
			`The two masks do not overlap on a single cell of the ${grid}×${grid} grid. Either the masks are in different places, or something other than the subject is being masked. Treat this as not comparable rather than as a shape score of 0.`,
		);
	}

	return {
		measured: true,
		renderPath: renderImage.path,
		referencePath: referenceImage.path,
		iou: union > 0 ? round(intersection / union, 4) : 0,
		bboxIoU: frameBoxIoU(renderSummary, referenceSummary),
		coverageRatio: referenceFilled > 0 ? round(intersection / referenceFilled, 4) : 0,
		normalisation: "bounding-box",
		grid,
		split: { render: renderSide.source, reference: referenceSide.source },
		render: renderSummary,
		reference: referenceSummary,
		aspectRatio,
		aspectMismatch,
		warnings,
	};
}

/**
 * Silhouette IoU of the reference against every planned view, the form the
 * branch run persists into `packet.json`.
 *
 * Every view is measured, not just the reference's suggested one: the reference
 * names a viewpoint the caller only guessed at, so which view actually matches
 * it is a result, not an input. `bestViewIoU` is the maximum and is labelled
 * with the view that produced it.
 */
export async function measureReferenceCompleteness(options: {
	referencePath: string;
	views: { name: string; path: string }[];
} & SilhouetteIoUOptions): Promise<{
	completeness: ReferenceCompleteness | null;
	views: Record<string, SilhouetteIoUMeasured>;
	warnings: string[];
}> {
	const views: Record<string, SilhouetteIoUMeasured> = {};
	const warnings: string[] = [];
	const skipped: string[] = [];
	for (const view of options.views) {
		try {
			const result = await computeSilhouetteIoU(view.path, options.referencePath, options);
			if (!result.measured) {
				skipped.push(result.reason);
				continue;
			}
			views[view.name] = result;
		} catch (error) {
			// A panel that failed to render is not a shape finding, so it is named
			// and skipped rather than scored as zero.
			warnings.push(`Silhouette IoU for view "${view.name}" was not measured: ${(error as Error).message}`);
		}
	}
	// One reason repeated for every view is one fact, not N findings: the reason
	// is a property of the images, so the same sentence for each view would read
	// as several problems and say nothing new after the first.
	const allSkipped = skipped.length === options.views.length;
	for (const reason of [...new Set(skipped)]) {
		const count = skipped.filter((entry) => entry === reason).length;
		const scope = allSkipped
			? count === 1
				? "the only view"
				: `any of the ${count} views`
			: `${count} view${count === 1 ? "" : "s"}`;
		warnings.push(`Reference completeness was not measured for ${scope}: ${reason}`);
	}

	const measured = Object.entries(views);
	let bestView: string | undefined;
	let bestViewIoU = 0;
	for (const [name, result] of measured) {
		if (bestView === undefined || result.iou > bestViewIoU) {
			bestView = name;
			bestViewIoU = result.iou;
		}
		for (const warning of result.warnings) warnings.push(`view "${name}": ${warning}`);
	}

	return {
		// Absent, not zero: a run that could not measure anything has no shape
		// verdict, and 0 would read as "this matches nothing".
		completeness:
			measured.length > 0
				? {
						views: Object.fromEntries(
							measured.map(([name, result]) => [name, { iou: result.iou, coverageRatio: result.coverageRatio }]),
						),
						bestViewIoU,
						bestView,
					}
				: null,
		views,
		warnings,
	};
}

/**
 * Put the measurement where a critic can read it: the run's own `packet.json`.
 *
 * Returns a warning instead of throwing, because a workspace whose packet cannot
 * be updated still holds a perfectly good render — losing the measurement is not
 * a reason to fail the run that produced the picture.
 */
export async function persistReferenceCompleteness(
	packetDir: string,
	completeness: ReferenceCompleteness,
): Promise<string | null> {
	const path = join(packetDir, "packet.json");
	try {
		const packet = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		packet.referenceCompleteness = completeness;
		await writeFile(path, `${JSON.stringify(packet, null, 2)}\n`, "utf-8");
		return null;
	} catch (error) {
		return `referenceCompleteness could not be written to ${path}: ${(error as Error).message}`;
	}
}

type SideSplit =
	| { measured: true; source: "alpha" | "background"; mask: SubjectMask }
	| { measured: false; reason: string };

/**
 * How one image's foreground is decided — per side, and never by default.
 *
 * Alpha first: an image with transparency states its own subject, so the
 * backdrop colour is irrelevant to it and the caller need not know the studio.
 * An image with no transparency can only be split by a backdrop colour the
 * caller supplies; when none was supplied the side is NOT MEASURED rather than
 * split against a guessed colour, because a wrong backdrop puts the backdrop in
 * the mask and every number derived from it then measures the studio.
 */
function splitForeground(
	image: DecodedImage,
	label: string,
	background: [number, number, number] | undefined,
	tolerance: number,
): SideSplit {
	const mask = findSubject(image, background ?? [0, 0, 0], tolerance);
	// findSubject counts alpha<=cutoff pixels out before comparing colours, so a
	// non-zero transparent count means this mask IS the alpha split and the
	// colour above played no part in it.
	if (mask.transparentPixels > 0) return { measured: true, source: "alpha", mask };
	if (background) return { measured: true, source: "background", mask };
	return {
		measured: false,
		reason: `the ${label} has no transparency, so its foreground can only be told apart by a backdrop colour of its own, and none was given`,
	};
}

async function readImage(path: string, label: string): Promise<{ path: string; image: DecodedImage }> {
	const absolute = isAbsolute(path) ? path : resolve(path);
	let buffer: Buffer;
	try {
		buffer = await readFile(absolute);
	} catch (error) {
		throw new Error(`Cannot read ${label} image ${absolute}: ${(error as Error).message}`);
	}
	if (!looksLikePng(buffer)) {
		throw new Error(`${label} image ${absolute} is not a PNG. Silhouettes are decoded from PNG only; re-render or convert it to .png first.`);
	}
	return { path: absolute, image: decodePng(buffer) };
}

function summarise(image: DecodedImage, mask: SubjectMask): SilhouetteMaskSummary {
	if (mask.pixels === 0) {
		return { width: image.width, height: image.height, pixels: 0, coverage: 0, bounds: null, aspect: null };
	}
	const boxWidth = mask.maxX - mask.minX + 1;
	const boxHeight = mask.maxY - mask.minY + 1;
	return {
		width: image.width,
		height: image.height,
		pixels: mask.pixels,
		coverage: round(mask.pixels / (image.width * image.height), 5),
		bounds: { x0: mask.minX, x1: mask.maxX, y0: mask.minY, y1: mask.maxY },
		aspect: round(boxWidth / boxHeight, 4),
	};
}

/**
 * Read one mask onto a `grid`×`grid` square by sampling each grid cell's centre
 * inside the mask's OWN bounding box. Nearest-centre sampling keeps this
 * arithmetic: no filter means a hard-edged silhouette stays hard-edged, and a
 * cell is either covered or not.
 */
function resample(image: DecodedImage, mask: SubjectMask, grid: number): Uint8Array {
	const cells = new Uint8Array(grid * grid);
	if (mask.pixels === 0) return cells;
	const boxWidth = mask.maxX - mask.minX + 1;
	const boxHeight = mask.maxY - mask.minY + 1;
	for (let cellY = 0; cellY < grid; cellY++) {
		const y = mask.minY + Math.min(boxHeight - 1, Math.floor(((cellY + 0.5) * boxHeight) / grid));
		for (let cellX = 0; cellX < grid; cellX++) {
			const x = mask.minX + Math.min(boxWidth - 1, Math.floor(((cellX + 0.5) * boxWidth) / grid));
			if (mask.mask[y * image.width + x] === 1) cells[cellY * grid + cellX] = 1;
		}
	}
	return cells;
}

/**
 * Overlap of the two bounding boxes measured in frame-relative coordinates.
 *
 * Frame-relative rather than pixel coordinates because the two images need not
 * be the same size, and an absolute box comparison across two resolutions would
 * be a comparison of resolutions.
 */
function frameBoxIoU(render: SilhouetteMaskSummary, reference: SilhouetteMaskSummary): number {
	if (!render.bounds || !reference.bounds) return 0;
	const box = (summary: SilhouetteMaskSummary, bounds: NonNullable<SilhouetteMaskSummary["bounds"]>) => ({
		x0: bounds.x0 / summary.width,
		x1: (bounds.x1 + 1) / summary.width,
		y0: bounds.y0 / summary.height,
		y1: (bounds.y1 + 1) / summary.height,
	});
	const a = box(render, render.bounds);
	const b = box(reference, reference.bounds);
	const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
	const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
	const intersection = overlapX > 0 && overlapY > 0 ? overlapX * overlapY : 0;
	const areaA = (a.x1 - a.x0) * (a.y1 - a.y0);
	const areaB = (b.x1 - b.x0) * (b.y1 - b.y0);
	const union = areaA + areaB - intersection;
	return union > 0 ? round(intersection / union, 4) : 0;
}

function normalizeGrid(grid: number | undefined): number {
	if (grid === undefined || !Number.isFinite(grid)) return DEFAULT_GRID;
	return Math.max(MIN_GRID, Math.min(MAX_GRID, Math.round(grid)));
}

function round(value: number, digits: number): number {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}
