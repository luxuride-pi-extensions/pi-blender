export interface BlenderSavedView {
	name: string;
	cameraObjectName: string;
	cameraSettingsName?: string;
	cameraName?: string;
	source: string;
	savedAt: string;
}

/**
 * A reference image tracked inside a workspace.
 *
 * References used to be bare path strings carried in briefs, which meant they
 * were invisible to the extension: nothing listed them, nothing broke when the
 * file moved, and a critic could be pointed at a path that no longer existed.
 * Copying the file into `<workspace>/references/` and recording it here makes
 * the pairing auditable and keeps the workspace self-contained.
 */
export interface BlenderReference {
	/** Stable id used in briefs, e.g. `front`, `three-quarter`. */
	id: string;
	/** Absolute path to the copy inside the workspace. */
	path: string;
	/** Original path the file was added from, kept for provenance. */
	sourcePath: string;
	/** What the image depicts. Required — the manager cannot see images. */
	caption: string;
	/**
	 * View this reference is meant to be compared against, when known. A critic
	 * pair is (view, reference); this is the manager's stated hypothesis about
	 * which half needs to change.
	 */
	suggestedView?: string;
	addedAt: string;
}

export interface AddReferenceOptions {
	cwd: string;
	workspace: string;
	/** Path to an existing image file on disk. Copied into the workspace. */
	path: string;
	/** Stable id to address it by in briefs. Defaults to the file's stem. */
	id?: string;
	/** What the image depicts. Required, because the manager cannot see it. */
	caption: string;
	suggestedView?: string;
	signal?: AbortSignal;
}

export interface AddReferenceResult {
	workspacePath: string;
	manifestPath: string;
	referencesDir: string;
	reference: BlenderReference;
	/** Every reference now in the workspace, so the manager can see the set. */
	references: BlenderReference[];
}

export type BlenderSessionContextCategory = "file" | "scene" | "selection" | "mode" | "viewport";

export interface BlenderSessionObjectRef {
	name: string;
	type: string;
}

export interface BlenderSessionFileContext {
	blendPath: string | null;
	isSaved: boolean;
	isDirty: boolean;
}

export interface BlenderSessionSceneContext {
	name: string | null;
	availableScenes: string[];
	frameCurrent: number | null;
	activeCameraName: string | null;
}

export interface BlenderSessionSelectionContext {
	activeObject: BlenderSessionObjectRef | null;
	selectedObjects: BlenderSessionObjectRef[];
	selectedObjectCount: number;
}

export interface BlenderSessionModeContext {
	mode: string | null;
	activeObjectType: string | null;
}

export interface BlenderSessionViewportContext {
	hasViewport: boolean;
	areaSize: number | null;
	viewPerspective: string | null;
	shadingType: string | null;
	cameraName: string | null;
	isCameraView: boolean;
}

export interface BlenderRenderOutput {
	path: string;
	view: string;
	iteration: number;
	createdAt: string;
	/** Set when the render came from blender_module_run rather than blender_render. */
	module?: string;
}

/**
 * Order-aware record of every module run. `checkpointPath` is the blend state
 * captured immediately BEFORE that specific run, so reverting is exact rather
 * than "undo the module's most recent run".
 */
export interface BlenderModuleRunRecord {
	name: string;
	iteration: number;
	checkpointPath: string;
	at: string;
	/** Monotonic sequence shared by every module run, used to detect a stale revert. */
	sequence: number;
	exitCode: number;
	status: "ok" | "failed";
}

/**
 * Which pi instance claimed a workspace.
 *
 * Written by blender_workspace_init so a second instance knows the blend is
 * already being driven elsewhere. Advisory rather than authoritative: the
 * liveness check in blender/ownership.ts decides whether the claim still means
 * anything, because a claim left by a process that has since exited must never
 * lock anyone out of their own workspace.
 */
export interface WorkspaceOwner {
	/** Per-process random id, matching the bridge dir name. See config.ts. */
	instanceId: string;
	pid: number;
	/** The blend this instance opened, so a mismatch is visible. */
	blendPath: string;
	claimedAt: string;
}

