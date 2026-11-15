#!/usr/bin/env node
/**
 * The deterministic proxy critic: predictions from pixels, and nothing else.
 *
 * The calibration set exists to answer "does a verdict track the picture?".
 * Answering it with the vision critic needs model calls, so the default is this
 * proxy: it decodes each render, measures it with the same `blenderImageProbe`
 * the critic reads, and predicts a pass, a defect vocabulary and the six axis
 * scores from those numbers alone. It never receives `truth`, which is what
 * makes the resulting agreement a measurement rather than a tautology — the
 * calibration test runs the proxy twice, once on the labelled manifest and once
 * on a copy with the labels deleted, and requires identical predictions.
 *
 * What it can and cannot see is the honest limit of the set. It sees clipping,
 * a neutral flat palette, a silhouette that lost a part, a silhouette that
 * collapsed against its own clean render, and a subject cropped by the frame.
 * It cannot see a seam, a wrong-but-plausible proportion, a texture that is the
 * wrong wood, or a missing part on an object with no clean render to pair with.
 * Those need the live critic, and are documented as gaps rather than guessed.
 *
 * The measurements are arithmetic over decoded pixels:
 *
 *   - `blenderImageProbe` for coverage, bounds, palette, exposure and edge
 *     sharpness;
 *   - a second silhouette mask built here with the same rule the probe uses
 *     (transparent, or within the tolerance of the background colour), because
 *     comparing a defective render with its clean pair needs pixel membership,
 *     which the probe's JSON result deliberately does not carry.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Thresholds the predictions depend on.
 *
 * They live in the fixture manifest as well, because a threshold that is only
 * in the code cannot be reviewed next to the labels it produces. The
 * calibration test fails if the manifest's copy and this one disagree, so the
 * two cannot drift silently.
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
	// Share of the sampled subject pinned at white on all three channels. The
	// probe warns from 2%, which is a hint; a fixture that claims the defect has
	// to be visibly torn, so the bar is a quarter of the subject.
	clippedShare: 0.25,
	// Above this the subject is mostly white and a critic can see nothing in it.
	clippedSevereShare: 0.5,
	// Share of the subject's palette that must be neutral (low chroma) before
	// "the material is a flat default grey" is a claim the pixels support.
	flatNeutralShare: 0.85,
	// Per-channel (max-min)/max below which a palette entry counts as neutral.
	chromaNeutral: 0.12,
	// Share of the reference silhouette that may disappear and still be called a
	// lost part rather than a different render.
	partialLossShare: 0.05,
	// A lost part this large is the whole subject, and drains completeness to 0.
	missingSevereShare: 0.15,
	// Below both of these, the silhouette collapsed rather than lost a part.
	collapsedAreaShare: 0.6,
	collapsedHeightShare: 0.4,
	// Coverage required before frame contact counts as a scale error: a subject
	// that merely touches an edge is not necessarily cropped by it.
	frameBleedCoverage: 0.35,
});

/** Perceived-luminance weights, matching the probe, for the mask's own maths. */
const AXES = ["accuracy", "geometry", "materials", "completeness", "quality", "validity"];
const ALPHA_CUTOFF = 8;
// The probe's default subject rule: a pixel is background when it is
// indistinguishable from it. The fixture renders on pure black with dithering
// off, so "background" is exact rather than a tolerance to tune.
const BACKGROUND = [0, 0, 0];
const BACKGROUND_TOLERANCE = 0.02;

/** A defensible starting score: every axis perfect until a measurement says otherwise. */
function fullMarks() {
	return Object.fromEntries(AXES.map((axis) => [axis, 2]));
}

