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
	/**
	 * Set when this record was written by a branch apply rather than by a live
	 * module run. The blend state is identical either way, and the checkpoint is
	 * the same file, so revert treats them alike; the field is provenance, so a
	 * reader can tell which of the two paths changed model.blend.
	 */
	viaBranchApply?: string;
}

/** Where a staged branch run is in its life. */
export type BranchRunStatus = "staged" | "applied" | "conflict" | "failed";

/** One object's contested by two or more staged branches. */
export interface BranchConflict {
	objectName: string;
	/** The modules contesting it, including the one this record is. */
	modules: string[];
}

/**
 * A module run executed headlessly against its own copy of model.blend.
 *
 * The apply set is the whole point of the record: it is what the apply copies
 * back, and what two records are compared on to decide they conflict. It is
 * WIDER than the objects the script touched, because a parented object cannot
 * travel without its parent, and a parent cannot come back without its children
 * — the widening is done in the branch script and reported here rather than
 * discovered at apply time.
 */
export interface BlenderBranchRunRecord {
	module: string;
	iteration: number;
	/** Monotonic, shared with moduleRuns, so apply and revert order the same way. */
	sequence: number;
	/** The module's private copy of model.blend that the script ran against. */
	branchPath: string;
	scriptPath: string;
	/** model.blend as it was when this run claimed the iteration; the apply's revert point. */
	checkpointPath: string;
	at: string;
	/** Objects whose content hash differed before and after the run. */
	touchedObjects: string[];
	/**
	 * Materials whose node tree or flat settings differed.
	 *
	 * Tracked separately because a paint module can change a material with no
	 * object moving at all, and object-only tracking would report it as having
	 * touched nothing and drop its work at apply time.
	 */
	touchedMaterials: string[];
	addedObjects: string[];
	removedObjects: string[];
	/** Everything the apply brings back: touched plus required relatives. */
	applyObjects: string[];
	/**
	 * Everything this module owns after this run: what it applied, plus what it
	 * owned before, minus what it removed. Carried forward rather than re-derived,
	 * because the fingerprints are content-based — a script that removes and
	 * rebuilds its part byte-for-byte applies nothing — so the diff alone cannot
	 * say what a module is responsible for.
	 */
	ownedObjects?: string[];
	/**
	 * Content hash of the applied datablocks, so the next iteration can be
	 * compared against this one without spending a render or a critic on the
	 * question. Equal digests mean the module wrote the same bytes again.
	 */
	stateDigest?: string;
	status: BranchRunStatus;
	appliedAt?: string;
	conflicts?: BranchConflict[];
	renderOutputPath?: string | null;
	/** Framing this run solved for the module's camera. Empty when it produced no mesh. */
	cameras?: BranchCameraFraming[];
}