export interface BlenderWorkspaceManifest {
	version: 1 | 2;
	workspaceId: string;
	workspacePath: string;
	blendPath: string;
	manifestPath: string;
	createdAt: string;
	updatedAt: string;
	latestIteration: number;
	template: string;
	sourceBlendPath?: string;
	/**
	 * Absent on manifests written before ownership existed, which is what makes
	 * an old workspace adoptable rather than permanently unclaimable.
	 */
	owner?: WorkspaceOwner;
	savedViews: Record<string, BlenderSavedView>;
	/** Appended by blender_add_reference; absent until the first reference. */
	references?: BlenderReference[];
	renderOutputs: BlenderRenderOutput[];
	/** Appended by blender_module_run; absent until the first module run. */
	moduleRuns?: BlenderModuleRunRecord[];
	/**
	 * Per-module critique counts for the current instruction, absent until the
	 * first critique. Reset to zero for a module when one of its critiques
	 * presents, which is what ends that module's instruction.
	 */
	critiqueCounts?: Record<string, number>;
}

export interface WorkspaceInitOptions {
	cwd: string;
	workspace?: string;
	sourceBlend?: string;
	template?: string;
	continueExisting?: boolean;
	signal?: AbortSignal;
}

export interface WorkspaceInitResult {
	workspacePath: string;
	blendPath: string;
	manifestPath: string;
	iteration: number;
	created: boolean;
	openedInLiveBlender?: boolean;
	liveBlenderMessage?: string;
}

export interface ExecutePythonOptions {
	cwd: string;
	workspace: string;
	script_path: string;
	saveBefore?: boolean;
	saveAfter?: boolean;
	/**
	 * Claim a numbered `iteration_NN` slot. Defaults to true.
	 *
	 * Pass false for throwaway runs — camera nudges, one-off inspection, a
	 * probe — that still need a private directory for their copied script and
	 * log but are not progress. Claiming made every such call inflate
	 * `latestIteration`, so a workspace could reach iteration 40 with six
	 * real changes in it, and the iteration number in the critique log stopped
	 * corresponding to anything a reader could interpret. Unclaimed runs get
	 * their own `runs/ad-hoc/<id>/` directory instead, so nothing clobbers.
	 */
	claimIteration?: boolean;
	timeoutSeconds?: number;
	label?: string;
	signal?: AbortSignal;
}

export interface ExecutePythonResult {
	workspacePath: string;
	blendPath: string;
	manifestPath: string;
	/** Claimed iteration, or null when `claimIteration` was false. */
	iteration: number | null;
	sourceScriptPath: string;
	/** Directory the script copy and log landed in. Set even when unclaimed. */
	runDir: string;
	scriptPath: string;
	logPath: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	changed: boolean;
}

