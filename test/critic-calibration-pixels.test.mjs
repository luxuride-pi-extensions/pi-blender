// Pixel-level calibration for test/fixtures/critic-calibration.
//
// This file imports blender/image-probe.ts, which resolves the manager-core
// package at load time, so it runs in the job that has the core installed. The
// manifest, hash and label-blindness assertions that must hold with no core
// checkout live in test/critic-calibration.test.mjs; CI picks this file up
// automatically in the "rest of the suite" step, so ci.yml needs no edit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadTs } from "./paths.mjs";

const {
	compareSilhouettes,
	DEFAULT_THRESHOLDS,
	neutralShareOfPalette,
	predictFromMeasurements,
	probeFixtureImage,
	reviewManifest,
	scratchWorkspace,
	silhouetteOf,
} = await import("../scripts/critic-proxy.mjs");
const { calibrate } = await import("../scripts/critic-calibration.mjs");

const FIXTURE_DIR = fileURLToPath(new URL("fixtures/critic-calibration", import.meta.url));
const MANIFEST_PATH = join(FIXTURE_DIR, "manifest.json");
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

const workspace = scratchWorkspace();
test.after(() => rmSync(workspace, { recursive: true, force: true }));

const modules = {
	decodePng: (await loadTs("../blender/png.ts")).decodePng,
	blenderImageProbe: (await loadTs("../blender/image-probe.ts")).blenderImageProbe,
	loadWorkspaceManifest: (await loadTs("../blender/workspace.ts")).loadWorkspaceManifest,
	workspace,
};

const measured = new Map();
for (const image of MANIFEST.images) {
	measured.set(image.id, await probeFixtureImage(join(FIXTURE_DIR, image.file), modules));
}

const probeOf = (id) => measured.get(id).probe;
const silhouetteOfId = (id) => silhouetteOf(measured.get(id).image);
const diffAgainst = (id, referenceId) => compareSilhouettes(silhouetteOfId(id), silhouetteOfId(referenceId));
const neutralShareOfId = (id) => neutralShareOfPalette(probeOf(id).palette, DEFAULT_THRESHOLDS.chromaNeutral);

// reviewManifest asks for a file path; the measurements were taken up front, so
// the probe replays them by basename.
function probeForManifest(path) {
	const image = MANIFEST.images.find((candidate) => path.endsWith(candidate.file));
	assert.ok(image, `the proxy asked for ${path}, which is not in the manifest`);
	return measured.get(image.id);
}

function measurementsFor(image) {
	const probe = probeOf(image.id);
	const silhouette = silhouetteOfId(image.id);
	const diff = image.reference ? diffAgainst(image.id, image.reference) : undefined;
	return { probe, silhouette, diff };
}

