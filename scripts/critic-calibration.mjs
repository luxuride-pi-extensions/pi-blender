#!/usr/bin/env node
/**
 * Score a critic against a labelled set of renders.
 *
 * Two inputs are accepted, and the difference between them is the whole point:
 *
 *   - a *report* (`images[].truth` + `reviews[]`) is a transcript of verdicts,
 *     scored as arithmetic. `test/fixtures/critic-calibration.json` is a
 *     synthetic one, and the script says so, because a fixture that agrees with
 *     itself is a format check and not evidence about a critic.
 *   - a *manifest* (`images[].truth` + `images[].file`, no reviews) is a golden
 *     set of real renders. Verdicts are produced on demand: the deterministic
 *     proxy by default, or a recorded live critic transcript with `--live`.
 *
 * The proxy reads pixels and nothing else. It is handed one image at a time and
 * never sees the labels, which is what makes `perDefectRecall` a measurement:
 * if it could read `truth.defects` it would score 1.0 and prove nothing. The
 * calibration test runs it twice — once on the manifest, once on a copy with
 * the labels stripped — and requires identical reviews.
 *
 * Live mode is opt-in because it costs model calls and needs a vision critic,
 * which lives outside this repo (the `blender-composition-critic` pi subagent).
 * `--live --reviews <file>` scores that critic's recorded verdicts, so a live
 * calibration can be committed as a transcript without this script depending on
 * a model client it does not have.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_THRESHOLDS, probeFixtureImage, reviewManifest, scratchWorkspace } from "./critic-proxy.mjs";
import { resolveJiti } from "./jiti-resolver.mjs";

const AXES = ["accuracy", "geometry", "materials", "completeness", "quality", "validity"];
const USAGE =
	"usage: node scripts/critic-calibration.mjs <report.json|manifest.json> [--json] [--live --reviews <file>] [--out <file>]";

function mean(values) {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
	if (values.length < 2) return 0;
	const average = mean(values);
	return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function round(value, digits = 4) {
	return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

/**
 * Group every review by the image it judged, dropping reviews for unknown images.
 *
 * Reviews naming an absent image are dropped rather than fatal so a transcript
 * from a set that has since lost a case still scores the cases it can.
 */
function reviewsByImage(images, reviews) {
	const byImage = new Map();
	for (const review of reviews) {
		if (!images.has(review.id)) continue;
		const list = byImage.get(review.id) ?? [];
		list.push(review);
		byImage.set(review.id, list);
	}
	return byImage;
}

function assertImages(report) {
	if (!report || typeof report !== "object" || !Array.isArray(report.images) || !Array.isArray(report.reviews)) {
		throw new Error("calibration report must be an object with images[] and reviews[] arrays");
	}
	for (const image of report.images) {
		if (!image || typeof image.id !== "string" || !image.truth || typeof image.truth.pass !== "boolean" || !Array.isArray(image.truth.defects)) {
			throw new Error(`image ${image?.id ?? "(no id)"} needs a truth.pass boolean and a truth.defects array`);
		}
	}
}

/**
 * Score reviews against labels.
 *
 * Four numbers carry the calibration argument, and they fail in different ways,
 * which is why all four are reported:
 *
 *   - `perAxisError` (mean absolute error against the labels' `expectedAxes`)
 *     says whether the scores are on the right scale, not merely consistent.
 *   - `pass.agreement` says whether the verdict tracked the render.
 *   - `perDefectRecall`, broken down per defect name, says *which* faults are
 *     seen. A single overall recall hides a critic that finds clipping on every
 *     image and nothing else; the per-name split cannot.
 *   - `falsePass.rate` says whether failures slipped through. It is the metric
 *     that matters commercially: a broken render reported as good is worse than
 *     a good render reported as broken.
 */
