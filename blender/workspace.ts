import { copyFile, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isLiveBridgeAlive } from "../launch.js";
import { checkLiveBlenderBlend, requestLiveBlenderOpenBlend } from "./bridge.js";
import { assertWorkspaceOwnership, buildWorkspaceOwner, classifyWorkspaceOwner, describeLiveOwner } from "./ownership.js";
import type { BlenderWorkspaceManifest, WorkspaceInitOptions, WorkspaceInitResult } from "./types.js";
import {
	CRITIQUE_LOG_FILE,
	createWorkspaceId,
	delay,
	fileExists,
	LIVE_BRIDGE_INIT_TIMEOUT_MS,
	MANIFEST_FILE,
	normalizeSavedView,
	normalizeUserPath,
	normalizeWorkspacePath,
	nowIso,
	runBlenderJson,
	WORKSPACE_SCRIPT_FILE,
} from "./utils.js";

export function getManifestPath(workspacePath: string): string {
	return join(workspacePath, MANIFEST_FILE);
}

export function getWorkspaceScriptPath(workspacePath: string): string {
	return join(workspacePath, WORKSPACE_SCRIPT_FILE);
}

export function getWorkspaceCritiqueLogPath(workspacePath: string): string {
	return join(workspacePath, CRITIQUE_LOG_FILE);
}