export interface BranchRunOptions {
	cwd: string;
	workspace: string;
	moduleName: string;
	/** Capture a render of the BRANCH, not of model.blend. Defaults to true. */
	render?: boolean;
	view?: string;
	resolution?: { x: number; y: number; percentage?: number };
	samples?: number;
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

export interface BranchRunResult {
	workspacePath: string;
	blendPath: string;
	module: string;
	moduleDir: string;
	scriptPath: string;
	branchPath: string;
	iteration: number;
	runDir: string;
	checkpointPath: string;
	exitCode: number;
	stdout: string;
	stderr: string;
	touchedObjects: string[];
	touchedMaterials: string[];
	addedObjects: string[];
	removedObjects: string[];
	applyObjects: string[];
	/** Everything this module owns after this run; carried into the next run. */
	ownedObjects: string[];
	renderOutputPath: string | null;
	status: BranchRunStatus;
	/** Framing solved for the module's camera, and the numbers it was solved from. */
	cameras: BranchCameraFraming[];
	/** Content hash of the applied datablocks; empty only from a pre-digest Blender. */
	stateDigest?: string;
}

export interface BranchApplyOptions {
	cwd: string;
	workspace: string;
	/** Modules to apply, in any order; conflicts are computed over all staged runs. */
	modules: string[];
	timeoutSeconds?: number;
	signal?: AbortSignal;
}

export interface BranchApplyResult {
	workspacePath: string;
	blendPath: string;
	applied: Array<{ module: string; iteration: number; appended: string[]; removed: string[]; cameras: BranchCameraFraming[] }>;
	/** Conflicted modules, with the object that stopped each. Their branch blends are untouched. */
	skipped: Array<{ module: string; conflicts: BranchConflict[] }>;
	/** Modules whose branch blend had vanished from disk before the apply. */
	missing: string[];
	liveBlenderMessage: string;
}

/**
 * Where the harness put a module's camera, and on what numbers.
 *
 * Framing is arithmetic, so it is done here rather than by a worker: every
 * applied module's `<name>Cam` is re-solved from the bounds the apply just
 * measured. A worker that framed its own camera produced a good picture once
 * and a stale one the moment its part changed, and the report could not tell the
 * difference.
 */
export interface BranchCameraFraming {
	module: string;
	cameraName: string;
	created: boolean;
	center: [number, number, number];
	extent: [number, number, number];
	distance: number;
	lensMm: number;
	subjects: string[];
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
	 * Appended by blender_branch_run; absent until the first branch run.
	 *
	 * Separate from moduleRuns rather than sharing it, because the two answer
	 * different questions. A branch record describes work that has NOT touched
	 * model.blend yet, and mixing it into the run history would make revert
	 * offer to restore a state that a staged branch never replaced.
	 */
	branchRuns?: BlenderBranchRunRecord[];
	/**
	 * Per-module critique counts for the current instruction, absent until the
	 * first critique. Reset to zero for a module when one of its critiques
	 * presents, which is what ends that module's instruction.
	 */
	critiqueCounts?: Record<string, number>;
	/**
	 * Facts a probe or measurement established, keyed by module.
	 *
	 * Written into the manifest rather than carried in a manager's context so a
	 * fresh critic can be handed what is already known instead of spending an
	 * image and a context rediscovering it.
	 */
	iterationNotes?: Record<string, IterationProbeFact[]>;
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
	| "ambiguous-selection"
	/**
	 * The snapshot came from a headless read, not a live window.
	 *
	 * Its own code because a caller deciding whether it may trust the SELECTION
	 * is asking a question whose answer changes with the mode, and a caller that
	 * cannot tell the two apart would either distrust a correct answer or trust
	 * a null one. Always present when there is no window.
	 */
	| "no-watch-window"
	/**
	 * The headless read itself failed, so the file and scene sections are from
	 * the manifest rather than from the .blend. Separate from no-watch-window
	 * because that one is a mode and this one is a fault.
	 */
	| "headless-probe-failed";

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
	/**
	 * Null when source="active-camera" and no watch window was open. That source
	 * photographs the live UI, so with no UI there is nothing to bind to and the
	 * default headless run reports nothing rather than failing -- binding a view
	 * to a camera that does not exist would put a broken entry in the manifest,
	 * and every later render through it would be wrong.
	 */
	savedView: BlenderSavedView | null;
	/** Present only when `savedView` is null, explaining why it was not saved. */
	reason?: string;
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
	/**
	 * Whether the viewport actually changed mode. False when no watch window
	 * was open, which is the DEFAULT run rather than an error: a viewport mode
	 * is a statement about a UI, and the headless path has no UI. The caller
	 * still gets `mode` and `objectName` back, so the only thing it loses is the
	 * thing that could not happen.
	 */
	switched: boolean;
	/** Null when `switched` is false; there is no Blender mode to report. */
	blenderMode: string | null;
	objectName: string;
	uvEditorOverlay: boolean;
	/** Present only when `switched` is false, explaining why it was not. */
	reason?: string;
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
	/**
	 * A `live` render that could not run in a window and was produced by the
	 * background engine instead.
	 *
	 * Its own field rather than a warning, because the caller needs to REASON
	 * about it: a viewport screenshot and a render-engine image differ in
	 * lighting, viewport shading and overlays, and a critic judging "is the
	 * material right" from one and not the other is being asked a different
	 * question. Also means `renderMethod` above is what actually ran.
	 */
	fellBackToBackground: boolean;
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
	/**
	 * Is this a valid instance of the category at all — does it render as a
	 * mug, not as a well-formed object with a brief's worth of its features?
	 *
	 * Separate from `accuracy` (which asks whether it matches ITS brief)
	 * because the failure this catches is the one that poisons training data:
	 * the model learns the category from whatever was shipped, so a plausible
	 * non-instance is worse than an ugly instance. Zero means the category is
	 * not satisfied, and nothing else about the asset can recover that.
	 */
	validity: number;
	/**
	 * Whether the render is good enough to JUDGE from: 2 shows the whole
	 * subject and its silhouette, 1 partly occluded or ambiguous, 0 does not
	 * show the subject.
	 *
	 * Scored rather than free text because it gates the critique rather than
	 * the asset: for a mesh dataset an ugly render of a good mesh is still a
	 * good sample, but a render that cannot show the object makes every score
	 * below it meaningless, and an unscoreable critique must not be averaged in
	 * as though it were.
	 */
	viewAdequacy: number;
	/** Free-text note about the view, kept because the score cannot say why. */
	viewNote: string;
	issues: string[];
	nextAction: string;
	/**
	 * Reject the asset outright, whatever the score.
	 *
	 * Distinct from a low score on purpose: a scored failure is still a
	 * finished attempt, and a dataset wants the record of it. A reject says the
	 * attempt should never have been made — the category is unsatisfiable here,
	 * or the work is structurally wrong rather than merely unpolished.
	 */
	rejectReason?: string;
}

/**
 * What happened to an asset's instruction.
 *
 * `present` is the interactive terminal state; `reject` is what an exhausted
 * budget means when nobody is watching. Conflating them made every
 * budget-exhausted failure indistinguishable from a success in the log, so a
 * downstream filter had to re-read prose to sort them.
 */
export type CritiqueVerdict = "continue" | "present" | "reject";

/**
 * The fields a cross-batch ranking reads off one critique entry.
 *
 * Flat and separate from `CritiqueLogResult.entry` on purpose: a ranking
 * filters and sorts these, and giving it the whole entry would mean teaching
 * it about iterations and budgets it has no business knowing.
 */
/**
 * Interchange formats the exporter dispatches to.
 *
 * USD is absent on purpose: no exporter is guaranteed present in a stock
 * Blender build, and a format that silently fails on one machine is worse than
 * one that is not offered at all.
 */
export type ExportFormat = "glb" | "gltf" | "obj" | "stl";

export interface AssetExportOptions {
	cwd: string;
	workspace: string;
	format?: ExportFormat;
	/** Named subset to export. Omit for the whole blend. */
	objects?: string[];
	outputDir?: string;
	/** Base filename without extension. Defaults to the blend's name. */
	name?: string;
	/** Include animation data (glTF only). */
	animations?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface AssetExportResult {
	workspacePath: string;
	exportPath: string;
	format: ExportFormat;
	bytes: number;
	meshCount: number;
	objects?: string[];
}

/**
 * A measured fact worth carrying into the next critic, kept with the run it was
 * established against so a later brief can be checked against it.
 */
export interface IterationProbeFact {
	/** What was measured, e.g. "Mug bottom sits 0.4m below the table plane". */
	statement: string;
	/** Which measurement produced it, e.g. "geometry-probe scale contract". */
	source: string;
	/** The run iteration this was established against, when there was one. */
	iteration?: number;
	at: string;
}

export type IterationWasteGuardKind =
	| "none"
	| "budget-exhausted"
	| "unchanged-digest"
	| "fix-did-not-land"
	| "score-stalled";

export interface IterationWasteGuard {
	kind: IterationWasteGuardKind;
	/** Why this guard is active, in one sentence, addressed to the manager. */
	detail: string;
}

export interface IterationState {
	workspacePath: string;
	blendPath: string;
	module: string;
	presentThreshold: number;
	budget: { used: number; max: number; remaining: number; exhausted: boolean };
	lastRun?: { iteration: number; stateDigest?: string; executionMode: "branch" | "live" };
	lastVerdict?: {
		iteration?: number;
		verdict: CritiqueVerdict;
		score: number;
		viewUsable: boolean;
		rejectReason?: string;
	};
	previousScore?: number;
	/** Whether the last briefed fix actually changed the content. */
	fixLanded?: boolean;
	knownFacts: IterationProbeFact[];
	wasteGuard: IterationWasteGuard;
}

export interface IterationStateResult extends IterationState {}

export interface CritiqueVerdictRecord {
	moduleName: string;
	/** The iteration_NN the critique was claimed against, when the log recorded one. */
	iteration?: number;
	verdict: CritiqueVerdict;
	score: number;
	validity: number;
	viewUsable: boolean;
	iterationBudgetExceeded: boolean;
	rejectReason?: string;
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
		 * True when the module's iteration budget is spent and the score is
		 * still below the present threshold, with no reject reason given.
		 * Together with `verdict` this is what distinguishes a finished
		 * attempt that failed from an asset that was abandoned.
		 */
		iterationBudgetExceeded: boolean;
		/** Whether the view this was judged from was good enough to judge from. */
		viewUsable: boolean;
		/** How the instruction ended. See CritiqueVerdict. */
		verdict: CritiqueVerdict;
		accuracy: number;
		geometry: number;
		materials: number;
		completeness: number;
		quality: number;
		/**
		 * Category validity, echoed because it is the only axis whose zero is
		 * unrecoverable, so a reader scanning scores needs to see it without
		 * also reading prose.
		 */
		validity: number;
		viewAdequacy: number;
		viewNote: string;
		issues: string[];
		nextAction: string;
		rejectReason?: string;
		loggedAt: string;
		shouldPresent: boolean;
	};
}

export interface BlenderRunResult {
	stdout: string;
	stderr: string;
	code: number;
	/** What this run was for, kept so a lease can name it. Diagnostics only. */
	label?: string;
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
	/**
	 * True when this run changed the blend's object or material content.
	 *
	 * From a before/after content fingerprint, not from Blender's `is_dirty`
	 * flag: that flag is UI-facing and stays false in background mode, so a
	 * headless run would report every real edit as unchanged.
	 */
	changed: boolean;
	/**
	 * Where the script actually ran.
	 *
	 * A field rather than nothing because the two paths are not
	 * interchangeable in what the caller may conclude: a live run mutated
	 * model.blend in place, while `headless-apply` authored against a copy and
	 * merged back, so an object the run did not change may still differ from
	 * the state before it. `headless-apply` is also what happens whenever no
	 * window is open, which after /blender stopped opening one is the DEFAULT.
	 */
	executionMode: "live-session" | "headless-apply";
	/** Present when the run was a headless branch apply; what the live session did about it. */
	liveBlenderMessage?: string;
	/**
	 * The framing the harness solved for this module's camera, when it ran headless.
	 *
	 * Present rather than assumed because the two execution paths differ: a live
	 * run does not frame anything, and a worker told to place its own camera there
	 * still does. A caller reading `cameras` must check it rather than assume a
	 * camera exists at `<module>Cam`.
	 */
	cameras?: BranchCameraFraming[];
	/**
	 * Content hash of the datablocks this run applied. Comparing it with the
	 * previous run's is how a caller learns that an iteration changed nothing,
	 * without rendering the same bytes and paying a critic to look at them.
	 *
	 * Absent on a live-session run: `changed` there is a yes/no content
	 * comparison rather than a comparable hash.
	 */
	stateDigest?: string;
	/** True when the previous run of this module produced this same digest. */
	unchangedSinceLastRun?: boolean;
	/** The earlier run this one was compared against, when there was one. */
	comparedWithIteration?: number;
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
	/**
	 * The headless run budget, so the number that governs fan-out is reported
	 * next to the number that governs the bridge. A caller deciding how wide to
	 * fan out would otherwise have to read the env var and the source to learn
	 * that "16" means 4.
	 */
	headless: RunBudgetReport;
}

/** The headless concurrency budget as reported, flattened for tool output. */
export interface RunBudgetReport {
	/** The ceiling the environment asked for. */
	requested: number;
	/** What will actually run at once. */
	effective: number;
	/** True when the machine or the measured ceiling bound the result. */
	clamped: boolean;
	/** One line per binding term. */
	reasons: string[];
	/** Full explanation, or null when nothing clamped. */
	warning: string | null;
	/**
	 * Headless Blenders alive right now, counted across every process in the
	 * session tree rather than in this one.
	 *
	 * A per-process count would answer a question nobody asked: a manager that
	 * spawned four workers runs no Blender itself and would report zero while
	 * four processes saturated the box.
	 */
	running: number;
	/** Their pids, so a caller can say WHICH runs rather than only how many. */
	pids: number[];
	/** Leases dropped because their process was gone. Non-zero after a crash. */
	staleSwept: number;
	/**
	 * Whether a /blender-watch window is open, reported SEPARATELY from
	 * `running`.
	 *
	 * The window is not one of the budgeted runs — it is not gated, not counted
	 * against the ceiling, and each session may have one — so folding it into
	 * the same number would let a caller subtract the window from the run
	 * budget and under-count the runs actually occupying the machine.
	 */
	watchWindowOpen: boolean;
	/** The window's projected RSS in bytes, so its claim can be weighed. */
	watchWindowRssBytes: number;
}

export interface RunBlenderJsonOptions {
	cwd: string;
	blendPath?: string;
	scriptSource: string;
	payload: Record<string, unknown>;
	timeoutMs?: number;
	signal?: AbortSignal;
	/**
	 * What this run is for, recorded on its lease. Diagnostics only, and the
	 * reason the lease is worth reading: "4 open" names the processes, and a
	 * label is what turns one into "the body module, not the rig".
	 */
	label?: string;
	/**
	 * Extra arguments appended AFTER the JSON payload, for a script that takes
	 * arguments of its own. After the payload because Blender treats everything
	 * before `--` as its own arguments.
	 */
	scriptArgs?: string[];
}

/** One of the measurement families `blender_geometry_probe` can run. */
export type GeometryProbeCheck =
	| "transform"
	| "bounds"
	| "axis"
	| "pair"
	| "joint"
	| "shape"
	| "topology"
	| "scale";

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
	/**
	 * Connected components of the mesh, over its own edges. More than one means
	 * the object is several separate pieces, which every OTHER number here can
	 * miss entirely: a mesh split by a modelling slip is a set of closed solids,
	 * so it has no boundary edges, no non-manifold edges, no loose vertices and
	 * no duplicate vertices. A shower head whose head has drifted off its own
	 * pipe reports all zeros on those and one on this.
	 *
	 * Not a defect on its own: a surface with a shell and a base, or a shape
	 * with a separate inset piece, is legitimately more than one. Read it with
	 * `largestComponentShare` to tell a small extra piece from a mesh in pieces.
	 */
	connectedComponents: number;
	/** The main body's share of the mesh, 0..1. Near 1 means one piece plus a few strays. */
	largestComponentShare: number;
	/** The next few components by size, capped at five. */
	islandSizes: { vertices: number; share: number }[];
	/** True when `connectedComponents > 1`. A finding to judge, not a failure. */
	isSplit: boolean;
	/**
	 * How to read `isSplit`, because the count alone cannot be acted on.
	 *
	 * - `continuous` — one component. The healthy case.
	 * - `assembly` — many components, none dominant (largest share under 10%).
	 *   A railing of 66 balusters, a bamboo cluster of 83 culms, a drone's four
	 *   propeller blades. Merging repeated parts into one mesh is what this
	 *   toolchain asks a worker to do, so this is CORRECT, not a defect, and
	 *   reading it as one buries the real finding.
	 * - `break-candidate` — a dominant body plus other pieces. The case where
	 *   `islandSizes` and `minIslandGap` are worth reading.
	 *
	 * Known limit: this is one number, and an object a person considers whole but
	 * which is built from many similar clusters (a tree canopy) reads as
	 * `assembly`. The numbers are the evidence; this is the reading of them.
	 */
	islandRead: "continuous" | "assembly" | "break-candidate";
	/**
	 * Whether the parts of an assembly MEET, which `islandRead` cannot say.
	 *
	 * `islandFloatingShare` is the percentage of islands whose nearest other
	 * island is farther away than 5% of their OWN size — dimensionless on
	 * purpose, because the same 25 mm is a seam on a 2.65 m plank and a canyon
	 * on a 0.3 m bollard.
	 *
	 * The measured pair: 32 bridge planks 2.65 m long, 25 mm apart, gap ≈ 9.6% of
	 * each plank's own length, 100% floating — NOT an assembly, a broken model
	 * whose island count looks healthy. A shoji frame whose pieces share
	 * vertices reads gap 0.0 and 29% floating, which IS built. Both report
	 * `islandRead: "assembly"`, so the label alone would score them identically.
	 */
	islandFloatingShare: number | null;
	/**
	 * That same gap-to-own-size ratio for the tightest join in the mesh, so a
	 * single shared-vertex join (`0`) reads differently from a mesh whose parts
	 * merely stand close.
	 */
	islandContact: number | null;
	/**
	 * Nearest approach between the main body and any other island, in the
	 * mesh's own object space, or null when the mesh is continuous.
	 *
	 * A VERTEX-to-vertex distance, so a small island sitting flat ON a large
	 * surface can be fully enclosed by it and still report a large gap: the
	 * samples on either side are the far corners, and nothing is measured to the
	 * surface between them. Read it as "do these parts approach each other",
	 * never as a clearance. For a true clearance use the `pair` check between
	 * two objects, which measures surfaces.
	 *
	 * A gap of a few millimetres is a modelling slip whatever the component
	 * count, which is the case `islandRead` gets wrong.
	 *
	 * Measured over EVERY island pair, not just the main body to the rest, so
	 * two alike halves drifting apart are found — neither is the largest, which
	 * is exactly where a body-only minimum would miss them.
	 */
	minIslandGap: number | null;
}