export function calibrate(report) {
	assertImages(report);
	const images = new Map(report.images.map((image) => [image.id, image]));
	const byImage = reviewsByImage(images, report.reviews ?? []);

	const axes = {};
	const axisErrors = [];
	for (const axis of AXES) {
		const means = [];
		const spreads = [];
		const errors = [];
		for (const [id, list] of byImage) {
			const scores = list.map((review) => review.axes?.[axis]).filter((score) => typeof score === "number");
			const average = mean(scores);
			if (average === null) continue;
			means.push(average);
			spreads.push(stddev(scores));
			// Only images that state an expectation for this axis count: an image
			// that says nothing about materials is not scored as if it expected 2.
			// The expectation lives with the other labels, inside `truth`, and the
			// flat form is accepted so a hand-written report can put it either way.
			const expectation = images.get(id).truth.expectedAxes ?? images.get(id).expectedAxes;
			const expected = expectation?.[axis];
			if (typeof expected === "number") errors.push(Math.abs(average - expected));
		}
		const meanSquare = mean(spreads.map((value) => value ** 2));
		axes[axis] = {
			images: means.length,
			mean: round(mean(means), 2),
			variance: round(meanSquare),
			stddev: round(meanSquare === null ? null : Math.sqrt(meanSquare)),
			// Mean absolute error of the mean score against the labelled
			// expectation, over the images that state one.
			mae: round(mean(errors)),
			expected: errors.length,
		};
		axisErrors.push(...errors);
	}

	let passChecks = 0;
	let passAgreements = 0;
	let truthFailures = 0;
	let falsePasses = 0;
	const defectChecks = new Map();
	for (const [id, list] of byImage) {
		const truth = images.get(id).truth;
		for (const review of list) {
			passChecks += 1;
			if (Boolean(review.pass) === Boolean(truth.pass)) passAgreements += 1;
			if (!truth.pass) {
				truthFailures += 1;
				if (review.pass) falsePasses += 1;
			}
			const reported = new Set(review.defects ?? []);
			for (const defect of truth.defects ?? []) {
				const entry = defectChecks.get(defect) ?? { checks: 0, hits: 0 };
				entry.checks += 1;
				if (reported.has(defect)) entry.hits += 1;
				defectChecks.set(defect, entry);
			}
		}
	}

	const perDefectRecall = { overall: null, byDefect: {}, missed: [] };
	let defectTotal = 0;
	let defectHits = 0;
	for (const [defect, entry] of [...defectChecks].sort(([left], [right]) => left.localeCompare(right))) {
		const recall = round(entry.hits / entry.checks);
		perDefectRecall.byDefect[defect] = { checks: entry.checks, hits: entry.hits, recall };
		perDefectRecall.missed.push(...(recall === 0 ? [defect] : []));
		defectTotal += entry.checks;
		defectHits += entry.hits;
	}
	perDefectRecall.overall = round(defectTotal === 0 ? null : defectHits / defectTotal);

	// Defects the critic reported that no label asked for. Not part of recall —
	// an invented fault is a precision problem, and naming it here keeps it
	// visible instead of buried in the pass-agreement number.
	const spurious = new Map();
	for (const [id, list] of byImage) {
		const labelled = new Set(images.get(id).truth.defects ?? []);
		for (const review of list) {
			for (const defect of review.defects ?? []) {
				if (!labelled.has(defect)) spurious.set(defect, (spurious.get(defect) ?? 0) + 1);
			}
		}
	}

	return {
		images: images.size,
		reviews: [...byImage.values()].reduce((total, list) => total + list.length, 0),
		axes,
		perAxisError: {
			byAxis: Object.fromEntries(AXES.map((axis) => [axis, axes[axis].mae])),
			mean: round(mean(axisErrors)),
			checks: axisErrors.length,
		},
		pass: {
			checks: passChecks,
			agreement: round(passChecks === 0 ? null : passAgreements / passChecks),
		},
		defects: {
			checks: defectTotal,
			recall: perDefectRecall.overall,
		},
		perDefectRecall,
		spurious: Object.fromEntries([...spurious].sort(([left], [right]) => left.localeCompare(right))),
		falsePass: {
			failures: truthFailures,
			rate: round(truthFailures === 0 ? null : falsePasses / truthFailures),
		},
	};
}

/** A manifest is a golden set: files on disk, labels, no verdicts. */
export function isManifest(input) {
	return (
		Boolean(input) &&
		typeof input === "object" &&
		Array.isArray(input.images) &&
		input.images.length > 0 &&
		input.images.every((image) => typeof image?.file === "string") &&
		!Array.isArray(input.reviews)
	);
}

/**
 * Load the extension's TypeScript for the proxy.
 *
 * jiti, not a native import: these modules use NodeNext-style `./png.js`
 * specifiers that resolve to `.ts` files, which Node's own loader will not do.
 *
 * It is loaded by PATH from scripts/jiti-resolver.mjs, not by a bare
 * `import("jiti")`: jiti is not a dependency of this package (it arrives nested
 * under @earendil-works/pi-coding-agent), so a bare specifier works only in a
 * checkout where it happens to be reachable and fails in CI. The resolver is the
 * same one the test harness uses, for the same reason.
 */
