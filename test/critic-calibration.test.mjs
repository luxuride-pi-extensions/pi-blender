import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

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

// --- the golden set of real renders ------------------------------------------
//
// The synthetic fixture above checks the arithmetic of the report format. The
// set below is the evidence: eight renders that exist on disk, labelled, and a
// proxy that has to reproduce the labels from measurements alone. The proxy is
// run twice — once against the labelled manifest and once against a copy with
// every label deleted — and the two review sets have to be identical, because a
// proxy that reads the labels it scores would otherwise report a perfect
// calibration and measure nothing.

const { createHash } = await import("node:crypto");
const { existsSync, mkdtempSync, statSync, writeFileSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const { blenderImageProbe } = await loadTs("../blender/image-probe.ts");
const { decodePng } = await loadTs("../blender/png.ts");
const { loadWorkspaceManifest } = await loadTs("../blender/workspace.ts");
const { DEFAULT_THRESHOLDS, compareSilhouettes, neutralShareOfPalette, probeFixtureImage, scratchWorkspace, silhouetteOf } =
	await import("../scripts/critic-proxy.mjs");
const { calibrate, reportFromProxy } = await import("../scripts/critic-calibration.mjs");

const goldenDir = join(root, "test/fixtures/critic-calibration");
const goldenManifestPath = join(goldenDir, "manifest.json");
const goldenManifest = JSON.parse(readFileSync(goldenManifestPath, "utf8"));

/** Exactly the cases the calibration decision lists, and no others. */
const GOLDEN_CASES = [
	"mug-pass-01",
	"arch-pass-02",
	"character-pass-03",
	"defect-collapsed-silhouette",
	"defect-missing-handle",
	"defect-wrong-scale",
	"defect-flat-material",
	"defect-clipped-exposure",
];

const goldenWorkspace = scratchWorkspace();
const measurers = { decodePng, blenderImageProbe, loadWorkspaceManifest, workspace: goldenWorkspace };
const measurements = new Map();

/** Probe one fixture image once, and share it between the tests below. */
function measure(id) {
	if (!measurements.has(id)) {
		const image = goldenManifest.images.find((entry) => entry.id === id);
		if (!image) throw new Error(`no fixture image named ${id}`);
		measurements.set(id, probeFixtureImage(join(goldenDir, image.file), measurers));
	}
	return measurements.get(id);
}

/** One proxy run over the whole set, shared by the assertions that score it. */
const proxyReport = reportFromProxy(goldenManifest, {
	manifestPath: goldenManifestPath,
	modules: { decodePng, blenderImageProbe, loadWorkspaceManifest },
	workspace: scratchWorkspace(),
	directory: goldenDir,
});

test("the golden set ships every render the calibration decision names", () => {
	assert.deepEqual(
		goldenManifest.images.map((image) => image.id).sort(),
		[...GOLDEN_CASES].sort(),
	);
	let totalBytes = 0;
	for (const image of goldenManifest.images) {
		const path = join(goldenDir, image.file);
		assert.ok(existsSync(path), `${image.id} is named in the manifest but ${image.file} is missing`);
		const { size } = statSync(path);
		assert.equal(size, image.bytes, `${image.id} is ${size} bytes, the manifest says ${image.bytes}`);
		totalBytes += size;
	}
	assert.ok(totalBytes < 500 * 1024, `the set is ${totalBytes} bytes, over the 500 KB budget`);
});

test("every render matches the hash recorded in the manifest", () => {
	for (const image of goldenManifest.images) {
		const digest = createHash("sha256").update(readFileSync(join(goldenDir, image.file))).digest("hex");
		assert.equal(digest, image.sha256, `${image.id} does not match its recorded sha256; regenerate or update the manifest`);
	}
});

test("the manifest thresholds are the ones the proxy applies", () => {
	// A threshold that lives only in code cannot be reviewed beside the labels
	// it produces, and a copy that drifts is worse than no copy.
	assert.deepEqual(goldenManifest.thresholds, { ...DEFAULT_THRESHOLDS });
});

test("the proxy predicts from pixels, not from the labels it is scored on", async () => {
	const labelled = await proxyReport;
	const unlabelled = await reportFromProxy(
		{
			...goldenManifest,
			// Strip the labels: the proxy must not be able to read what it is scored on.
			images: goldenManifest.images.map((image) => Object.fromEntries(Object.entries(image).filter(([key]) => key !== "truth"))),
		},
		{
			manifestPath: goldenManifestPath,
			modules: { decodePng, blenderImageProbe, loadWorkspaceManifest },
			workspace: scratchWorkspace(),
			directory: goldenDir,
		},
	);
	const predictions = (report) =>
		report.reviews.map(({ id, pass, defects, axes }) => ({ id, pass, defects, axes }));
	assert.deepEqual(predictions(unlabelled), predictions(labelled));
	assert.equal(unlabelled.images.some((image) => "truth" in image), false);
});

test("the proxy does not call the clean renders defective", async () => {
	const report = await proxyReport;
	const clean = report.images.filter((image) => image.truth.pass);
	assert.ok(clean.length >= 3, "the set needs clean renders to measure false positives");
	for (const image of clean) {
		const review = report.reviews.find((entry) => entry.id === image.id);
		assert.equal(review.pass, true, `${image.id} is clean but was called defective`);
		assert.deepEqual(review.defects, [], `${image.id} is clean but was given defects`);
	}
});

test("the proxy predicts each labelled defect under its own name", async () => {
	const result = calibrate(await proxyReport);
	assert.equal(result.images, GOLDEN_CASES.length);
	assert.equal(result.perDefectRecall.overall, 1);
	for (const defect of ["collapsed_silhouette", "missing_handle", "wrong_scale", "flat_material", "clipped_exposure"]) {
		assert.equal(result.perDefectRecall.byDefect[defect]?.recall, 1, `${defect} was not detected`);
		assert.ok(result.perDefectRecall.byDefect[defect].checks >= 1);
	}
	// A single overall recall would still be 1 if one defect were found on every
	// image, so the per-name split above and the empty miss list both matter.
	assert.deepEqual(result.perDefectRecall.missed, []);
	assert.equal(result.falsePass.rate, 0, "a defective render was reported as good");
	assert.equal(result.pass.agreement, 1);
	assert.equal(result.perAxisError.mean, 0, "a predicted axis disagrees with the label");
	assert.ok(result.perAxisError.checks >= 5, "the labels expect more than one axis to be scored");
});

test("each labelled defect is visible in its own pixels", async () => {
	// The labels have to be true of the images, not merely agreed with by the
	// proxy: these assertions read the same measurements the proxy reads and
	// check the defect is actually there.
	const mug = await measure("mug-pass-01");
	const arch = await measure("arch-pass-02");
	const character = await measure("character-pass-03");

	for (const clean of [mug, arch, character]) {
		assert.ok(
			clean.probe.exposure.clippedHigh.all < DEFAULT_THRESHOLDS.clippedShare,
			`${clean.probe.path} is clipped`,
		);
		assert.ok(
			neutralShareOfPalette(clean.probe.palette, DEFAULT_THRESHOLDS.chromaNeutral) < 0.5,
			`${clean.probe.path} has no colour to lose`,
		);
		assert.ok(
			clean.probe.subjectBounds.x0 > 0 && clean.probe.subjectBounds.x1 < clean.probe.width - 1,
			`${clean.probe.path} touches a vertical frame edge`,
		);
	}

	const flat = await measure("defect-flat-material");
	assert.ok(
		neutralShareOfPalette(flat.probe.palette, DEFAULT_THRESHOLDS.chromaNeutral) >= DEFAULT_THRESHOLDS.flatNeutralShare,
		"the flat-material render still carries colour",
	);
	assert.deepEqual(flat.probe.exposure.clippedHigh.all, 0, "the flat-material render is blown out instead");

	const clipped = await measure("defect-clipped-exposure");
	assert.ok(clipped.probe.exposure.clippedHigh.all >= DEFAULT_THRESHOLDS.clippedShare);
	assert.ok(clipped.probe.exposure.clippedHigh.all > mug.probe.exposure.clippedHigh.all);

	const collapse = compareSilhouettes(
		silhouetteOf((await measure("defect-collapsed-silhouette")).image),
		silhouetteOf(character.image),
	);
	assert.ok(collapse.areaRatio < 0.1, `the collapsed render kept ${collapse.areaRatio} of the figure's area`);
	assert.ok(collapse.heightRatio < 0.1, `the collapsed render kept ${collapse.heightRatio} of the figure's height`);

	const loss = compareSilhouettes(silhouetteOf((await measure("defect-missing-handle")).image), silhouetteOf(mug.image));
	assert.ok(loss.missingFraction > 0.1, "deleting the handle changed almost nothing");
	assert.equal(loss.lateral, true, "the lost pixels are inside the body, not a protrusion");
	assert.ok(loss.widthRatio < 0.8, "the silhouette is not narrower without the handle");

	const scaled = await measure("defect-wrong-scale");
	assert.equal(scaled.probe.subjectBounds.x0, 0);
	assert.equal(scaled.probe.subjectBounds.x1, scaled.probe.width - 1);
	assert.ok(scaled.probe.subjectCoverage >= DEFAULT_THRESHOLDS.frameBleedCoverage);
});

test("the CLI scores the golden set in proxy mode by default", () => {
	const result = spawnSync(process.execPath, [script, goldenManifestPath, "--json"], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.equal(report.images, GOLDEN_CASES.length);
	assert.equal(report.reviews, GOLDEN_CASES.length);
	assert.equal(report.perDefectRecall.overall, 1);
	assert.equal(report.falsePass.rate, 0);
	assert.equal(typeof report.perAxisError.mean, "number");
});

test("live mode needs a transcript instead of inventing verdicts", () => {
	const missing = spawnSync(process.execPath, [script, goldenManifestPath, "--live"], { encoding: "utf8" });
	assert.equal(missing.status, 2);
	assert.match(missing.stderr, /--live needs --reviews/);

	const dir = mkdtempSync(join(tmpdir(), "critic-live-"));
	const empty = join(dir, "reviews.json");
	writeFileSync(empty, JSON.stringify({ reviews: [] }), "utf-8");
	const refused = spawnSync(process.execPath, [script, goldenManifestPath, "--live", "--reviews", empty], {
		encoding: "utf8",
	});
	assert.equal(refused.status, 2);
	assert.match(refused.stderr, /reviews\[\] array/);
});