/**
 * One pair that ought to meet and does not, found without being asked for.
 *
 * The `pair` check measures the two objects someone named. This is the sweep
 * that finds the pair nobody thought of, which is the defect that actually
 * reaches a user: two pipes of the same family, one modelled a centimetre clear
 * of the other, look correct in a render from any useful angle.
 */
export interface GeometryProbeJoint {
	a: string;
	b: string;
	/**
	 * `overlapping-but-apart` is a DEFECT: the two parts' bounding boxes share
	 * space, so they occupy the same place in the model, yet no surface of one
	 * reaches any surface of the other. That is a joint that was meant to be
	 * made and was missed.
	 *
	 * `coincident-surface` is a DEFECT, and the only one guaranteed to be
	 * VISIBLE in the finished render: two parts sharing a stretch of surface
	 * z-fight into colour banding. It is reported even though the pair
	 * verdict says `in-contact`, because that is what a clean flush abutment
	 * reports too and nothing else tells them apart.
	 *
* `buried` is a DEFECT, and the one most likely to be INVISIBLE: a wall built
 * straight through a door, a deck run past the wall face it should stop at, a
 * pier set so deep into a bank that only its cap shows. Each is a correct
 * render of a wrong model, because the swallowed part contributes nothing but
 * a bump through the surface. It is reported even though the pair verdict says
 * `interpenetrating`, which is ALSO the verdict of every healthy joint in the
 * model — a post set 2 mm into a deck is interpenetrating and right — so the
 * boolean alone cannot separate them.
 *
 * `near-miss` is a placement to JUDGE: the boxes come within `nearMissMax`
 * without overlapping on any axis. A chair pulled up to a table is correct
 * and reads the same as a detached riser at this resolution. It is reported
 * because it is cheap and a render hides it, and marked because treating it
 * as a defect is how a measurement becomes noise an analyst learns to skip.
 */
	severity:
		| "coincident-surface"
		| "buried"
		| "broken-continuation"
		| "overlapping-but-apart"
		| "near-miss";
	/** Why this pair is in the list, in one sentence. */
	reason: string;
	/** Closest surface distance between the two, the same measurement `pairs` reports. */
	gap: number | null;
	/** Present on every entry; carries the counts the `coincident-surface` verdict rests on. */
	coincidentSurface: GeometryProbeCoincidence;
	/**
	 * Present on every entry; `null` unless one object is inside the other.
	 * The figures behind the `buried` verdict, and reported on their own because
	 * they are a PROPORTION and not a verdict — see the caveat on
	 * `depthVsThickness`.
	 */
	buried?: GeometryProbeBuried | null;
	tolerance: number;
	/** Signed per-axis bounding-box gap; positive is empty space on that axis. */
	boundingBoxGap: { x: number; y: number; z: number };
	/** Which axes the two boxes overlap on. Empty for a near-miss. */
	boundingBoxOverlapAxes: string[];
	/** True when the two boxes share space on at least one axis. */
	overlapping: boolean;
	/** Distance between the boxes: 0 when they overlap, else the widest axis gap. */
	boundingBoxDistance: number;
}

