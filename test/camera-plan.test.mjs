import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./paths.mjs";

const { mergeCameraPlan, resolveCameraPlan } = await loadTs("../blender/camera-plan.ts");

const profiles = ["prop", "character", "hard_surface", "interior", "print", "paint", "asset_pack"]

function direction(plan, name) {
	const shot = plan.shots.find((entry) => entry.name === name);
	assert.ok(shot, `expected a ${name} shot`);
	return shot.direction;
}

test("every profile expands to a non-empty, inspectable shot list", () => {
	for (const profile of profiles) {
		const plan = resolveCameraPlan({ profile, frontAxis: "-Y" });
		assert.equal(plan.profile, profile);
		assert.ok(plan.shots.length >= 2, `${profile} needs more than one angle`);
		assert.deepEqual(plan.primary, plan.shots[0]);
		for (const shot of plan.shots) {
			assert.equal(Math.hypot(...shot.direction).toFixed(6), "1.000000", `${profile}/${shot.name} direction is unit length`);
		}
	}
});

test("a declared +Y front puts the camera on the opposite side", () => {
	const front = resolveCameraPlan({ profile: "prop", frontAxis: "-Y" });
	const flipped = resolveCameraPlan({ profile: "prop", frontAxis: "+Y" });
	assert.deepEqual(direction(front, "front"), [0, -1, 0]);
	assert.deepEqual(direction(flipped, "front"), [0, 1, 0]);
	assert.equal(direction(flipped, "hero")[1] > 0, true, "hero stays in front of a +Y-facing model");
	assert.equal(direction(flipped, "hero")[0] !== direction(front, "hero")[0], true);
});

test("profiles select the shots each use-case needs", () => {
	assert.deepEqual(
		resolveCameraPlan({ profile: "character" }).shots.map((shot) => shot.name),
		["front", "left", "back", "hero"],
	);
	const print = resolveCameraPlan({ profile: "print" });
	assert.equal(print.shots.every((shot) => shot.orthographic), true);
	assert.equal(print.shots.length, 3);
	const hard = resolveCameraPlan({ profile: "hard_surface" });
	assert.equal(hard.shots.filter((shot) => shot.orthographic).length, 3);
	assert.equal(resolveCameraPlan({ profile: "interior" }).primary.lensMm, 20);
});

test("an explicit shot list overrides the profile without changing the front", () => {
	const plan = resolveCameraPlan({ profile: "character", frontAxis: "+X", shots: ["top", "hero"] });
	assert.deepEqual(plan.shots.map((shot) => shot.name), ["top", "hero"]);
	assert.deepEqual(direction(plan, "top"), [0, 0, 1]);
	assert.deepEqual(direction(plan, "hero").slice(0, 2).map((value) => Math.sign(value)), [1, 1]);
});

test("missing declarations are reported rather than silently guessed", () => {
	const plan = resolveCameraPlan({});
	assert.equal(plan.profile, "prop");
	assert.equal(plan.frontAxis, "-Y");
	assert.equal(plan.warnings.length, 2);
	assert.match(plan.warnings.join(" "), /No frontAxis/);
	assert.equal(resolveCameraPlan({ profile: "prop", frontAxis: "-Y" }).warnings.length, 0);
});

test("unknown profiles and shots are rejected", () => {
	assert.throws(() => resolveCameraPlan({ profile: "spaceship" }), /Unknown camera profile/);
	assert.throws(() => resolveCameraPlan({ profile: "prop", shots: ["closeup"] }), /Unknown camera shot/);
});

test("the frame subject and a lineup distance are carried into the plan", () => {
	const plan = resolveCameraPlan({ profile: "asset_pack", frameSubject: "module", distance: 12.5 });
	assert.equal(plan.frameSubject, "module");
	assert.equal(plan.distance, 12.5);
	assert.equal(plan.primary.name, "lineup_front");
	assert.equal(plan.primary.orthographic, true);
});

test("a new profile re-expands its own shots instead of reusing the old list", () => {
	const previous = resolveCameraPlan({ profile: "prop", frontAxis: "-Y" });
	const interior = mergeCameraPlan({ profile: "interior" }, previous);
	assert.equal(interior.profile, "interior");
	assert.deepEqual(interior.shots.map((shot) => shot.kind), ["interior_hero", "interior_front"]);
	assert.equal(interior.shots[0].lensMm, 20, "the interior profile brings its 20 mm lens");
});

test("omitting the contract reuses the previous plan", () => {
	const previous = resolveCameraPlan({ profile: "character", frontAxis: "+X", frameSubject: "module" });
	const same = mergeCameraPlan({}, previous);
	assert.equal(same.profile, "character");
	assert.equal(same.frontAxis, "+X");
	assert.equal(same.frameSubject, "module");
	assert.deepEqual(same.shots.map((shot) => shot.kind), previous.shots.map((shot) => shot.kind));
});

test("an explicit shot list wins over both the profile and the previous plan", () => {
	const previous = resolveCameraPlan({ profile: "prop", frontAxis: "-Y" });
	const plan = mergeCameraPlan({ shots: ["top", "hero"] }, previous);
	assert.deepEqual(plan.shots.map((shot) => shot.kind), ["top", "hero"]);
	assert.equal(plan.profile, "prop", "the profile still labels the plan it came from");
});

test("an unreadable previous plan warns and falls back instead of throwing", () => {
	const previous = { ...resolveCameraPlan({ profile: "prop" }), shots: [{ kind: "closeup" }] };
	const plan = mergeCameraPlan({}, previous);
	assert.deepEqual(plan.shots.map((shot) => shot.kind), ["hero", "front"]);
	assert.match(plan.warnings.join(" "), /Ignored an unreadable previous camera plan/);
});
