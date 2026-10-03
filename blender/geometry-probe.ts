import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requestLiveBlenderGeometryProbe } from "./bridge.js";
import type { GeometryProbeOptions, GeometryProbeWorkspaceResult } from "./types.js";
import { LIVE_BRIDGE_TIMEOUT_MS } from "./utils.js";
import { getIterationPaths, loadWorkspaceManifest } from "./workspace.js";

/**
 * Measure mesh/transform relationships in the live Blender scene.
 *
 * Read-only by construction: the probe builds BVHs and reads world-space
 * vertex coordinates, and never mutates or saves. It claims no iteration and
 * writes no module state, so a diagnostician can call it while a worker has a
 * module mid-flight without disturbing the run history.
 *
 * The numbers exist so that "the handle is in the wrong place" stops being a
 * judgement call: gap distance, penetration depth, thin-axis angle and ring
 * roundness are the facts a fix should be argued from.
 */
/**
 * How many plain-bridge round-trips a probe may take by default.
 *
 * A probe is the only read the extension does that scales with scene size:
 * `bounds`/`axis` sample vertices, and `topology` builds a full bmesh per mesh.
 * 4x the 30s round-trip is 120s — enough for a heavy scene, and exactly the
 * cold-start budget, so a dead bridge still reports at the same time a cold
 * one would have come up.
 */
const PROBE_TIMEOUT_MULTIPLIER = 4;

export async function blenderGeometryProbe(options: GeometryProbeOptions): Promise<GeometryProbeWorkspaceResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const bridgeResult = await requestLiveBlenderGeometryProbe({
		blendPath: manifest.blendPath,
		objects: options.objects,
		pairs: options.pairs,
		checks: options.checks,
		specifications: options.specifications,
		tolerance: options.tolerance,
		expectedAxis: options.expectedAxis,
		cell: options.cell,
		body: options.body,
		signal: options.signal,
		// A probe on a heavy scene builds BVH trees for every sampled mesh, so
		// give it more headroom than a plain bridge round-trip, but stay far
		// below the cold-start budget so a dead bridge still reports quickly.
		//
		// The caller's explicit timeoutMs always wins, INCLUDING when a signal is
		// present. This used to read `options.signal ? undefined : (…)`, which
		// meant the headroom applied to nobody: every tool call carries a signal,
		// so the probe always fell back to the 30s LIVE_BRIDGE_TIMEOUT_MS the
		// comment above is trying to avoid, and a `topology` check (one bmesh
		// pass per mesh) on a heavy scene timed out while holding the global
		// bridge lock.
		timeoutMs: options.timeoutMs ?? LIVE_BRIDGE_TIMEOUT_MS * PROBE_TIMEOUT_MULTIPLIER,
	});

	const warnings: string[] = [];
	// The probe reads the live scene, which is only the workspace blend if the
	// UI actually has that file open. A stale or different blend makes every
	// number describe something other than the workspace, so say so loudly
	// rather than letting the analyst report confident measurements of the
	// wrong scene.
	const matchesWorkspace = bridgeResult.blendPath === manifest.blendPath;
	if (!matchesWorkspace) {
		warnings.push(
			`The live Blender session has ${bridgeResult.blendPath ?? "no file open"}, which is not the workspace blend ${manifest.blendPath}. These measurements describe the live scene, not the workspace. Open the workspace blend in Blender and re-probe before acting on them.`,
		);
	}
	if (bridgeResult.isDirty) {
		warnings.push(
			"The live Blender session has unsaved changes. Measurements reflect the current in-memory scene, which may not match model.blend on disk.",
		);
	}
	if (options.objects && options.objects.length === 0 && !options.pairs) {
		warnings.push("No objects were passed and no pairs were given; every visible mesh in the scene was probed.");
	}

	const iteration = manifest.latestIteration > 0 ? manifest.latestIteration : 1;
	const { iterationDir } = getIterationPaths(manifest.workspacePath, iteration);
	await mkdir(iterationDir, { recursive: true });

	const result: GeometryProbeWorkspaceResult = {
		...bridgeResult,
		workspacePath: manifest.workspacePath,
		manifestPath: manifest.manifestPath,
		iteration,
		matchesWorkspace,
		warnings,
	};

	// Persisted next to the iteration's other inspection artifacts so a
	// measurement is reproducible after the fact instead of living only in a
	// subagent transcript.
	await writeFile(join(iterationDir, "geometry-probe.json"), JSON.stringify(result, null, 2), "utf-8");
	return result;
}