export interface GeometryProbeJoints {
	tolerance: number;
	/** Beyond this gap a pair is simply placed near each other and is not reported. */
	nearMissMax: number;
	/** How many are `overlapping-but-apart`. The number to act on. */
	defectCount: number;
	/** How many are `near-miss`. The number to judge. */
	nearMissCount: number;
	/** Worst first: defects before near-misses, then by gap. */
	joints: GeometryProbeJoint[];
	note: string;
}

export interface GeometryProbeObject {
	name: string;
	type: string;
	bounds?: GeometryProbeBounds;
	transform?: GeometryProbeTransform;
	axis?: GeometryProbeAxis;
	topology?: GeometryProbeTopology;
}

/**
 * How much of one object lies ON the other's surface.
 *
 * Two objects sharing a stretch of surface render as z-fighting colour
 * banding, and no verdict catches it: a flush-laid panel is `in-contact`,
 * which is what a clean abutment also reports. This figure is what separates
 * them, and it is judged on the SMALLER side so a small part resting flush
 * against a large surface stays clean — the large mesh has almost no vertices
 * on the small part.
 */
export interface GeometryProbeCoincidence {
	/** Distance under which a vertex counts as lying on the surface. */
	epsilon: number;
	firstVertices: number;
	secondVertices: number;
	/** Of each object's SAMPLED vertices, since that is what was measured. */
	firstShare: number;
	secondShare: number;
	/** The smaller of the two counts — coincidence has to be mutual. */
	smallerCount: number;
	smallerShare: number;
	/**
	 * How many vertices of each object fall inside the two objects' SHARED
	 * bounding box, which is the denominator `firstShare`/`secondShare` are
	 * read against. Reported so a ratio is never quoted without its base.
	 */
	sharedVertices: Record<string, number>;
	isCoincident: boolean;
}