function round(value, digits = 4) {
	return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

/**
 * The subject mask, by the probe's rule.
 *
 * Kept separate from `blenderImageProbe` rather than folded into it: the probe
 * answers "how does this image measure", and its result is JSON that a critic
 * reads. Mask membership is only needed to compare two images, so it stays
 * here, where it is used.
 */
export function silhouetteOf(image) {
	const { width, height, pixels } = image;
	const mask = new Uint8Array(width * height);
	const threshold = BACKGROUND_TOLERANCE * 255;
	let count = 0;
	let minX = width;
	let maxX = -1;
	let minY = height;
	let maxY = -1;

	for (let index = 0; index < width * height; index++) {
		const base = index * 4;
		const alpha = pixels[base + 3] ?? 255;
		if (alpha <= ALPHA_CUTOFF) continue;
		const distance =
			(Math.abs((pixels[base] ?? 0) - BACKGROUND[0] * 255) +
				Math.abs((pixels[base + 1] ?? 0) - BACKGROUND[1] * 255) +
				Math.abs((pixels[base + 2] ?? 0) - BACKGROUND[2] * 255)) /
			3;
		if (distance <= threshold) continue;
		mask[index] = 1;
		count++;
		const x = index % width;
		const y = (index - x) / width;
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}

	const columns = new Int32Array(width);
	for (let y = 0; y < height; y++) {
		const offset = y * width;
		for (let x = 0; x < width; x++) {
			if (mask[offset + x]) columns[x] += 1;
		}
	}

	return {
		width,
		height,
		mask,
		pixels: count,
		bounds: count > 0 ? { x0: minX, x1: maxX, y0: minY, y1: maxY } : null,
		rowsOccupied: count === 0 ? 0 : maxY - minY + 1,
		columns,
	};
}

/**
 * Compare a render's silhouette with the clean render of the same object.
 *
 * The area ratio answers "is less subject there", the height ratio "is it
 * flatter", and `lateral` "did the loss stick out sideways from the body". The
 * last one is what separates a missing handle (a protrusion outside the body)
 * from a body that merely renders slightly thinner: the body's columns are the
 * ones that carry the silhouette's full height, so a loss entirely outside them
 * is a part the object had and no longer does.
 */
export function compareSilhouettes(candidate, reference) {
	let missing = 0;
	let extra = 0;
	let missingMinX = reference.width;
	let missingMaxX = -1;
	for (let index = 0; index < reference.mask.length; index++) {
		const here = candidate.mask[index] === 1;
		const there = reference.mask[index] === 1;
		if (there && !here) {
			missing++;
			const x = index % reference.width;
			if (x < missingMinX) missingMinX = x;
			if (x > missingMaxX) missingMaxX = x;
		} else if (!there && here) {
			extra++;
		}
	}

	const referenceDivisor = reference.pixels === 0 ? 1 : reference.pixels;
	const widest = (silhouette) => {
		let widestRow = 0;
		for (let y = 0; y < silhouette.height; y++) {
			let count = 0;
			const offset = y * silhouette.width;
			for (let x = 0; x < silhouette.width; x++) if (silhouette.mask[offset + x]) count++;
			if (count > widestRow) widestRow = count;
		}
		return widestRow;
	};
	const referenceWidest = widest(reference);
	const candidateWidest = widest(candidate);
	const core = coreColumns(reference);

	return {
		missingFraction: round(missing / referenceDivisor),
		extraFraction: round(extra / referenceDivisor),
		areaRatio: round(candidate.pixels / referenceDivisor),
		heightRatio: reference.rowsOccupied === 0 ? null : round(candidate.rowsOccupied / reference.rowsOccupied),
		widthRatio: referenceWidest === 0 ? null : round(candidateWidest / referenceWidest),
		missingBounds: missing === 0 ? null : { x0: missingMinX, x1: missingMaxX },
		// Every lost pixel sits to one side of the columns that carry the
		// reference's full height, so the loss is a protrusion and not a thinner
		// body.
		lateral: missing > 0 && (missingMaxX < core.x0 || missingMinX > core.x1),
	};
}

/**
 * The columns that carry at least 90% of the silhouette's tallest column.
 *
 * A handle, an arm or any protrusion is shorter than the body it hangs off, so
 * this band is the body. It is measured on the reference, which is the clean
 * render, so it describes the object and not the defect.
 */
function coreColumns(silhouette) {
	let tallest = 0;
	for (const count of silhouette.columns) if (count > tallest) tallest = count;
	const bar = tallest * 0.9;
	let x0 = silhouette.width;
	let x1 = -1;
	for (let x = 0; x < silhouette.width; x++) {
		if (silhouette.columns[x] >= bar) {
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
		}
	}
	return { x0, x1 };
}

/** Share of the subject's palette that is neutral: near-equal red, green and blue. */
export function neutralShareOfPalette(palette, chromaNeutral) {
	let share = 0;
	for (const entry of palette) {
		const r = Number.parseInt(entry.hex.slice(1, 3), 16);
		const g = Number.parseInt(entry.hex.slice(3, 5), 16);
		const b = Number.parseInt(entry.hex.slice(5, 7), 16);
		const max = Math.max(r, g, b);
		const min = Math.min(r, g, b);
		const chroma = max === 0 ? 0 : (max - min) / max;
		if (chroma < chromaNeutral) share += entry.fraction;
	}
	return round(Math.min(1, share));
}

/**
 * Predict a verdict from measurements.
 *
 * Order is a real decision, not an accident: a blown-out white subject is also a
 * neutral palette, so clipping has to be ruled out before flatness is claimed,
 * and a subject that lost 97% of its area is a collapse before it is a lost
 * part. Each rule names the axis its defect drains; the other axes stay at
 * full marks because the proxy has measured nothing that argues against them.
 */
export function predictFromMeasurements(measurements, thresholds = DEFAULT_THRESHOLDS) {
	const { probe, silhouette, diff } = measurements;
	const axes = fullMarks();
	const defects = [];
	const evidence = {
		coverage: probe.subjectCoverage,
		bounds: probe.subjectBounds,
		clippedShare: probe.exposure.clippedHigh.all,
		neutralShare: neutralShareOfPalette(probe.palette, thresholds.chromaNeutral),
	};

	if (evidence.clippedShare >= thresholds.clippedShare) {
		defects.push("clipped_exposure");
		axes.quality = evidence.clippedShare >= thresholds.clippedSevereShare ? 0 : 1;
	} else if (evidence.neutralShare >= thresholds.flatNeutralShare) {
		// Not "grey is wrong": a deliberately grey material is a materials
		// question the proxy cannot answer. What it can say is that the subject
		// carries no colour at all, which is what a flat default material looks
		// like and what the fixture labels.
		defects.push("flat_material");
		axes.materials = 0;
	} else if (
		diff &&
		diff.areaRatio < thresholds.collapsedAreaShare &&
		(diff.heightRatio ?? 1) < thresholds.collapsedHeightShare
	) {
		// A subject that lost most of its area and most of its height did not lose
		// a part, it collapsed: geometry and validity both go.
		defects.push("collapsed_silhouette");
		axes.geometry = 0;
		axes.validity = 0;
	} else if (diff && diff.missingFraction >= thresholds.partialLossShare && diff.lateral) {
		defects.push("missing_handle");
		axes.completeness = diff.missingFraction >= thresholds.missingSevereShare ? 0 : 1;
	} else if (
		silhouette.bounds &&
		silhouette.bounds.x0 === 0 &&
		silhouette.bounds.x1 === silhouette.width - 1 &&
		probe.subjectCoverage >= thresholds.frameBleedCoverage
	) {
		defects.push("wrong_scale");
		axes.geometry = 0;
		axes.accuracy = 0;
	}

	return { pass: defects.length === 0, defects, axes, evidence };
}

/**
 * Score every image in a fixture manifest.
 *
 * `probeImage(path)` is injected rather than imported so this module stays a
 * pure prediction layer: the CLI loads the extension's TypeScript through jiti,
 * and the tests load it through the same loader they already use. The manifest's
 * `truth` is not touched here — the caller keeps the labels and compares them
 * afterwards, in `calibrate()`.
 */
export async function reviewManifest(manifest, probeImage) {
	const thresholds = { ...DEFAULT_THRESHOLDS, ...(manifest.thresholds ?? {}) };
	const measured = new Map();
	for (const image of manifest.images) {
		measured.set(image.id, await probeImage(image.file));
	}
	const reviews = [];
	for (const image of manifest.images) {
		const { probe, image: decoded } = measured.get(image.id);
		const silhouette = silhouetteOf(decoded);
		const referenceImage = image.reference ? measured.get(image.reference) : undefined;
		if (image.reference && !referenceImage) {
			throw new Error(`image ${image.id} names reference ${image.reference}, which is not in the manifest`);
		}
		const diff = referenceImage
			? compareSilhouettes(silhouette, silhouetteOf(referenceImage.image))
			: undefined;
		const prediction = predictFromMeasurements({ probe, silhouette, diff }, thresholds);
		reviews.push({
			id: image.id,
			run: 0,
			source: "proxy",
			pass: prediction.pass,
			defects: prediction.defects,
			axes: prediction.axes,
			evidence: { ...prediction.evidence, ...(diff ? { diff } : {}) },
		});
	}
	return reviews;
}

/**
 * A throwaway workspace for the probe to record its result in.
 *
 * The probe writes `image-probe.json` beside the iteration it measured, so it
 * needs a workspace even when the image under test lives in a fixture folder.
 * Calibration therefore measures out of the repository: a committed fixture is
 * input, and a run that rewrote the tree it was reading would be a bad habit to
 * put in CI.
 */
export function scratchWorkspace() {
	const dir = mkdtempSync(join(tmpdir(), "critic-calibration-"));
	const manifestPath = join(dir, "blender-workspace.json");
	writeFileSync(
		manifestPath,
		JSON.stringify({
			version: 2,
			workspacePath: dir,
			blendPath: join(dir, "scene.blend"),
			manifestPath,
			latestIteration: 1,
		}),
		"utf-8",
	);
	return dir;
}

/**
 * Read one fixture image and measure it, with a workspace for the probe.
 *
 * `modules` is injected (probe, decoder, workspace reader, workspace path) so
 * this module never imports the extension's TypeScript itself: the CLI resolves
 * it through jiti, and the tests through their own loader.
 */
export async function probeFixtureImage(path, modules) {
	const buffer = readFileSync(path);
	const image = modules.decodePng(buffer);
	const { workspace, loadWorkspaceManifest } = modules;
	const manifest = await loadWorkspaceManifest(workspace, workspace);
	const probe = await modules.blenderImageProbe({
		cwd: workspace,
		workspace,
		path,
		background: BACKGROUND,
		tolerance: BACKGROUND_TOLERANCE,
	});
	return { probe, image, manifest };
}