async function loadMeasurers() {
	const { createJiti } = await import(resolveJiti());
	const jiti = createJiti(import.meta.url, { interopDefault: true });
	const [probe, png, workspace] = await Promise.all([
		jiti.import("../blender/image-probe.ts"),
		jiti.import("../blender/png.ts"),
		jiti.import("../blender/workspace.ts"),
	]);
	return {
		decodePng: png.decodePng,
		blenderImageProbe: probe.blenderImageProbe,
		loadWorkspaceManifest: workspace.loadWorkspaceManifest,
	};
}

/**
 * Turn a manifest into a report by predicting from pixels.
 *
 * One scratch workspace is shared by the run: the probe writes its JSON result
 * there, and nothing in the repository is touched.
 */
export async function reportFromProxy(manifest, options = {}) {
	const modules = options.modules ?? (await loadMeasurers());
	const workspace = options.workspace ?? scratchWorkspace();
	const directory = options.directory ?? dirname(resolve(options.manifestPath ?? "manifest.json"));
	const reviews = await reviewManifest(
		manifest,
		(file) => probeFixtureImage(isAbsolute(file) ? file : join(directory, file), { ...modules, workspace }),
	);
	return { ...manifest, reviews };
}

/** Merge recorded live verdicts from `--reviews` with a manifest's labels. */
export function reportFromLive(manifest, transcript) {
	const reviews = Array.isArray(transcript) ? transcript : transcript?.reviews;
	if (!Array.isArray(reviews) || reviews.length === 0) {
		throw new Error("--reviews must be a report with a reviews[] array, or a bare reviews array");
	}
	for (const review of reviews) {
		if (typeof review?.id !== "string" || typeof review.pass !== "boolean") {
			throw new Error("every live review needs an id and a pass boolean");
		}
	}
	return { ...manifest, reviews };
}

function printTable(result) {
	console.log(`images ${result.images}, reviews ${result.reviews}`);
	console.log("axis        stddev  variance  mean   mae");
	for (const [axis, stats] of Object.entries(result.axes)) {
		console.log(
			`${axis.padEnd(12)} ${String(stats.stddev).padStart(6)}  ${String(stats.variance).padStart(8)}  ${String(stats.mean).padStart(4)}  ${String(stats.mae).padStart(5)}`,
		);
	}
	console.log(`axis MAE ${result.perAxisError.mean ?? "n/a"} (${result.perAxisError.checks} labelled expectations)`);
	console.log(`pass agreement ${result.pass.agreement ?? "n/a"} (${result.pass.checks} checks)`);
	console.log(`defect recall ${result.defects.recall ?? "n/a"} (${result.defects.checks} checks)`);
	for (const [defect, entry] of Object.entries(result.perDefectRecall.byDefect)) {
		console.log(`  ${defect.padEnd(24)} ${String(entry.recall).padStart(4)} (${entry.hits}/${entry.checks})`);
	}
	if (result.perDefectRecall.missed.length > 0) {
		console.log(`  never detected: ${result.perDefectRecall.missed.join(", ")}`);
	}
	const spurious = Object.entries(result.spurious);
	if (spurious.length > 0) {
		console.log(`  reported on unlabelled images: ${spurious.map(([defect, count]) => `${defect}x${count}`).join(", ")}`);
	}
	console.log(`false-pass rate ${result.falsePass.rate ?? "n/a"} (${result.falsePass.failures} failure reviews)`);
}

function flagValue(flag) {
	const index = process.argv.indexOf(flag);
	return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
	const path = process.argv[2];
	if (!path) {
		console.error(USAGE);
		process.exit(2);
	}
	const live = process.argv.includes("--live");
	const outPath = flagValue("--out");

	let result;
	try {
		const input = JSON.parse(readFileSync(resolve(path), "utf8"));
		let report = input;
		if (isManifest(input)) {
			if (live) {
				const transcriptPath = flagValue("--reviews");
				if (!transcriptPath) {
					throw new Error("--live needs --reviews <file> with the critic's recorded verdicts");
				}
				if (input.reviews) throw new Error("manifest has both file[] images and reviews[]; pass a report instead");
				report = reportFromLive(input, JSON.parse(readFileSync(resolve(transcriptPath), "utf8")));
			} else {
				console.error(`proxy mode: deterministic predictions from pixels, thresholds ${JSON.stringify(DEFAULT_THRESHOLDS)}`);
				report = await reportFromProxy(input, { manifestPath: resolve(path) });
				if (outPath) {
					writeFileSync(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
					console.error(`wrote the predicted report to ${outPath}`);
				}
			}
		} else if (input?._synthetic) {
			console.error("synthetic format fixture — arithmetic only, not calibration evidence");
		}
		result = calibrate(report);
	} catch (error) {
		console.error(`could not calibrate ${path}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}

	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	printTable(result);
}

function isMain() {
	try {
		return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isMain()) await main();