/**
 * How deep one object sits inside the other, expressed against its own size.
 *
 * TWO figures are needed and neither is sufficient alone. Depth without the
 * size ratio calls a pier founded in the ground 55x buried — measured, on a
 * real 243-object scene, along with a lantern inside a railing at 8.9x, both
 * correct geometry — because both are inside something large. The size ratio
 * without the depth calls a flush abutment a swallow. A part placed INTO
 * something else is smaller than the thing holding it; two surfaces of
 * near-equal extent that overlap are layers.
 */
export interface GeometryProbeBuried {
	/** Which object is inside, i.e. the one that vanished. */
	buriedObject: string;
	/** Which object it is inside. */
	buriedIn: string;
	/** Metres from the deepest vertex to the nearest surface of the container. */
	depth: number;
	/**
	 * The buried object's own smallest world extent, the denominator of
	 * `depthVsThickness`. `null` for a degenerate object with no thickness.
	 */
	thickness: number | null;
	/**
	 * `depth` divided by `thickness`. A joint measures well under 1; a part as
	 * deep as it is thick is 1 and entirely inside.
	 *
	 * KNOWN LIMIT, and it errs in the safe direction: depth is the DEEPEST
	 * VERTEX's distance to the nearest surface, so a coarse mesh understates
	 * it. An 8-vertex cube centred in a block reads 2.0 where its centre sits
	 * at 2.5, because none of its eight corners are near its middle.
	 */
	depthVsThickness: number | null;
	/** How much larger the container is, by largest extent. `null` if the part has none. */
	relativeSize: number | null;
}

