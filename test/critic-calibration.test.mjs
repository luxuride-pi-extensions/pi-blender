import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = join(root, "test/fixtures/critic-calibration.json");
const script = join(root, "scripts/critic-calibration.mjs");

test("the calibration script reports axis spread, agreement and false passes", () => {
	const output = execFileSync(process.execPath, [script, fixture, "--json"], { encoding: "utf8" });
	const report = JSON.parse(output);
	assert.equal(report.images, 3);
	assert.equal(report.reviews, 6);
	assert.equal(report.axes.accuracy.images, 2, "the image without an accuracy score is skipped, not zero-filled");
	assert.equal(report.axes.accuracy.mean, 1.5);
	assert.equal(report.axes.accuracy.stddev, 0.7071);
	assert.equal(report.axes.accuracy.variance, 0.5);
	assert.equal(report.axes.geometry.images, 3);
	assert.equal(report.axes.geometry.stddev, 0.2887);
	assert.equal(report.pass.agreement, 0.8333);
	assert.equal(report.defects.recall, 0.75);
	assert.equal(report.falsePass.rate, 0.25);
});

test("the human table prints one row per axis", () => {
	const output = execFileSync(process.execPath, [script, fixture], { encoding: "utf8" });
	assert.match(output, /images 3, reviews 6/);
	assert.match(output, /accuracy\s+0\.70/);
	assert.match(output, /false-pass rate 0\.25/);
});

test("the synthetic fixture says so before printing numbers", () => {
	const result = spawnSync(process.execPath, [script, fixture], { encoding: "utf8" });
	assert.equal(result.status, 0);
	assert.match(result.stderr, /synthetic format fixture/);
	assert.match(result.stdout, /pass agreement/);
});

test("a missing report exits non-zero with a message", () => {
	assert.throws(
		() => execFileSync(process.execPath, [script], { encoding: "utf8", stdio: "pipe" }),
		(error) => error.status === 2 && /usage:/.test(String(error.stderr)),
	);
});

test("the fixture is labelled consistently", () => {
	const report = JSON.parse(readFileSync(fixture, "utf8"));
	for (const image of report.images) {
		assert.equal(typeof image.truth.pass, "boolean", `${image.id} has no truth.pass`);
		assert.ok(Array.isArray(image.truth.defects), `${image.id} has no truth.defects`);
	}
	assert.ok(report.images.filter((image) => image.truth.pass).length >= 1);
	assert.ok(report.images.filter((image) => !image.truth.pass).length >= 1);
	assert.equal(report._synthetic, true);
});

// --- the golden set: files, hashes, and a proxy that never reads labels ------
//
// This file must stay importable without a pi-manager-core checkout: CI's
// core-free step runs it with PI_MANAGER_CORE_DIR pointing at a directory that
// does not exist (step 1 of .github/workflows/ci.yml). Loading
// blender/image-probe.ts would drag in blender/workspace.ts -> ../config.js and
// resolve the manager-core package at import time, so every pixel assertion
// lives in test/critic-calibration-pixels.test.mjs, which runs where the core is
// installed. What remains here is JSON, sha256, and the proxy's pure rules.

const { createHash } = await import("node:crypto");
const { existsSync, statSync } = await import("node:fs");
const { calibrate } = await import("../scripts/critic-calibration.mjs");
const { DEFAULT_THRESHOLDS, predictFromMeasurements, reviewManifest } = await import(
	"../scripts/critic-proxy.mjs"
);

const GOLDEN_DIR = fileURLToPath(new URL("fixtures/critic-calibration", import.meta.url));
const GOLDEN_MANIFEST_PATH = join(GOLDEN_DIR, "manifest.json");
const GOLDEN_MANIFEST = JSON.parse(readFileSync(GOLDEN_MANIFEST_PATH, "utf8"));

// The eight filenames the issue decision names, exactly. A rename is a manifest
// change, so the ids and files are asserted together with their labels.
const GOLDEN_CASES = [
	["mug-pass-01", "mug-pass-01.png", true, []],
	["arch-pass-02", "arch-pass-02.png", true, []],
	["character-pass-03", "character-pass-03.png", true, []],
	["defect-collapsed-silhouette", "defect-collapsed-silhouette.png", false, ["collapsed_silhouette"]],
	["defect-missing-handle", "defect-missing-handle.png", false, ["missing_handle"]],
	["defect-wrong-scale", "defect-wrong-scale.png", false, ["wrong_scale"]],
	["defect-flat-material", "defect-flat-material.png", false, ["flat_material"]],
	["defect-clipped-exposure", "defect-clipped-exposure.png", false, ["clipped_exposure"]],
];

