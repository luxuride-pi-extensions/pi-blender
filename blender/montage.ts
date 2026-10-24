import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requestLiveBlenderMontage } from "./bridge.js";
import { dispatchDeferredJob } from "./jobs.js";
import type { DeferredJobHandle, MontageOptions, MontageResult } from "./types.js";
import { getIterationPaths, loadWorkspaceManifest } from "./workspace.js";

/**
 * Render several fixed-orbit views of one subject and tile them into a sheet.
 *
 * The camera placement is why this lives in Blender rather than in an image
 * editor: one bounding sphere, one distance, a table of preset angles, and
 * every panel framed identically. Two panels that differ then differ because
 * the geometry differs, which is the only comparison a sheet supports. A
 * montage assembled by eye is a collage, and a collage invites reading a
 * difference in framing as a difference in the model.
 *
 * The panels land on disk individually as well as in the sheet, because the
 * sheet is downsampled to fit an image context and a suspicious panel is worth
 * re-reading at full size.
 *
 * Read-only with respect to the file it photographs: the resolution, file
 * format, filepath, scene camera and viewport are snapshotted and restored
 * inside the bridge, and the temporary cameras are removed.
 */

export async function blenderMontage(options: MontageOptions): Promise<MontageResult | DeferredJobHandle> {
	if (options.async) {
		return await dispatchDeferredJob(
			"montage",
			() => executeMontage({ ...options, async: false }),
			{
				workspace: options.workspace,
				moduleName: options.moduleName,
				views: options.views,
			},
		);
	}
	return await executeMontage(options);
}

async function executeMontage(options: MontageOptions): Promise<MontageResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const views = normalizeViews(options.views);
	const outputDir = join(manifest.workspacePath, "modules", options.moduleName);

	const bridgeResult = await requestLiveBlenderMontage({
		blendPath: manifest.blendPath,
		views,
		subject: options.subject,
		columns: options.columns,
		panelResolution: options.panelResolution,
		outputDir,
		outputName: "montage.png",
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});

	if (!existsSync(bridgeResult.montagePath)) {
		throw new Error(
			`Blender reported the montage at ${bridgeResult.montagePath} but no file is there, so the sheet was not written. The panels are still at ${bridgeResult.panelPaths.join(", ")}.`,
		);
	}

	const iteration = manifest.latestIteration > 0 ? manifest.latestIteration : 1;
	const { iterationDir } = getIterationPaths(manifest.workspacePath, iteration);
	await mkdir(iterationDir, { recursive: true });

	const result: MontageResult = {
		workspacePath: manifest.workspacePath,
		manifestPath: manifest.manifestPath,
		montagePath: bridgeResult.montagePath,
		panelPaths: bridgeResult.panelPaths,
		views: bridgeResult.views,
		layout: bridgeResult.layout,
		subject: bridgeResult.subject,
		framing: bridgeResult.framing,
		note: bridgeResult.note,
	};

	await writeFile(join(iterationDir, "montage.json"), JSON.stringify(result, null, 2), "utf-8");
	return result;
}

/**
 * The preset view names, mirrored here so the tool can reject a misspelling
 * before spending a render on the panels that did resolve.
 *
 * The Python side raises its own ValueError listing the same names; this list
 * exists so the rejection arrives without a cold start and without waiting on
 * a scene that is not the workspace.
 */
const KNOWN_ORBIT_VIEWS = [
	"front",
	"back",
	"left",
	"right",
	"top",
	"bottom",
	"three-quarter",
	"three-quarter-left",
	"three-quarter-high",
	"profile-left",
	"profile-right",
	"front-high",
] as const;

/**
 * Presets that stand inside the subject at eye height rather than orbiting it.
 * A room has no silhouette to orbit, and a room's bounding-sphere radius puts
 * the camera outside the building, so the two families cannot be one formula.
 */
const KNOWN_INTERIOR_VIEWS = [
	"interior-corner",
	"interior-corner-left",
	"interior-corner-right",
	"interior-elevated",
	"interior-doorway",
	"interior-low",
] as const;

const KNOWN_VIEWS: readonly string[] = [...KNOWN_ORBIT_VIEWS, ...KNOWN_INTERIOR_VIEWS];

/**
 * Shared with the comparison sheet, which tiles the same preset views twice and
 * must refuse the same misspellings for the same reason: half its panels would
 * render and the sheet would read as a result.
 */
export function normalizeViews(views: string[]): string[] {
	if (views.length === 0) {
		throw new Error(`A montage needs at least one view. Known views: ${KNOWN_VIEWS.join(", ")}.`);
	}
	const unknown = views.filter((view) => !(KNOWN_VIEWS as readonly string[]).includes(view));
	if (unknown.length > 0) {
		throw new Error(
			`Unknown montage view(s): ${unknown.join(", ")}. Known views: ${KNOWN_VIEWS.join(", ")}.`,
		);
	}
	return views;
}