export interface GeometryProbePair {
	verdict: "interpenetrating" | "in-contact" | "separated" | "unknown";
	reason?: string;
	tolerance: number;
	coincidentSurface: GeometryProbeCoincidence;
	/**
	 * `null` unless the pair interpenetrates, and the figure that separates a
	 * working joint from a swallowed part. `deepestPenetration` alone is the
	 * SAME NUMBER for a post set 2 mm into a deck and a wall built through a
	 * door, because both are interpenetrating and nothing but this ratio
	 * carries the buried part's own size.
	 */
	buried?: GeometryProbeBuried | null;
	closestSurfaceDistance: number | null;
	deepestPenetration: number;
	verticesInsideTarget: Record<string, number>;
	sampledVertexCount: Record<string, number>;
	/** Signed per-axis extent overlap; negative means separated on that axis. */
	boundingBoxOverlap: { x: number; y: number; z: number };
}

/**
 * One axis of a measured object against the dimension a brief named for it.
 * `measured` and `target` are both metres: a specification's own units are
 * normalized on the way in, so 900mm and 0.9 compare equal.
 */
export interface GeometryProbeScaleAxis {
	axis: "x" | "y" | "z";
	/** Which way round the number is, from the object's own point of view. */
	label: "width" | "depth" | "height";
	measured: number;
	target: number;
	/** measured - target, in metres. Negative means the object is undersized. */
	delta: number;
	/** measured / target. 1.0 is exact, 1000.0 is the millimetre/metre trap. */
	ratio: number | null;
	withinTolerance: boolean;
}

