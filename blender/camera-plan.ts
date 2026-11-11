import type { CameraFrontAxis, CameraProfile, CameraShotKind, ResolvedCameraPlan } from "./types.js";

/**
 * The front is a declaration, not an inference.
 *
 * Geometry cannot tell a face from a back panel, and a reference can only
 * suggest it. Guessing would invert every shot on a model built facing +Y, so
 * the caller states the axis and the plan derives every direction from it.
 */
const FRONT_VECTORS = {
	"-Y": [0, -1, 0],
	"+Y": [0, 1, 0],
	"-X": [-1, 0, 0],
	"+X": [1, 0, 0],
} satisfies Record<CameraFrontAxis, [number, number, number]>;

const SHOT_LENS = {
	hero: 50,
	front: 50,
	back: 50,
	left: 50,
	right: 50,
	top: 50,
	ortho_front: 50,
	ortho_side: 50,
	ortho_top: 50,
	interior_hero: 20,
	interior_front: 20,
	lineup_front: 50,
} satisfies Partial<Record<CameraShotKind, number>>;

const PROFILE_SHOTS = {
	prop: ["hero", "front"],
	character: ["front", "left", "back", "hero"],
	hard_surface: ["hero", "ortho_front", "ortho_side", "ortho_top"],
	interior: ["interior_hero", "interior_front"],
	print: ["ortho_front", "ortho_side", "ortho_top"],
	paint: ["hero", "front"],
	asset_pack: ["lineup_front", "hero"],
} satisfies Record<CameraProfile, CameraShotKind[]>;

const ORTHOGRAPHIC = new Set<CameraShotKind>(["ortho_front", "ortho_side", "ortho_top", "lineup_front"]);

function cross(a: [number, number, number], b: [number, number, number]): [number, number, number] {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: [number, number, number]): [number, number, number] {
	const length = Math.hypot(v[0], v[1], v[2]);
	if (length < 1e-9) return [0, 0, 1];
	return [v[0] / length, v[1] / length, v[2] / length];
}

function shotDirection(kind: CameraShotKind, frontAxis: CameraFrontAxis): [number, number, number] {
	// The camera sits on this side of the subject, looking back at it.
	const front = FRONT_VECTORS[frontAxis] ?? FRONT_VECTORS["-Y"];
	const opposite = [-front[0], -front[1], -front[2]] as [number, number, number];
	const right = normalize(cross([0, 0, 1], front));
	// Hero is front-left-above: the camera is in front of the subject, offset
	// toward its left and raised. Deriving it from `right` keeps it on the same
	// side for every declared front instead of mirroring a fixed world vector.
	const heroDirection = normalize([
		front[0] + right[0] * 0.85,
		front[1] + right[1] * 0.85,
		front[2] + right[2] * 0.85 + 0.55,
	]);
	switch (kind) {
		case "front":
		case "ortho_front":
		case "lineup_front":
		case "interior_front":
			return front;
		case "back":
			return opposite;
		case "left":
			return normalize([-right[0], -right[1], -right[2]]);
		case "right":
			return right;
		case "top":
		case "ortho_top":
			return [0, 0, 1];
		case "ortho_side":
			return right;
		case "interior_hero":
		case "hero":
			return heroDirection;
		default:
			return [0, 0, 1];
	}
}

/**
 * Expand a profile into explicit, inspectable shots.
 *
 * Only the first shot is rendered by the branch run today; the rest are the
 * contract a review sheet consumes. Generating them anyway makes the plan
 * reviewable and keeps the profile decision out of the renderer.
 */
type CameraPlanOptions = {
	profile?: CameraProfile;
	frontAxis?: CameraFrontAxis;
	shots?: CameraShotKind[];
	frameSubject?: "module" | "apply";
	distance?: number;
};

/**
 * Merge this run's declaration over the plan the module used last time.
 *
 * A profile or an explicit shot list is a NEW declaration and must re-expand
 * the defaults; only an omitted contract is the "same camera" case. A previous
 * plan read from a manifest is untrusted input: one hand edit or a newer writer
 * must not make every later run of that module throw, so an unreadable plan is
 * ignored with a warning rather than partially applied.
 */
export function mergeCameraPlan(
	options: CameraPlanOptions,
	previous: ResolvedCameraPlan | undefined,
): ResolvedCameraPlan {
	const usable = sanitizePrevious(previous);
	const plan = resolveCameraPlan({
		profile: options.profile ?? usable?.profile,
		frontAxis: options.frontAxis ?? usable?.frontAxis,
		shots:
			options.shots ??
			(options.profile ? undefined : usable?.shots.map((shot) => shot.kind)),
		frameSubject: options.frameSubject ?? usable?.frameSubject,
		distance: options.distance ?? usable?.distance,
	});
	if (previous && !usable) {
		return { ...plan, warnings: [...plan.warnings, "Ignored an unreadable previous camera plan."] };
	}
	return plan;
}

function sanitizePrevious(previous: ResolvedCameraPlan | undefined): ResolvedCameraPlan | undefined {
	if (!previous || typeof previous !== "object") return undefined;
	if (!Object.hasOwn(PROFILE_SHOTS, previous.profile)) return undefined;
	if (!Object.hasOwn(FRONT_VECTORS, previous.frontAxis)) return undefined;
	if (previous.frameSubject !== "module" && previous.frameSubject !== "apply") return undefined;
	if (!Array.isArray(previous.shots) || previous.shots.length === 0) return undefined;
	if (!previous.shots.every((shot) => shot && typeof shot === "object" && Object.hasOwn(SHOT_LENS, shot.kind))) {
		return undefined;
	}
	if (previous.distance !== undefined && !Number.isFinite(previous.distance)) return undefined;
	return previous;
}

export function resolveCameraPlan(options: CameraPlanOptions): ResolvedCameraPlan {
	const profile = options.profile ?? "prop";
	const frontAxis = options.frontAxis ?? "-Y";
	const warnings: string[] = [];
	if (!options.profile) warnings.push('No camera profile given; using "prop".');
	if (!options.frontAxis) warnings.push('No frontAxis given; assuming "-Y". Declare it in the brief.');
	if (options.profile && !Object.hasOwn(PROFILE_SHOTS, options.profile)) {
		throw new Error(`Unknown camera profile: ${options.profile}`);
	}
	const kinds = options.shots?.length ? options.shots : PROFILE_SHOTS[profile];
	const shots = kinds.map((kind) => {
		if (!Object.hasOwn(SHOT_LENS, kind)) throw new Error(`Unknown camera shot: ${kind}`);
		return {
			name: kind,
			kind,
			direction: shotDirection(kind, frontAxis),
			lensMm: SHOT_LENS[kind] ?? 50,
			orthographic: ORTHOGRAPHIC.has(kind),
		};
	});
	const primary = shots[0];
	if (!primary) throw new Error("A camera plan needs at least one shot.");
	return {
		profile,
		frontAxis,
		frameSubject: options.frameSubject ?? "apply",
		shots,
		primary,
		distance: options.distance,
		warnings,
	};
}