test("the probe sees every labelled defect in the pixels", () => {
	const [width, height] = MANIFEST.render.resolution;

	// Clean passes: the subject is inside the frame on all four sides, which is
	// what "a whole object, well framed" has to mean for wrong_scale to be
	// measurable at all.
	for (const id of ["mug-pass-01", "arch-pass-02", "character-pass-03"]) {
		const bounds = probeOf(id).subjectBounds;
		assert.ok(bounds.x0 > 0 && bounds.x1 < width - 1, `${id} touches a vertical frame edge`);
		assert.ok(bounds.y0 > 0 && bounds.y1 < height - 1, `${id} touches a horizontal frame edge`);
		assert.ok(neutralShareOfId(id) < DEFAULT_THRESHOLDS.flatNeutralShare, `${id} reads as a flat neutral subject`);
		assert.ok(probeOf(id).exposure.clippedHigh.all < DEFAULT_THRESHOLDS.clippedShare, `${id} reads as clipped`);
	}

	// clipped_exposure: most of the subject is at maximum value.
	assert.ok(probeOf("defect-clipped-exposure").exposure.clippedHigh.all > 0.8);
	// flat_material: the palette is almost entirely grey, top entry included.
	assert.ok(neutralShareOfId("defect-flat-material") > 0.95);
	assert.match(probeOf("defect-flat-material").palette[0].hex, /^#([0-9a-f]{2})\1\1$|^#([0-9a-f]{2})\2$/);
	// The clean mug is chromatic, so the flat test is not just "any dark render".
	assert.ok(neutralShareOfId("mug-pass-01") < 0.05);

	// missing_handle: the handle is gone, and the missing pixels are lateral
	// (outside the body columns) rather than a uniformly smaller mug.
	const handle = diffAgainst("defect-missing-handle", "mug-pass-01");
	assert.ok(handle.missingFraction > 0.1, "no pixels went missing when the handle was removed");
	assert.equal(handle.lateral, true);
	assert.ok(handle.widthRatio < 0.8);

	// collapsed_silhouette: the figure is squashed onto the ground plane.
	const collapsed = diffAgainst("defect-collapsed-silhouette", "character-pass-03");
	assert.ok(collapsed.areaRatio < 0.1, "the collapsed figure still covers the standing figure's area");
	assert.ok(collapsed.heightRatio < 0.1);
	assert.equal(collapsed.extraFraction < 0.1, true);

	// wrong_scale: the stretched figure runs off both vertical edges at once.
	const stretched = probeOf("defect-wrong-scale").subjectBounds;
	assert.equal(stretched.x0, 0);
	assert.equal(stretched.x1, width - 1);
	assert.ok(probeOf("defect-wrong-scale").subjectCoverage > DEFAULT_THRESHOLDS.frameBleedCoverage);
});

test("the proxy scores this set from pixels alone: every labelled defect is found", async () => {
	const reviews = await reviewManifest(MANIFEST, probeForManifest);
	const result = calibrate({ images: MANIFEST.images, reviews });
	assert.equal(result.perDefectRecall.overall, 1);
	for (const [name, entry] of Object.entries(result.perDefectRecall.byDefect)) {
		assert.equal(entry.recall, 1, `${name} was not recalled`);
	}
	assert.equal(result.pass.agreement, 1);
	assert.equal(result.falsePass.rate, 0);
	assert.equal(result.perAxisError.mean, 0);
	assert.equal(result.perAxisError.checks, 7);
});

test("the proxy does not read the labels it is graded against", async () => {
	const stripped = {
		...MANIFEST,
		images: MANIFEST.images.map((image) => ({ ...image, truth: { pass: !image.truth.pass, defects: [] } })),
	};
	const predictions = (manifest) =>
		reviewManifest(manifest, probeForManifest).then((reviews) =>
			reviews.map((review) => ({ id: review.id, pass: review.pass, defects: review.defects, axes: review.axes })),
		);
	assert.deepEqual(await predictions(stripped), await predictions(MANIFEST));
});

test("mutated thresholds make the same eight renders miss, so recall is live", () => {
	const scores = (thresholds) =>
		calibrate({
			images: MANIFEST.images,
			reviews: MANIFEST.images.map((image) => {
				const prediction = predictFromMeasurements(measurementsFor(image), thresholds);
				return { id: image.id, run: 0, ...prediction };
			}),
		});

	// A threshold just above the measured flat share hides exactly one defect.
	const oneMiss = scores({ ...DEFAULT_THRESHOLDS, flatNeutralShare: 0.999 });
	assert.equal(oneMiss.perDefectRecall.overall, 0.8);
	assert.equal(oneMiss.perDefectRecall.byDefect.flat_material.recall, 0);
	assert.deepEqual(oneMiss.perDefectRecall.missed, ["flat_material"]);
	assert.equal(oneMiss.pass.agreement, 0.875);

	// Thresholds no pixel in the set can reach hide all five, and the five
	// labelled failures then score as false passes.
	const allMiss = scores({
		...DEFAULT_THRESHOLDS,
		clippedShare: 0.99,
		flatNeutralShare: 0.999,
		partialLossShare: 0.9,
		collapsedAreaShare: 0.001,
		collapsedHeightShare: 0.001,
		frameBleedCoverage: 0.99,
	});
	assert.equal(allMiss.perDefectRecall.overall, 0);
	assert.equal(allMiss.falsePass.rate, 1);
	assert.equal(allMiss.pass.agreement, 0.375);

	// And the other direction: a loose flat threshold invents a material defect
	// on the clean blockout figure, which is what a false positive looks like.
	const noisy = scores({ ...DEFAULT_THRESHOLDS, flatNeutralShare: 0.3 });
	assert.equal(noisy.pass.agreement, 0.875);
	assert.equal(noisy.spurious.flat_material, 1);
	assert.equal(noisy.perDefectRecall.overall, 1);
});

test("the CLI measures the shipped manifest in proxy mode", () => {
	const result = execFileSync(
		process.execPath,
		[fileURLToPath(new URL("../scripts/critic-calibration.mjs", import.meta.url)), MANIFEST_PATH, "--json"],
		{ encoding: "utf8" },
	);
	const report = JSON.parse(result);
	assert.equal(report.pass.agreement, 1);
	assert.equal(report.perDefectRecall.overall, 1);
	assert.equal(report.falsePass.rate, 0);
	assert.equal(report.perAxisError.mean, 0);
	assert.equal(report.reviews, MANIFEST.images.length);
});
