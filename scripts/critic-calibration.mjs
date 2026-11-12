#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AXES = ["accuracy", "geometry", "materials", "completeness", "quality", "validity"];

function mean(values) {
	return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values) {
	if (values.length < 2) return 0;
	const average = mean(values);
	return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function round(value, digits = 4) {
	return value === null ? null : Number(value.toFixed(digits));
}

export function calibrate(report) {
	if (!report || typeof report !== "object" || !Array.isArray(report.images) || !Array.isArray(report.reviews)) {
		throw new Error("calibration report must be an object with images[] and reviews[] arrays");
	}
	for (const image of report.images) {
		if (!image || typeof image.id !== "string" || !image.truth || typeof image.truth.pass !== "boolean" || !Array.isArray(image.truth.defects)) {
			throw new Error(`image ${image?.id ?? "(no id)"} needs a truth.pass boolean and a truth.defects array`);
		}
	}
	const images = new Map(report.images.map((image) => [image.id, image]));
	const reviews = (report.reviews ?? []).filter((review) => images.has(review.id));
	const byImage = new Map();
	for (const review of reviews) {
		const list = byImage.get(review.id) ?? [];
		list.push(review);
		byImage.set(review.id, list);
	}

	const axes = {};
	for (const axis of AXES) {
		const means = [];
		const spreads = [];
		for (const list of byImage.values()) {
			const scores = list.map((review) => review.axes?.[axis]).filter((score) => typeof score === "number");
			const average = mean(scores);
			if (average === null) continue;
			means.push(average);
			spreads.push(stddev(scores));
		}
		const meanSquare = mean(spreads.map((value) => value ** 2));
		axes[axis] = {
			images: means.length,
			mean: round(mean(means), 2),
			variance: round(meanSquare),
			stddev: round(meanSquare === null ? null : Math.sqrt(meanSquare)),
		};
	}

	let passChecks = 0;
	let passAgreements = 0;
	let truthFailures = 0;
	let falsePasses = 0;
	let defectChecks = 0;
	let defectHits = 0;
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
				defectChecks += 1;
				if (reported.has(defect)) defectHits += 1;
			}
		}
	}

	return {
		images: images.size,
		reviews: reviews.length,
		axes,
		pass: {
			checks: passChecks,
			agreement: round(passChecks === 0 ? null : passAgreements / passChecks),
		},
		defects: {
			checks: defectChecks,
			recall: round(defectChecks === 0 ? null : defectHits / defectChecks),
		},
		falsePass: {
			failures: truthFailures,
			rate: round(truthFailures === 0 ? null : falsePasses / truthFailures),
		},
	};
}

function main() {
	const path = process.argv[2];
	if (!path) {
		console.error("usage: node scripts/critic-calibration.mjs <report.json> [--json]");
		process.exit(2);
	}
	let result;
	try {
		const report = JSON.parse(readFileSync(resolve(path), "utf8"));
		if (report?._synthetic) {
			console.error("synthetic format fixture — arithmetic only, not calibration evidence");
		}
		result = calibrate(report);
	} catch (error) {
		console.error(`could not read the calibration report at ${path}: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
	if (process.argv.includes("--json")) {
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}
	console.log(`images ${result.images}, reviews ${result.reviews}`);
	console.log("axis        stddev  variance  mean");
	for (const [axis, stats] of Object.entries(result.axes)) {
		console.log(`${axis.padEnd(12)} ${String(stats.stddev).padStart(6)}  ${String(stats.variance).padStart(8)}  ${String(stats.mean).padStart(4)}`);
	}
	console.log(`pass agreement ${result.pass.agreement ?? "n/a"} (${result.pass.checks} checks)`);
	console.log(`defect recall ${result.defects.recall ?? "n/a"} (${result.defects.checks} checks)`);
	console.log(`false-pass rate ${result.falsePass.rate ?? "n/a"} (${result.falsePass.failures} failure reviews)`);
}

function isMain() {
	try {
		return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isMain()) main();