test("the golden set ships every render the decision names, with its label", () => {
	assert.equal(GOLDEN_MANIFEST.images.length, GOLDEN_CASES.length);
	for (const [id, file, pass, defects] of GOLDEN_CASES) {
		const image = GOLDEN_MANIFEST.images.find((candidate) => candidate.id === id);
		assert.ok(image, `${id} is missing from the manifest`);
		assert.equal(image.file, `images/${file}`);
		assert.equal(image.truth.pass, pass, `${id} pass label`);
		assert.deepEqual(image.truth.defects, defects, `${id} defect labels`);
		const path = join(GOLDEN_DIR, "images", file);
		assert.ok(existsSync(path), `${path} is missing; regenerate with the bridge's blender/generate-calibration-fixtures.py`);
		assert.ok(statSync(path).size > 1024, `${file} is suspiciously small`);
		assert.equal(statSync(path).size, image.bytes, `${file} size does not match the manifest`);
	}
});

test("the golden set stays inside the committed size budget", () => {
	const bytes = GOLDEN_MANIFEST.images.reduce((total, image) => total + image.bytes, 0);
	assert.ok(bytes < 500 * 1024, `renders total ${bytes} bytes, budget is 500 KB`);
	assert.ok(bytes > 0);
});

test("every golden render matches the sha256 recorded in the manifest", () => {
	for (const image of GOLDEN_MANIFEST.images) {
		const digest = createHash("sha256").update(readFileSync(join(GOLDEN_DIR, image.file))).digest("hex");
		assert.equal(digest, image.sha256, `${image.file} changed but the manifest was not regenerated`);
	}
});

test("the manifest records the thresholds the proxy actually applies", () => {
	assert.deepEqual(GOLDEN_MANIFEST.thresholds, DEFAULT_THRESHOLDS);
	assert.ok(GOLDEN_MANIFEST.provenance.length > 0);
	assert.ok(GOLDEN_MANIFEST.license.length > 0);
	assert.ok(GOLDEN_MANIFEST.render.resolution[0] > 0 && GOLDEN_MANIFEST.render.resolution[1] > 0);
	for (const image of GOLDEN_MANIFEST.images) {
		assert.ok(image.reference == null || GOLDEN_MANIFEST.images.some((i) => i.id === image.reference));
	}
});

test("calibrate reports axis error, per-defect recall, agreement and false passes", () => {
	// Three hand-checkable cases: one clean pass, one defect the proxy found, and
	// one defect it missed. The missed case is what proves per-defect recall can
	// fall below 1 and that a silently passed failure reaches falsePass.
	const report = {
		images: [
			{ id: "clean", truth: { pass: true, defects: [], expectedAxes: { materials: 2 } } },
			{
				id: "flat",
				truth: { pass: false, defects: ["flat_material", "wrong_scale"], expectedAxes: { materials: 0, accuracy: 0 } },
			},
			{ id: "seam", truth: { pass: false, defects: ["seam"] } },
		],
		reviews: [
			{ id: "clean", run: 0, pass: true, defects: [], axes: { accuracy: 2, geometry: 2, materials: 2, completeness: 2, quality: 2, validity: 2 } },
			{ id: "flat", run: 0, pass: false, defects: ["flat_material"], axes: { accuracy: 1, geometry: 2, materials: 1, completeness: 2, quality: 2, validity: 2 } },
			{ id: "seam", run: 0, pass: true, defects: [], axes: { accuracy: 2, geometry: 2, materials: 2, completeness: 2, quality: 2, validity: 2 } },
		],
	};
	const result = calibrate(report);
	assert.equal(result.perDefectRecall.overall, 0.3333);
	assert.equal(result.perDefectRecall.byDefect.flat_material.recall, 1);
	assert.equal(result.perDefectRecall.byDefect.wrong_scale.recall, 0);
	assert.equal(result.perDefectRecall.byDefect.seam.recall, 0);
	assert.deepEqual(result.perDefectRecall.missed, ["seam", "wrong_scale"]);
	assert.equal(result.pass.agreement, 0.6667);
	assert.equal(result.falsePass.rate, 0.5);
	// materials: clean |2-2|=0 and flat |1-0|=1 -> MAE 0.5; accuracy: flat |1-0|=1.
	assert.equal(result.perAxisError.byAxis.materials, 0.5);
	assert.equal(result.perAxisError.byAxis.accuracy, 1);
	assert.equal(result.perAxisError.mean, 0.6667);
	assert.equal(result.perAxisError.checks, 3);
});