export interface GeometryProbeScaleEntry {
	status: "on-spec" | "off-spec" | "missing" | "not-a-mesh" | "no-axes";
	detail: string;
	axes?: Record<string, GeometryProbeScaleAxis>;
}

export interface GeometryProbeResult {
	blendPath: string | null;
	isDirty: boolean;
	checks: string[];
	tolerance: number;
	unitNote: string;
	objects: Record<string, GeometryProbeObject>;
	pairs: Record<string, GeometryProbePair>;
	/** Present only when a `joint` check was requested; null otherwise. */
	joints?: GeometryProbeJoints | null;
	/** Present only when a `scale` check was requested; empty otherwise. */
	scaleContract: Record<string, GeometryProbeScaleEntry>;
}

/**
 * Reference dimensions for objects, keyed by the exact object name. Values are
 * millimetres when written as bare numbers ("900") and parsed as metres when
 * they carry a unit ("0.9", "2.4m", "3'4\""), because a brief writes a counter
 * height the way a person does and a harness that guesses wrong between the two
 * reports a room a thousand times too big without looking wrong.
 */
export interface GeometryProbeSpecification {
	width?: number | string;
	depth?: number | string;
	height?: number | string;
	/** Metres. Defaults to the probe's own tolerance. */
	tolerance?: number;
}

