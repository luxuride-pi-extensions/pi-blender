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
	savedViews: Record<string, BlenderSavedView>;
	/** Appended by blender_add_reference; absent until the first reference. */
	references?: BlenderReference[];
	renderOutputs: BlenderRenderOutput[];
	/** Appended by blender_module_run; absent until the first module run. */
	moduleRuns?: BlenderModuleRunRecord[];
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

export interface SessionContextResult {
	requestedWorkspacePath: string | null;
	requestedBlendPath: string | null;
	workspacePath: string | null;
	matchesWorkspace: boolean | null;
	warnings: string[];
	file: BlenderSessionFileContext | null;
	scene: BlenderSessionSceneContext | null;
	selection: BlenderSessionSelectionContext | null;
	mode: BlenderSessionModeContext | null;
	viewport: BlenderSessionViewportContext | null;
}

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
export type GeometryProbeCheck = "transform" | "bounds" | "axis" | "pair" | "topology";

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

export interface GeometryProbeWorkspaceResult extends GeometryProbeResult {
	workspacePath: string;
	manifestPath: string;
	iteration: number;
	/** False when the live scene is not the workspace blend — numbers may not describe it. */
	matchesWorkspace: boolean;
	warnings: string[];
}