export async function readManifest(workspacePath: string): Promise<BlenderWorkspaceManifest | undefined> {
	const manifestPath = getManifestPath(workspacePath);
	if (!(await fileExists(manifestPath))) {
		return undefined;
	}
	const raw = await readFile(manifestPath, "utf-8");
	let parsed: BlenderWorkspaceManifest;
	try {
		parsed = JSON.parse(raw) as BlenderWorkspaceManifest;
	} catch (error) {
		// A torn write (e.g. two writers racing the same file) used to surface as
		// a bare JSON.parse error with no path and no recovery hint.
		throw new Error(
			`Workspace manifest is not valid JSON: ${manifestPath}. It was probably written by a concurrent run. Inspect the file, then restore or delete it. (${
				error instanceof Error ? error.message : String(error)
			})`,
		);
	}
	// A saved view with no camera used to make normalizeSavedView throw, which
	// meant ONE bad historical entry made the whole manifest unreadable — and
	// it threw from inside the manifest lock, so even read-only callers failed.
	// A view is an optional convenience record; drop the broken ones and say so
	// rather than bricking the workspace.
	const savedViews: BlenderWorkspaceManifest["savedViews"] = {};
	for (const [name, savedView] of Object.entries(parsed.savedViews ?? {})) {
		try {
			savedViews[name] = normalizeSavedView(savedView);
		} catch (error) {
			console.warn(
				`[pi-blender] warning: ignoring saved view "${name}" in ${manifestPath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return {
		...parsed,
		savedViews,
		renderOutputs: parsed.renderOutputs ?? [],
		moduleRuns: parsed.moduleRuns ?? [],
	};
}

/**
 * Short-lived lock that makes the manifest's read-modify-write atomic.
 *
 * The bridge lock (utils.acquireBridgeLock) serializes *Blender requests*, but
 * the manifest is a separate resource with its own race: blender_execute_python
 * and blender_module_run each read `latestIteration`, compute N+1, and publish
 * back the snapshot they loaded at the start. Two runs — or a run plus a render
 * or a save-view — that overlap in that window land on the same iteration_NN
 * directory and clobber each other's moduleRuns/renderOutputs/savedViews.
 *
 * This lock is deliberately held only across read -> mutate -> write. It is
 * never held while a Blender script runs, so it cannot serialize real work.
 */
const MANIFEST_LOCK_FILE = ".manifest.lock";
const MANIFEST_LOCK_STALE_MS = 30_000;
const MANIFEST_LOCK_POLL_MS = 25;

async function acquireManifestLock(
	manifestPath: string,
	options?: { signal?: AbortSignal },
): Promise<() => Promise<void>> {
	const lockPath = join(dirname(manifestPath), MANIFEST_LOCK_FILE);
	const deadline = Date.now() + MANIFEST_LOCK_STALE_MS;

	while (true) {
		try {
			// wx = exclusive create; EEXIST means another writer is mid-update.
			const handle = await open(lockPath, "wx");
			await handle.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: nowIso() }), "utf-8");
			return async () => {
				await handle.close().catch(() => undefined);
				await rm(lockPath, { force: true }).catch(() => undefined);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				throw error;
			}

			// Reclaim a lock whose holder died mid-update.
			try {
				const stats = await stat(lockPath);
				if (Date.now() - stats.mtimeMs > MANIFEST_LOCK_STALE_MS) {
					await rm(lockPath, { force: true });
					continue;
				}
			} catch {
				// Holder released between the failed create and this stat.
				continue;
			}

			if (Date.now() >= deadline) {
				throw new Error(
					`Timed out waiting for the workspace manifest lock (${lockPath}). A writer is stuck mid-update; if no Blender work is running, delete that file and retry.`,
				);
			}
			await delay(MANIFEST_LOCK_POLL_MS, options?.signal);
		}
	}
}

/**
 * Atomically read-modify-write the manifest.
 *
 * Always re-reads from disk inside the lock and applies `mutate` to *that*
 * state, so a caller holding a stale snapshot (taken before a long Blender
 * script) merges its change into the current manifest instead of overwriting
 * whatever landed in the meantime. Prefer this over readManifest + writeManifest
 * for anything that mutates.
 *
 * If `mutate` throws, nothing is written.
 */
export async function updateManifest<T>(
	manifestPath: string,
	mutate: (manifest: BlenderWorkspaceManifest) => T | Promise<T>,
	options?: { signal?: AbortSignal },
): Promise<T> {
	const release = await acquireManifestLock(manifestPath, options);
	try {
		const current = await readManifest(dirname(manifestPath));
		if (!current) {
			throw new Error(`Workspace manifest not found: ${manifestPath}`);
		}
		const result = await mutate(current);
		await writeManifest(current);
		return result;
	} finally {
		await release();
	}
}

/**
 * Give a reserved-but-failed iteration number back, so a failed run still does
 * not look like progress in the manifest. No-ops when a later run has already
 * claimed a higher number — that run's progress must not be stomped.
 */
export async function releaseReservedIteration(manifestPath: string, iteration: number): Promise<void> {
	await updateManifest(manifestPath, (current) => {
		if (current.latestIteration === iteration) {
			current.latestIteration = iteration - 1;
		}
	});
}

export async function writeManifest(manifest: BlenderWorkspaceManifest): Promise<void> {
	manifest.version = 2;
	manifest.updatedAt = nowIso();
	// Atomic publish: a plain writeFile can be observed half-written by a
	// concurrent reader (or truncated by a crash), and the manifest is read
	// before nearly every tool call.
	const tempPath = `${manifest.manifestPath}.${process.pid}.tmp`;
	await writeFile(tempPath, JSON.stringify(manifest, null, 2), "utf-8");
	await rename(tempPath, manifest.manifestPath);
}

export async function ensureWorkspaceScriptExists(workspacePath: string): Promise<string> {
	const scriptPath = getWorkspaceScriptPath(workspacePath);
	if (!(await fileExists(scriptPath))) {
		await writeFile(scriptPath, "", "utf-8");
	}
	return scriptPath;
}

export async function ensureWorkspaceCritiqueLogExists(workspacePath: string): Promise<string> {
	const critiqueLogPath = getWorkspaceCritiqueLogPath(workspacePath);
	if (!(await fileExists(critiqueLogPath))) {
		await writeFile(critiqueLogPath, "", "utf-8");
	}
	return critiqueLogPath;
}

async function createBlankBlend(blendPath: string, cwd: string, signal?: AbortSignal): Promise<void> {
	const script = `
import bpy
import json
import sys

payload = json.loads(sys.argv[sys.argv.index("--") + 1])
bpy.ops.wm.save_as_mainfile(filepath=payload["blendPath"])
print("__PI_BLENDER_JSON_START__")
print(json.dumps({"blendPath": payload["blendPath"]}))
print("__PI_BLENDER_JSON_END__")
`;
	await runBlenderJson({
		cwd,
		scriptSource: script,
		payload: { blendPath },
		signal,
	});
}

/**
 * A camera, a three-point light rig, and a neutral world.
 *
 * Without this, a fresh workspace has no shot at all: createBlankBlend just
 * saves whatever Blender started as, and Blender's startup file has no camera
 * and no lights. Every worker then had to spend its one module slot building a
 * rig before it could model anything, and every new workspace paid that tax
 * again. The extension reports lights and render engine through
 * blender_scene_info but never created any, so nothing owned lighting.
 *
 * Objects are named with a "Studio" prefix and put in a "Studio" collection so
 * they are trivially distinguishable from the subject. Nothing here touches
 * geometry, so a module that deletes the studio rig cannot lose the model.
 *
 * Energies are tuned for a subject roughly 1-2 Blender units across at the
 * default camera distance; scale them for larger subjects. This is a starting
 * shot, not a final look.
 */
async function createStudioBlend(blendPath: string, cwd: string, signal?: AbortSignal): Promise<void> {
	const script = `
import json
import sys

# bpy and mathutils ship with Blender's Python runtime, so linters and pyright
# cannot resolve them outside a Blender environment. Same suppression style as
# blender/live-bridge.py.
import bpy  # pyright: ignore[reportMissingImports]
from mathutils import Vector  # pyright: ignore[reportMissingImports]

payload = json.loads(sys.argv[sys.argv.index("--") + 1])

# Start from a genuinely empty file rather than the user's startup scene, so a
# template workspace is reproducible and never inherits whatever the operator
# happened to have open.
bpy.ops.wm.read_homefile(use_empty=True)

scene = bpy.context.scene

# Neutral world: a mid-grey background reads as "studio" and gives ambient fill
# without inventing a sky the subject does not have. use_nodes is deprecated in
# Blender 5.x and the node tree already exists on a new world, so only set it
# when it is actually absent.
world = bpy.data.worlds.new("StudioWorld")
if not world.use_nodes:
    world.use_nodes = True
background = world.node_tree.nodes.get("Background")
if background is not None:
    background.inputs["Color"].default_value = (0.05, 0.05, 0.055, 1.0)
    background.inputs["Strength"].default_value = 1.0
scene.world = world

# Default render settings, so a fresh workspace is critic-ready: EEVEE for
# speed, and a resolution that matches what the subagents are told to render.
# The engine enum is version-dependent and hardcoding one string breaks on
# either side of the rename ("BLENDER_EEVEE" became "BLENDER_EEVEE_NEXT" in
# 4.2, then reverted to "BLENDER_EEVEE" in 5.x). Probe the live enum instead,
# so a template workspace opens on whatever Blender the user actually runs.
available_engines = {item.identifier for item in scene.render.bl_rna.properties["engine"].enum_items}
for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"):
    if candidate in available_engines:
        scene.render.engine = candidate
        break
scene.render.resolution_x = 1200
scene.render.resolution_y = 900
scene.render.resolution_percentage = 100

collection = bpy.data.collections.new("Studio")
scene.collection.children.link(collection)

# --- Camera: three-quarter front view, slightly above the subject centre. ---
camera_data = bpy.data.cameras.new("StudioCamera")
camera_data.lens = 50.0
camera = bpy.data.objects.new("StudioCamera", camera_data)
collection.objects.link(camera)

target = Vector((0.0, 0.0, 0.0))
camera.location = Vector((4.5, -6.0, 2.6))
direction = target - camera.location
camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
scene.camera = camera

# --- Three-point rig, aimed at the origin. ---
def add_area_light(name, location, energy, size, color):
    data = bpy.data.lights.new(name, type="AREA")
    data.energy = energy
    data.size = size
    data.color = color
    obj = bpy.data.objects.new(name, data)
    collection.objects.link(obj)
    obj.location = Vector(location)
    offset = target - obj.location
    obj.rotation_euler = offset.to_track_quat("-Z", "Y").to_euler()
    return obj

# Key is the dominant source and sits front-left, high; fill is weaker and
# opposite to open the shadows; rim separates the subject from the background.
add_area_light("StudioKey", (3.5, -4.0, 4.5), 900.0, 4.0, (1.0, 0.96, 0.9))
add_area_light("StudioFill", (-4.5, -2.5, 1.5), 250.0, 5.0, (0.85, 0.9, 1.0))
add_area_light("StudioRim", (-1.5, 4.5, 3.0), 600.0, 3.0, (1.0, 1.0, 1.0))

bpy.ops.wm.save_as_mainfile(filepath=payload["blendPath"])
print("__PI_BLENDER_JSON_START__")
print(json.dumps({"blendPath": payload["blendPath"], "template": "studio"}))
print("__PI_BLENDER_JSON_END__")
`;
	await runBlenderJson({
		cwd,
		scriptSource: script,
		payload: { blendPath },
		signal,
	});
}

export async function ensureWorkspaceInitialized(options: WorkspaceInitOptions): Promise<WorkspaceInitResult> {
	const workspacePath = normalizeWorkspacePath(options.cwd, options.workspace);
	const manifestPath = getManifestPath(workspacePath);
	const blendPath = join(workspacePath, "model.blend");
	// "studio" is the default: a blank workspace has no camera and no lights,
	// so the first worker otherwise has to spend its one module slot building a
	// shot before it can model anything. Callers that genuinely want Blender's
	// bare startup file still pass "blank" explicitly.
	const template = options.template ?? "studio";

	await mkdir(workspacePath, { recursive: true });

	const existingManifest = await readManifest(workspacePath);
	if (existingManifest) {
		// Same guard as loadWorkspaceManifest, and for the same reason: this is
		// a workspace-opening path, so it is exactly where a second instance
		// would otherwise put a second UI on one model.blend.
		const liveness = await classifyWorkspaceOwner(existingManifest);
		if (liveness === "live") {
			assertWorkspaceOwnership(existingManifest, await describeLiveOwner(existingManifest));
		}
		if (liveness === "dead" || liveness === "unknown") {
			await claimWorkspace(manifestPath, existingManifest.blendPath);
			existingManifest.owner = buildWorkspaceOwner(existingManifest.blendPath);
		}
		await ensureWorkspaceScriptExists(workspacePath);
		await ensureWorkspaceCritiqueLogExists(workspacePath);
		return {
			workspacePath,
			blendPath: existingManifest.blendPath,
			manifestPath,
			iteration: existingManifest.latestIteration,
			created: false,
		};
	}

	if (options.continueExisting) {
		throw new Error(`Workspace does not exist: ${workspacePath}`);
	}

	if (options.sourceBlend) {
		await copyFile(normalizeUserPath(options.cwd, options.sourceBlend), blendPath);
	} else {
		if (template === "studio") {
			await createStudioBlend(blendPath, options.cwd, options.signal);
		} else if (template === "blank") {
			await createBlankBlend(blendPath, options.cwd, options.signal);
		} else {
			throw new Error(`Unsupported Blender template: ${template}. Supported: "blank", "studio".`);
		}
	}

	const manifest: BlenderWorkspaceManifest = {
		version: 2,
		workspaceId: createWorkspaceId(),
		workspacePath,
		blendPath,
		manifestPath,
		createdAt: nowIso(),
		updatedAt: nowIso(),
		latestIteration: 0,
		template,
		owner: buildWorkspaceOwner(blendPath),
		sourceBlendPath: options.sourceBlend ? normalizeUserPath(options.cwd, options.sourceBlend) : undefined,
		savedViews: {},
		renderOutputs: [],
		// Seeded explicitly, not left to the reader's `?? []`. readManifest
		// normalises a missing array, so a manifest written without the key still
		// works -- but it is then a manifest whose module history is ABSENT rather
		// than empty, and any reader that goes around readManifest, any human
		// reading the file, and any diff of it all see `moduleRuns: null` and
		// cannot tell "no runs yet" from "the writer lost the field". Same
		// reasoning as savedViews/renderOutputs right above.
		moduleRuns: [],
	};
	await writeManifest(manifest);
	await ensureWorkspaceScriptExists(workspacePath);
	await ensureWorkspaceCritiqueLogExists(workspacePath);

	return {
		workspacePath,
		blendPath,
		manifestPath,
		iteration: 0,
		created: true,
	};
}

export function getIterationPaths(
	workspacePath: string,
	iteration: number,
): {
	iterationDir: string;
	rendersDir: string;
} {
	const iterationDir = join(workspacePath, `iteration_${String(iteration).padStart(2, "0")}`);
	return {
		iterationDir,
		rendersDir: join(iterationDir, "renders"),
	};
}

/**
 * Load a workspace manifest, refusing one another live pi instance is driving.
 *
 * This is the single chokepoint every workspace tool goes through -- render,
 * module run, execute, probe, save-view, critique, reference -- so the guard
 * lives here rather than in a helper each caller has to remember. A guard some
 * callers invoke is not a guard.
 *
 * A dead or unreadable claim is taken over rather than refused, so a crashed
 * session never locks the user out of their own workspace. When the claim is
 * taken over it is rewritten, because leaving a dead instance's id in the
 * manifest would make every later reader re-derive the same takeover.
 */
export async function loadWorkspaceManifest(cwd: string, workspace: string): Promise<BlenderWorkspaceManifest> {
	const workspacePath = normalizeWorkspacePath(cwd, workspace);
	const manifest = await readManifest(workspacePath);
	if (!manifest) {
		throw new Error(`Workspace manifest not found: ${getManifestPath(workspacePath)}`);
	}

	const liveness = await classifyWorkspaceOwner(manifest);
	if (liveness === "live") {
		assertWorkspaceOwnership(manifest, await describeLiveOwner(manifest));
	}
	if (liveness === "dead" || liveness === "unknown") {
		await claimWorkspace(manifest.manifestPath, manifest.blendPath);
	}
	return manifest;
}

/**
 * Record this process as the workspace's owner.
 *
 * Deliberately does not assert: claiming is the action that makes a workspace
 * MINE, so a caller that has already been refused has no business claiming it.
 * A refused workspace keeps its real owner's record intact.
 */
export async function claimWorkspace(manifestPath: string, blendPath: string): Promise<void> {
	await updateManifest(manifestPath, (current) => {
		current.owner = buildWorkspaceOwner(blendPath);
	});
}

export async function blenderWorkspaceInit(options: WorkspaceInitOptions): Promise<WorkspaceInitResult> {
	const result = await ensureWorkspaceInitialized(options);
	try {
		// Only impose the short best-effort budget when a UI is already up.
		// This is usually the FIRST blender_* call of a session, so the bridge
		// has usually not launched Blender yet — and the bridge only applies its
		// 120 s cold-start budget when the caller passes no timeout. Passing
		// LIVE_BRIDGE_INIT_TIMEOUT_MS unconditionally made the typical cold-start
		// init give up after 5 s and report openedInLiveBlender: false while
		// Blender was still booting. Leaving it undefined hands the decision to
		// the bridge, which already distinguishes the two cases.
		await requestLiveBlenderOpenBlend({
			blendPath: result.blendPath,
			signal: options.signal,
			timeoutMs: isLiveBridgeAlive() ? LIVE_BRIDGE_INIT_TIMEOUT_MS : undefined,
		});
		// A response is not a state. It proves that some Blender on this bridge
		// dir ran the open, and that Blender can be gone — or be a different
		// window than the one the next tool call gets answered by — before this
		// function returns. Reporting openedInLiveBlender: true on the strength
		// of the response alone is how a session whose UI had just been
		// relaunched onto its bootstrap blank was told it was looking at the
		// workspace blend, and only discovered otherwise on the next call. So
		// read what the live UI is actually on before claiming it.
		const live = await checkLiveBlenderBlend(result.blendPath, { signal: options.signal });
		if (!live.matches) {
			return {
				...result,
				openedInLiveBlender: false,
				liveBlenderMessage: live.heartbeatFresh
					? `The live Blender session ran the open but is showing "${
							live.liveBlendPath ?? "an unsaved scene"
						}" rather than "${result.blendPath}". Another Blender may have taken over this bridge; check blender_session_context before editing.`
					: `The Blender that ran the open is no longer running (no bridge heartbeat), so no live session is on "${result.blendPath}". The workspace is on disk and the next blender_* call will launch a UI.`,
			};
		}
		return {
			...result,
			openedInLiveBlender: true,
			liveBlenderMessage: "Opened workspace blend in the live Blender session.",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			...result,
			openedInLiveBlender: false,
			liveBlenderMessage: `Workspace created, but the live Blender session did not open it automatically: ${message}`,
		};
	}
}