export interface GeometryProbeOptions {
	cwd: string;
	workspace: string;
	objects?: string[];
	pairs?: string[][];
	checks?: GeometryProbeCheck[];
	/** Reference dimensions; asking for them implies the `scale` check. */
	specifications?: Record<string, GeometryProbeSpecification>;
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
	/**
	 * Preset view names. Orbit presets (front, three-quarter) frame the subject's
	 * bounding sphere; interior presets (interior-corner, interior-doorway)
	 * stand inside it at eye height. A room has no silhouette to orbit, so the
	 * two families cannot be one formula.
	 */
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

export interface MontagePanelFraming {
	view: string;
	mode: "orbit" | "interior";
	location: number[];
	target: number[];
	/** null for orbit panels, which keep the default lens. */
	lensMm: number | null;
}

export interface MontageFraming {
	/** "interior" only when every panel stood inside the subject. */
	family: "orbit" | "interior";
	center: number[];
	radius: number;
	distance: number;
	views: MontagePanelFraming[];
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
	framing: MontageFraming;
	note: string;
}

export interface CompareOptions {
	cwd: string;
	workspace: string;
	/** Module the sheet is written for, alongside its per-view panels. */
	moduleName: string;
	/**
	 * The generation to compare against. Optional because run history names it:
	 * omitted, it is this module's previous run. Refused outright when there is
	 * none, because a sheet of one generation wearing a comparison's labels
	 * invites reading the build as an improvement over nothing.
	 */
	baselineBlendPath?: string;
	/**
	 * What to call the baseline in every panel label. Defaults to its iteration
	 * number when the baseline came from run history, and BEFORE when it was
	 * named explicitly — a path the history does not describe has no honest
	 * number to print.
	 */
	baselineLabel?: string;
	/** What to call the current generation. Defaults to AFTER. */
	currentLabel?: string;
	/** Preset view names, as for blender_montage. */
	views?: string[];
	/** Objects to frame and compare. Defaults to every visible mesh. */
	subject?: string[];
	/** Sheet columns. Defaults to 2, so a view's two panels sit side by side. */
	columns?: number;
	/** Per-panel pixel size. Defaults to 900x700. */
	panelResolution?: { x: number; y: number };
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface CompareResult extends MontageResult {
	labels: { baseline: string; current: string };
	baseline: {
		blendPath: string;
		panelPaths: string[];
		/**
		 * Subjects the baseline does not hold. A BEFORE panel missing them is a
		 * checkpoint from before they existed, and saying so is the difference
		 * between a readable comparison and a bug report.
		 */
		missingSubjects: string[];
		usedItsOwnExtent: boolean;
	};
	framing: MontageFraming & { fromUnion: true };
}
