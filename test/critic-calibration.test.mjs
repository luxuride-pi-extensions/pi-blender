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
