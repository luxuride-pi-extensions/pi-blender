import type { ImageProbeResult, RenderFacts } from "./types.js";

/**
 * The facts a saved render states about material and exposure, derived from the
 * image probe.
 *
 * The probe answers "where is the subject and what does it look like"; a critic
 * needs "is this image worth judging at all". Those are two different questions
 * and only the second one is cheap, so it is answered here, before any critic is
 * spent: a subject whose colours are all neutral is an unpainted default
 * material, and one flat shade covering most of it means no texture or material
 * variation reached the image. Neither is a matter of taste.
 *
 * The thresholds below are calibrated against measured renders of the studio
 * workspace (EEVEE, 1200x900, three sun lights). A default-material sphere
 * reports one palette entry at 0.55 share, all six entries neutral, and an
 * untouched Base Color of 0.8; the same sphere with a red Base Color reports a
 * top entry of 0.17 and no neutral entry at all. Nothing here may be tuned
 * without re-measuring both, because the separation between "unpainted" and
 * "painted" is exactly the gap between those two numbers.
 */

/** Share of the subject one palette entry must hold to read as a single flat shade. */
const FLAT_SHADE_SHARE = 0.35;

/**
 * Per-channel spread of a palette colour, on 0..255, that still reads as grey.
 *
 * Loose on purpose: quantised palette buckets and the warm/cool lights both move
 * a neutral surface a few steps per channel, and a grey that is 30 steps off
 * channel to channel is still a grey no one chose.
 */
const NEUTRAL_CHANNEL_SPREAD = 40;

/** Share of the reported palette mass that must be neutral to call the subject near-monochrome. */
const MONOCHROME_SHARE = 0.9;

/** Clipped-pixel share of the subject at which exposure counts as hiding detail. */
const CLIPPED_SHARE = 0.02;

/** Share of the frame's border ring one colour must hold for the backdrop to be a flat fill. */
const FLAT_BACKDROP_SHARE = 0.9;

/**
 * The backdrop the render was taken against, as the run process measured it.
 *
 * Reported rather than assumed: the colour the probe has to ignore is the one
 * the saved PNG holds — the studio world is linear 0.05 and renders to display
 * 0.23 — and a world with a gradient or an environment map has no single
 * backdrop colour for a probe to ignore.
 */
export interface RenderBackdrop {
	/** The saved image's own backdrop colour, 0..1 per channel. Absent on a film-transparent render. */
	background?: [number, number, number];
	/** True when the render kept an alpha channel instead of a backdrop. */
	filmTransparent?: boolean;
	/** Share of the frame's border ring that colour holds, 0..1. */
	backgroundUniform?: number;
}

export function renderFactsFromProbe(probe: ImageProbeResult, backdrop: RenderBackdrop): RenderFacts {
	const reportedMass = probe.palette.reduce((sum, entry) => sum + entry.fraction, 0);
	const neutralMass = probe.palette
		.filter((entry) => channelSpread(entry.hex) <= NEUTRAL_CHANNEL_SPREAD)
		.reduce((sum, entry) => sum + entry.fraction, 0);
	const dominant = probe.palette[0];
	const clipped = probe.exposure.clippedHigh.all + probe.exposure.clippedLow.all > CLIPPED_SHARE;

	const facts: RenderFacts = {
		exposure: probe.exposure,
		palette: probe.palette,
		subjectCoverage: probe.subjectCoverage,
		flatMaterial: dominant !== undefined && dominant.fraction >= FLAT_SHADE_SHARE,
		clipped,
		nearMonochrome: reportedMass > 0 && neutralMass / reportedMass >= MONOCHROME_SHARE,
		warnings: [...probe.warnings],
	};

	// The probe's own warnings cover a subject it could not find and a flat or
	// clipped exposure. Letting them stand means a reader has one list, in one
	// order, instead of a probe list and a facts list that can disagree.
	if (probe.subjectCoverage === 0) return facts;

	if (facts.flatMaterial && dominant) {
		facts.warnings.push(
			`${Math.round(dominant.fraction * 100)}% of the subject is one shade (${dominant.hex}) and the palette holds nothing else of size. No texture, pattern or material variation reached the image, so there is nothing here for a critic to judge: assign and paint the material first.`,
		);
	}
	if (facts.nearMonochrome) {
		facts.warnings.push(
			`Every colour in the subject is near-neutral (${Math.round((neutralMass / reportedMass) * 100)}% of the reported palette). An untouched Blender material renders exactly like this, so check the material was assigned and painted before treating the surface as a modelling or taste question.`,
		);
	}
	if (!backdrop.filmTransparent && backdrop.background === undefined) {
		facts.warnings.push(
			"The run reported no backdrop colour for this render, so the subject mask was measured against black and may cover the whole frame. Treat subjectCoverage and the palette as unverified.",
		);
	} else if (!backdrop.filmTransparent && (backdrop.backgroundUniform ?? 1) < FLAT_BACKDROP_SHARE) {
		facts.warnings.push(
			`The backdrop is not a flat fill: only ${Math.round((backdrop.backgroundUniform ?? 0) * 100)}% of the frame's border ring is one colour. A gradient or environment world has no single backdrop colour, so subjectCoverage and the palette may include parts of the backdrop.`,
		);
	}
	return facts;
}

/** Largest per-channel difference in a `#rrggbb` colour, 0..255. Zero is grey. */
function channelSpread(hex: string): number {
	const red = Number.parseInt(hex.slice(1, 3), 16);
	const green = Number.parseInt(hex.slice(3, 5), 16);
	const blue = Number.parseInt(hex.slice(5, 7), 16);
	if (![red, green, blue].every(Number.isFinite)) return 0;
	return Math.max(red, green, blue) - Math.min(red, green, blue);
}