test("the proxy predicts the same thing whatever the labels say", async () => {
	// A stub probe stands in for the pixel measurements: a chromatic subject that
	// is not clipped must read as a pass, and the same silhouette blown out to
	// white must read as clipped_exposure. The labels below are then swapped, and
	// the predictions have to be byte-identical, because the labels are what the
	// proxy is being graded against, never what it reads.
	const stub = (colour, clippedShare) => {
		const width = 40;
		const height = 30;
		const bounds = { x0: 8, x1: 30, y0: 10, y1: 25 };
		const pixels = new Uint8Array(width * height * 4);
		for (let y = bounds.y0; y <= bounds.y1; y += 1) {
			for (let x = bounds.x0; x <= bounds.x1; x += 1) {
				const offset = (y * width + x) * 4;
				pixels[offset] = colour[0];
				pixels[offset + 1] = colour[1];
				pixels[offset + 2] = colour[2];
				pixels[offset + 3] = 255;
			}
		}
		const hex = `#${colour.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
		const area = (bounds.x1 - bounds.x0 + 1) * (bounds.y1 - bounds.y0 + 1);
		return {
			probe: {
				subjectCoverage: area / (width * height),
				subjectBounds: bounds,
				exposure: { clippedHigh: { all: clippedShare } },
				palette: [{ hex, fraction: 1 }],
			},
			image: { width, height, pixels },
		};
	};
	const measurements = {
		"mug.png": stub([200, 120, 60], 0),
		"blown.png": stub([255, 255, 255], 0.9),
	};
	const probeImage = async (path) => measurements[path.split("/").pop()];
	const manifestWith = (truthFor) => ({
		images: [
			{ id: "mug", file: "mug.png", truth: truthFor("mug") },
			{ id: "blown", file: "blown.png", truth: truthFor("blown") },
		],
	});
	const labels = { mug: { pass: true, defects: [] }, blown: { pass: false, defects: ["clipped_exposure"] } };
	const correct = await reviewManifest(manifestWith((id) => labels[id]), probeImage);
	assert.deepEqual(
		correct.map((review) => [review.id, review.pass, review.defects]),
		[
			["mug", true, []],
			["blown", false, ["clipped_exposure"]],
		],
	);
	const swapped = { mug: { pass: false, defects: ["clipped_exposure"] }, blown: { pass: true, defects: [] } };
	const blind = await reviewManifest(manifestWith((id) => swapped[id]), probeImage);
	assert.deepEqual(blind, correct);
});

test("predictFromMeasurements can miss, so recall is a measurement and not a constant", () => {
	// One measurement per defect family, taken from the shape of the golden
	// renders, then the thresholds are deliberately pushed past what the pixels
	// contain. If the rules read the labels instead of the measurements, the
	// misses below would be impossible.
	const measurements = [
		["clipped", { probe: { exposure: { clippedHigh: { all: 0.9 } }, palette: [{ hex: "#ffffff", fraction: 1 }] }, silhouette: { width: 10, height: 10, pixels: 1 } }],
		["flat", { probe: { exposure: { clippedHigh: { all: 0 } }, palette: [{ hex: "#bbbbbb", fraction: 1 }] }, silhouette: { width: 10, height: 10, pixels: 1 } }],
		[
			"missing-handle",
			{
				probe: { exposure: { clippedHigh: { all: 0 } }, palette: [{ hex: "#ee9966", fraction: 1 }] },
				silhouette: { width: 10, height: 10, pixels: 1 },
				diff: { missingFraction: 0.17, areaRatio: 0.83, heightRatio: 1, widthRatio: 0.66, lateral: true },
			},
		],
	];
	const found = measurements.map(([id, measured]) => [id, predictFromMeasurements(measured, DEFAULT_THRESHOLDS).defects]);
	assert.deepEqual(found, [
		["clipped", ["clipped_exposure"]],
		["flat", ["flat_material"]],
		["missing-handle", ["missing_handle"]],
	]);
	const blind = measurements.map(([id, measured]) => [
		id,
		predictFromMeasurements(measured, {
			...DEFAULT_THRESHOLDS,
			clippedShare: 0.99,
			flatNeutralShare: 1.01,
			partialLossShare: 0.9,
		}).defects,
	]);
	assert.deepEqual(blind, [
		["clipped", []],
		["flat", []],
		["missing-handle", []],
	]);
});

test("live mode refuses to invent reviews when no transcript is supplied", () => {
	const script = fileURLToPath(new URL("../scripts/critic-calibration.mjs", import.meta.url));
	const withoutTranscript = spawnSync(process.execPath, [script, GOLDEN_MANIFEST_PATH, "--live"], { encoding: "utf8" });
	assert.equal(withoutTranscript.status, 2);
	assert.match(`${withoutTranscript.stdout}${withoutTranscript.stderr}`, /needs --reviews/);
	const missing = join(GOLDEN_DIR, "does-not-exist.json");
	const absent = spawnSync(process.execPath, [script, GOLDEN_MANIFEST_PATH, "--live", "--reviews", missing], { encoding: "utf8" });
	assert.equal(absent.status, 2);
	assert.match(`${absent.stdout}${absent.stderr}`, /does-not-exist\.json/);
});