export interface ReadOnlyPythonOptions {
	cwd: string;
	workspace: string;
	/**
	 * The Python to run, as text. A read-only role has no `write` tool, so a path
	 * would make this unusable for the role that needs it most.
	 */
	script: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ReadOnlyPythonResult {
	workspacePath: string;
	blendPath: string;
	/** Copy of the script that actually ran, beside any run output. */
	scriptPath: string;
	runDir: string;
	stdout: string;
	stderr: string;
	exitCode: number;
	/**
	 * The script asked for an operation outside the role's scope, so the bridge
	 * refused it and nothing was changed. `stdout` then names what was refused.
	 * A refused run is a result, not an error: the measurement simply needs a
	 * different question.
	 */
	refused: boolean;
}

export interface SceneInfoOptions {
	cwd: string;
	workspace: string;
	categories?: Array<
		| "objects"
		| "collections"
		| "materials"
		| "cameras"
		| "cameraSettings"
		| "lights"
		| "views"
		| "renderSettings"
		| "uv"
		| "armatures"
		| "textures"
		| "paintSettings"
	>;
	signal?: AbortSignal;
}

export interface SceneInfoResult {
	workspacePath: string;
	blendPath: string;
	iteration: number;
	sceneInfoPath: string;
	activeCameraName: string | null;
	objects: Array<Record<string, unknown>>;
	collections: Array<Record<string, unknown>>;
	materials: Array<Record<string, unknown>>;
	cameras: Array<Record<string, unknown>>;
	cameraSettings: Array<Record<string, unknown>>;
	lights: Array<Record<string, unknown>>;
	views: BlenderSavedView[];
	renderSettings: Record<string, unknown> | null;
	/**
	 * Scene unit system. Always present (it is three scalars) because scale is
	 * the single most common silent defect in an asset handoff: a model built
	 * at 1.0 scale when the file expects 0.01 imports 100x too large, and
	 * nothing in the geometry itself says so.
	 */
	units: BlenderSceneUnits | null;
	uv: Array<Record<string, unknown>>;
	armatures: Array<Record<string, unknown>>;
	textures: Array<Record<string, unknown>>;
	paintSettings: Record<string, unknown> | null;
}

export interface BlenderSceneUnits {
	/** Raw `scene.unit_settings.system`, e.g. "METRIC" | "NONE". */
	system: string;
	/** Blender units per metre. 1.0 is metres; 0.01 is centimetres. */
	scaleLength: number;
	/** Display unit for lengths, e.g. "METERS" | "CENTIMETERS". */
	lengthUnit: string;
	/** Mass unit, e.g. "KILOGRAMS". Relevant only for physics-driven assets. */
	massUnit: string;
	/** Length in metres of one Blender unit, derived. The number to compare against. */
	oneUnitInMeters: number;
}

export interface SceneInfoSelection {
	includeObjects: boolean;
	includeCollections: boolean;
	includeMaterials: boolean;
	includeCameras: boolean;
	includeCameraSettings: boolean;
	includeLights: boolean;
	includeViews: boolean;
	includeRenderSettings: boolean;
	includeUv: boolean;
	includeArmatures: boolean;
	includeTextures: boolean;
	includePaintSettings: boolean;
}

export interface SessionContextOptions {
	cwd: string;
	workspace?: string;
	include?: BlenderSessionContextCategory[];
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** Another live instance holding the same blend open. */
export interface BlenderSharedWithPeer {
	instanceId: string;
	/** 0 when the peer has no instance.json, i.e. an unclaimed beating UI. */
	pid: number;
	bridgeDir: string;
	blendPath: string;
}

export interface SessionContextResult {
	requestedWorkspacePath: string | null;
	requestedBlendPath: string | null;
	workspacePath: string | null;
	matchesWorkspace: boolean | null;
	/**
	 * Other live pi instances whose Blender currently has this blend open.
	 *
	 * Reported, not enforced: this tool is read-only, so it can only say that a
	 * second window is watching the same file. The refusal lives in
	 * loadWorkspaceManifest, on the path that would actually open it.
	 */
	sharedWith: BlenderSharedWithPeer[];
	/**
	 * The same warnings, tagged with a stable code each.
	 *
	 * The compact per-turn prompt must not decide what matters by matching
	 * English prose: rewording "Another live pi instance" would silently drop a
	 * peer-safety warning from every manager turn, with no test and no type
	 * error to notice. A code is what callers filter on, so the wording of a
	 * human-readable message is free to change.
	 */
	warningCodes: SessionContextWarningCode[];
	/** The human-readable text for each entry of `warningCodes`, same order. */
	warnings: string[];
	file: BlenderSessionFileContext | null;
	scene: BlenderSessionSceneContext | null;
	selection: BlenderSessionSelectionContext | null;
	mode: BlenderSessionModeContext | null;
	viewport: BlenderSessionViewportContext | null;
}

/**
 * Why a session-context warning was raised.
 *
 * `workspace-mismatch` cannot appear in the per-turn snapshot, because that
 * path calls the context tool with no workspace to compare against; it exists
 * for explicit `blender_session_context` calls.
 */
export type SessionContextWarningCode =
	| "workspace-mismatch"
	| "unsaved-scene"
	| "shared-with-peer"
	| "unsaved-changes"
	| "no-viewport"
	| "ambiguous-selection";

export interface SaveViewOptions {
	cwd: string;
	workspace: string;
	name: string;
	source: string;
	camera_name?: string;
	signal?: AbortSignal;
}

export interface SaveViewResult {
	workspacePath: string;
	manifestPath: string;
	savedView: BlenderSavedView;
}

export const BLENDER_VIEWPORT_MODES = [
	"OBJECT",
	"POSE",
	"EDIT_MESH",
	"EDIT_ARMATURE",
	"SCULPT",
	"TEXTURE_PAINT",
	"VERTEX_PAINT",
	"WEIGHT_PAINT",
	"FACE_PAINT",
	"UV",
] as const;

export type BlenderViewportMode = (typeof BLENDER_VIEWPORT_MODES)[number];

export interface SetModeOptions {
	cwd: string;
	workspace: string;
	mode: BlenderViewportMode;
	objectName?: string;
	signal?: AbortSignal;
}

export interface SetModeResult {
	workspacePath: string;
	blendPath: string;
	mode: BlenderViewportMode;
	blenderMode: string;
	objectName: string;
	uvEditorOverlay: boolean;
}

export type BlenderRenderMethod = "live" | "background";export type BlenderRenderViewSource = "camera" | "current-view";
export type BlenderViewportShading = "wireframe" | "solid" | "material-preview" | "rendered";
export type BlenderRenderEngine = "eevee" | "cycles" | "workbench";

export interface RenderOptions {
	cwd: string;
	workspace: string;
	view?: string;
	resolution?: {
		x: number;
		y: number;
		percentage?: number;
	};
	samples?: number;
	outputName?: string;
	renderMethod?: BlenderRenderMethod;
	viewSource?: BlenderRenderViewSource;
	viewportShading?: BlenderViewportShading;
	renderEngine?: BlenderRenderEngine;
	signal?: AbortSignal;
}

export interface RenderResult {
	workspacePath: string;
	blendPath: string;
	iteration: number;
	outputPath: string;
	logPath: string;
	outputName: string;
	view: string;
	cameraName: string | null;
	/**
	 * The engine identifier the run actually used, which is NOT always the one
	 * that was asked for: the engine enum was renamed between Blender releases
	 * ("BLENDER_EEVEE" <-> "BLENDER_EEVEE_NEXT"), so a background render of
	 * `eevee` can land on a different member of this build's enum. Null on the
	 * live path, which renders through the viewport and leaves the scene engine
	 * alone.
	 */
	resolvedEngine: string | null;
	resolution: { x: number; y: number; percentage: number };
	samples: number | null;
	renderMethod: BlenderRenderMethod;
	viewSource: BlenderRenderViewSource;
	viewportShading: BlenderViewportShading | null;
	renderEngine: BlenderRenderEngine | null;
}

export interface CritiqueLogOptions {
	cwd: string;
	workspace: string;
	/**
	 * The module this critique judged. Required rather than derived: under
	 * parallel module runs `latestIteration` is whichever run finished last,
	 * so stamping a critique with it labels an entry with a sibling's number.
	 */
	moduleName: string;
	iteration?: number;
	accuracy: number;
	geometry: number;
	materials: number;
	completeness: number;
	quality: number;
	viewAdequacy: string;
	issues: string[];
	nextAction: string;
}

export interface CritiqueLogResult {
	workspacePath: string;
	critiqueLogPath: string;
	entry: {
	iteration: number;
	score: number;
	/** The module judged, echoed so a reader never has to infer it. */
	moduleName: string;
	/** 1-based position of this critique within the module's current budget. */
	budgetUsed: number;
	/**
	 * True when the 5-iteration budget for the current instruction is spent
	 * and the score is still below the present threshold: stop iterating and
	 * present the current state instead.
	 */
	iterationBudgetExceeded: boolean;
		accuracy: number;
		geometry: number;
		materials: number;
		completeness: number;
		quality: number;
		viewAdequacy: string;
		issues: string[];
		nextAction: string;
		loggedAt: string;
		shouldPresent: boolean;
	};
}

export interface BlenderRunResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface ModuleRunOptions {
	cwd: string;
	workspace: string;
	moduleName: string;
	render?: boolean;
	view?: string;
	timeoutSeconds?: number;
	/** Render-quality parity with blender_render (module renders used to be hard-coded). */
	viewportShading?: BlenderViewportShading;
	renderEngine?: BlenderRenderEngine;
	resolution?: { x: number; y: number; percentage?: number };
	samples?: number;
	signal?: AbortSignal;
}

export interface ModuleRunResult {
	workspacePath: string;
	blendPath: string;
	module: string;
	moduleDir: string;
	scriptPath: string;
	iteration: number;
	checkpointPath: string;
	createdCheckpoint: boolean;
	stdout: string;
	exitCode: number;
	renderOutputPath: string | null;
	changed: boolean;
}

export interface ModuleRevertOptions {
	cwd: string;
	workspace: string;
	moduleName: string;
	/** Allow the revert even though later module runs also mutated the blend. */
	force?: boolean;
	/** Revert this specific recorded run instead of the module's latest one. */
	iteration?: number;
	signal?: AbortSignal;
}

export interface ModuleRevertResult {
	workspacePath: string;
	blendPath: string;
	module: string;
	checkpointPath: string;
	revertedIteration: number;
	openedInLiveBlender: boolean;
	liveBlenderMessage: string;
	/** Module runs whose blend changes this revert also discards. */
	discardedLaterRuns: string[];
	warning: string | null;
}

export interface BridgeStatusOptions {
	cwd: string;
	workspace?: string;
}

export interface BridgeStatusResult {
	alive: boolean;
	busy: boolean;
	pendingRequests: number;
	lock: { pid: number | null; label: string | null; acquiredAt: string | null; ageMs: number } | null;
	bridgeDir: string;
	requestsDir: string;
	workspacePath: string | null;
	recommendation: string;
}

export interface RunBlenderJsonOptions {
	cwd: string;
	blendPath?: string;
	scriptSource: string;
	payload: Record<string, unknown>;
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** One of the measurement families `blender_geometry_probe` can run. */
export type GeometryProbeCheck = "transform" | "bounds" | "axis" | "pair" | "shape" | "topology";

export interface GeometryProbeBounds {
	min: number[];
	max: number[];
	size: number[];
	center: number[];
}

export interface GeometryProbeTransform {
	location: number[];
	rotationEulerDegrees: number[];
	scale: number[];
	parent: string | null;
	/** Non-unit scale left unapplied — skews every measurement derived from it. */
	unappliedScale: boolean;
	/** Negative scale component: normals, mirroring and BVH offsets invert. */
	mirrorScale: boolean;
	minZ: number;
}

/**
 * Ring shape split into WARP and TUBE.
 *
 * A single (max-min)/mean radius cannot tell them apart, and it reads ~0.4
 * even for a geometrically perfect torus whose tube radius is 0.4 of its ring
 * radius — which would have the diagnostician chasing a shape defect that does
 * not exist. So radius is binned by angle around the ring axis: variation
 * *within* a bin is the tube (benign, expected), variation *between* bins is
 * the warp (a real shape defect).
 */
export interface GeometryProbeRingRoundness {
	available: boolean;
	reason?: string;
	/** Mean distance from the ring axis. */
	radialMean?: number;
	/** (max-min)/mean over every sampled vertex, tube + warp together. */
	radialSpread?: number;
	/** Angular bins that received samples. 0-15 by default. */
	bins?: number;
	/**
	 * (max-min)/mean of the per-bin mean radii: how much the ring's radius
	 * changes as you go AROUND it. Near zero for a correct handle regardless
	 * of how fat the tube is. This is the number to judge a shape defect on.
	 */
	warpRatio?: number;
	/**
	 * Largest (max-min)/mean within a single angular bin: how fat the tube is.
	 * Large is normal (a minor=0.006 / major=0.03 handle reads 0.4) and is NOT
	 * a defect.
	 */
	tubeRatio?: number;
	/** Largest absolute deviation of a bin mean from radialMean. */
	maxDeviation?: number;
}

export interface GeometryProbeAxis {
	available: boolean;
	reason?: string;
	/** Principal axis of least extent — for a ring, its own axis. */
	thinAxis: number[];
	thinAxisAngleToExpected: number;
	longAxis: number[];
	longAxisAngleToExpected: number;
	expectedAxis: string;
	/**
	 * RMS radius perpendicular to thinAxis. For a torus this is minor/sqrt(2)
	 * (a disc cross-section), NOT the 2*minor full width. A measured 0.00424 on
	 * a minor=0.006 handle is correct, not a half-size error.
	 */
	thickness: number;
	thicknessNote?: string;
	radius: number;
	/** Thin-to-long variance ratio. Below 0.05: degenerate, i.e. ring/tube-like. */
	axisRatio?: number | null;
	/** Thin-to-long variance ratio below 0.05: degenerate, i.e. ring/tube-like. */
	isRingLike: boolean;
	ringRoundness: GeometryProbeRingRoundness;
	center: number[];
}

export interface GeometryProbeTopology {
	available: boolean;
	reason?: string;
	vertices: number;
	edges: number;
	faces: number;
	nonManifoldEdges: number;
	boundaryEdges: number;
	looseVertices: number;
	looseEdges: number;
	degenerateFaces: number;
	duplicateVertices: number;
}

export interface GeometryProbeObject {
	name: string;
	type: string;
	bounds?: GeometryProbeBounds;
	transform?: GeometryProbeTransform;
	axis?: GeometryProbeAxis;
	topology?: GeometryProbeTopology;
}

export interface GeometryProbePair {
	verdict: "interpenetrating" | "in-contact" | "separated" | "unknown";
	reason?: string;
	tolerance: number;
	closestSurfaceDistance: number | null;
	deepestPenetration: number;
	verticesInsideTarget: Record<string, number>;
	sampledVertexCount: Record<string, number>;
	/** Signed per-axis extent overlap; negative means separated on that axis. */
	boundingBoxOverlap: { x: number; y: number; z: number };
}

export interface GeometryProbeResult {
	blendPath: string | null;
	isDirty: boolean;
	checks: string[];
	tolerance: number;
	unitNote: string;
	objects: Record<string, GeometryProbeObject>;
	pairs: Record<string, GeometryProbePair>;
}

export interface GeometryProbeOptions {
	cwd: string;
	workspace: string;
	objects?: string[];
	pairs?: string[][];
	checks?: GeometryProbeCheck[];
	tolerance?: number;
	expectedAxis?: "X" | "Y" | "Z";
	timeoutMs?: number;
	signal?: AbortSignal;
}

/**
 * Shape measurements that no render can settle: whether the mesh agrees with
 * itself across a mirror plane, how its radius changes along its own long
 * axis, and how far its surface departs from its convex hull.
 */
export interface GeometryProbeSelfSymmetry {
	/** The world axis the mesh was tested against, or null when it is not symmetric about any of them. */
	mirrorAxis: "X" | "Y" | "Z" | null;
	/** Mean and worst vertex distance to the mirrored position, in Blender units. */
	meanDeviation: number | null;
	maxDeviation: number | null;
	/** Mean deviation as a fraction of the mesh's own size, so scale cannot disguise symmetry. */
	deviationRatio: number | null;
	/** All three candidate axes, best first. */
	perAxis: { axis: "X" | "Y" | "Z"; meanDeviation: number }[];
}

export interface GeometryProbeShape {
	vertices: number;
	faces: number;
	dimensions: number[];
	/** Axis the radius profile is sampled along — the mesh's own long axis. */
	profileAxis: "X" | "Y" | "Z" | null;
	profile: {
		/** Normalized position along the profile axis, 0 at the -extreme end. */
		t: number[];
		/** Mean distance from the profile axis at each sample. */
		radius: number[];
		/** Standard deviation within each sample: a bulge reads as a spike here. */
		spread: number[];
		/** Fraction of consecutive samples shrinking; below ~0.9 is not a clean taper. */
		monotonic: number;
		/** (first radius - last radius) / first radius. */
		taper: number;
	} | null;
	selfSymmetry: GeometryProbeSelfSymmetry;
	/** Fraction of vertex pairs whose connecting segment leaves the mesh. */
	convexityRatio: number | null;
	openEdges: number;
	looseVerts: number;
	note?: string;
}

export interface ImageProbeOptions {
	cwd: string;
	workspace: string;
	/** Path to a PNG. Relative paths resolve against the workspace root. */
	path: string;
	/** The image's background colour in 0..1 per channel. Defaults to black. */
	background?: [number, number, number];
	/** Per-channel tolerance, 0..1, for calling a pixel background. */
	tolerance?: number;
	/** Luma grid resolution. Default [8,8]. */
	grid?: [number, number];
	/** How many dominant subject colours to report. Default 6, 0 disables. */
	paletteLimit?: number;
}

export interface ImageProbeResult {
	path: string;
	workspacePath: string;
	width: number;
	height: number;
	bitDepth: number;
	colorType: number;
	alphaPresent: boolean;
	imageSizeBytes: number;
	grid: { nx: number; ny: number };
	background: [number, number, number];
	tolerance: number;
	/** Inclusive pixel range of the subject, or null when nothing was found. */
	subjectBounds: { x0: number; x1: number; y0: number; y1: number } | null;
	subjectPixelCount: number;
	subjectCoverage: number;
	transparentPixels: number;
	/** Mean subject colour in 0..255 per channel. */
	meanColour: [number, number, number];
	/** Mean luma per grid cell in 0..1; null where a cell holds no subject. */
	lumaGrid: (number | null)[][];
	silhouette: {
		rowsOccupied: number;
		rowCount: number;
		/** Widest single row of subject pixels — a proxy for a horizontal limb. */
		widestRow: number;
		/** Contiguous bands of occupied rows, with each band's widest row. */
		coverageByRow: { from: number; to: number; maxWidth: number }[];
	};
	/**
	 * Mean absolute per-channel step between horizontally adjacent pixels over
	 * the subject. Low means a soft, blurry or low-contrast silhouette.
	 */
	edgeSharpness: number | null;
	/** Dominant subject colours, most common first, as #rrggbb with fractions. */
	palette: { hex: string; fraction: number }[];
	warnings: string[];
}

export interface GeometryProbeWorkspaceResult extends GeometryProbeResult {
	workspacePath: string;
	manifestPath: string;
	iteration: number;
	/** False when the live scene is not the workspace blend — numbers may not describe it. */
	matchesWorkspace: boolean;
	warnings: string[];
}

export interface MontageOptions {
	cwd: string;
	workspace: string;
	/** Module the sheet is written for. Each panel also lands beside it. */
	moduleName: string;
	/** Preset angle names, e.g. ["front", "left", "three-quarter"]. */
	views: string[];
	/** Objects to frame. Defaults to every visible mesh. */
	subject?: string[];
	/** Sheet columns. Defaults to 1 for up to two views, otherwise 2. */
	columns?: number;
	/** Per-panel pixel size. Defaults to 900x700. */
	panelResolution?: { x: number; y: number };
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface MontageResult {
	workspacePath: string;
	manifestPath: string;
	montagePath: string;
	panelPaths: string[];
	views: string[];
	layout: {
		panelWidth: number;
		panelHeight: number;
		aspect: number;
		columns: number;
		rows: number;
	};
	subject: string[];
	framing: { center: number[]; radius: number; distance: number };
	note: string;
}
