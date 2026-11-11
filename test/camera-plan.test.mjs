import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveCameraPlan } from "../blender/camera-plan.ts";

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
