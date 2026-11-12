import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { requestLiveBlenderCompare } from "./bridge.js";
import { dispatchDeferredJob } from "./jobs.js";
import { normalizeViews } from "./montage.js";
import type { CompareOptions, CompareResult, DeferredJobHandle } from "./types.js";
import { getIterationPaths, loadWorkspaceManifest } from "./workspace.js";
import { decodePng } from "./png.js";

/**
 * Two generations of one subject on one sheet, labelled, framed identically.
 *
 * A regression is invisible in a single render, because each render overwrites
 * the last: "it looks the same as before" is an assertion about a picture nobody
 * is holding. So the baseline is rendered again from the checkpoint the earlier
 * run left on disk, and both generations land side by side with the generation
 * in each panel's label.
 *
 * The baseline is chosen from run history rather than demanded. A caller that has
 * to name a checkpoint path is a caller that has to know a format the workspace
 * already records; the default is the run immediately before this module's
 * latest, which is the comparison anyone means by "the previous run". An
 * explicit path still wins, because comparing against a named earlier iteration
 * is a real thing to want.
 *
 * Both generations are framed from the union of their extents inside Blender, so
 * the camera is identical across every panel and a difference between two panels
 * of the same view is geometry. Framing each generation on its own extent would
 * make a part that grew read as a camera change — the exact confusion this
 * sheet exists to remove.
 */
export async function blenderCompare(options: CompareOptions): Promise<CompareResult | DeferredJobHandle> {
	if (options.async) {
		return await dispatchDeferredJob(
			"compare",
			(signal) => executeCompare({ ...options, async: false, signal }),
			{
				workspace: options.workspace,
				moduleName: options.moduleName,
				views: options.views,
			},
		);
	}
	return await executeCompare(options);
}

async function executeCompare(options: CompareOptions): Promise<CompareResult> {
	const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
	const moduleDir = join(manifest.workspacePath, "modules", options.moduleName);

	// A stored packet already holds the current and previous pictures plus the
	// plan they were taken with. When the caller asked for the default
	// comparison, composing those files is the same sheet without a Blender
	// process; an explicit baseline or view list still needs a fresh render.
	// This has to run BEFORE normalizeViews, which refuses an empty list — the
	// packet's sheet already has the views it was rendered with.
	if (!options.baselineBlendPath && (options.views ?? []).length === 0) {
		const stored = storedPacketComparison(options, manifest);
		if (stored) return stored;
	}
	const views = normalizeViews(options.views ?? []);

	// Labels name the ITERATION rather than before/after, because a sheet is
	// read later than it is made — usually next to a third render — and
	// "BEFORE" has lost its referent by then. The number the manifest already
	// records is the one thing that still means something, and it says which
	// build to go and look at. An explicit path names a checkpoint the history
	// does not describe, so there is no honest number to print for it and it
	// falls back to the generation words.
	const baseline = options.baselineBlendPath
		? { checkpointPath: options.baselineBlendPath, iteration: undefined as number | undefined }
		: resolvePreviousCheckpoint(manifest, options.moduleName);
	const baselineLabel =
		options.baselineLabel ?? (baseline.iteration === undefined ? "BEFORE" : `ITERATION ${baseline.iteration}`);
	const currentLabel =
		options.currentLabel ?? (manifest.latestIteration > 0 ? `ITERATION ${manifest.latestIteration}` : "AFTER");

	const bridgeResult = await requestLiveBlenderCompare({
		blendPath: manifest.blendPath,
		baselineBlendPath: baseline.checkpointPath,
		baselineLabel,
		currentLabel,
		views,
		subject: options.subject,
		columns: options.columns,
		panelResolution: options.panelResolution,
		outputDir: moduleDir,
		outputName: "compare.png",
		signal: options.signal,
		timeoutMs: options.timeoutMs,
	});

	if (!existsSync(bridgeResult.montagePath)) {
		throw new Error(
			`Blender reported the comparison sheet at ${bridgeResult.montagePath} but no file is there, so the sheet was not written. The panels are still at ${bridgeResult.panelPaths.join(", ")}.`,
		);
	}

	const iteration = manifest.latestIteration > 0 ? manifest.latestIteration : 1;
	const { iterationDir } = getIterationPaths(manifest.workspacePath, iteration);
	await mkdir(iterationDir, { recursive: true });

	const result: CompareResult = {
		workspacePath: manifest.workspacePath,
		manifestPath: manifest.manifestPath,
		montagePath: bridgeResult.montagePath,
		panelPaths: bridgeResult.panelPaths,
		views: bridgeResult.views,
		layout: bridgeResult.layout,
		subject: bridgeResult.subject,
		labels: bridgeResult.labels,
		baseline: bridgeResult.baseline,
		framing: bridgeResult.framing,
		note: bridgeResult.note,
	};

	await writeFile(join(iterationDir, "compare.json"), JSON.stringify(result, null, 2), "utf-8");
	return result;
}

/**
 * The comparison a completed packet already contains.
 *
 * The packet's panels were rendered with the same plan and stored beside the
 * numbers that explain them, so re-rendering two checkpoints to reconstruct the
 * same picture would spend a Blender start to arrive at a sheet already on disk.
 * Only the default comparison qualifies: a caller naming a baseline or a view
 * is asking a question the packet was not built to answer.
 */
function storedPacketComparison(
	options: CompareOptions,
	manifest: Awaited<ReturnType<typeof loadWorkspaceManifest>>,
): CompareResult | null {
	const runs = (manifest.branchRuns ?? [])
		.filter((run) => run.module === options.moduleName && run.reviewPacket?.comparePath)
		.sort((a, b) => (b.sequence ?? b.iteration) - (a.sequence ?? a.iteration));
	const current = runs[0];
	const packet = current?.reviewPacket;
	if (!current || !packet?.comparePath || !packet.dir || !existsSync(packet.comparePath)) return null;
	let record: { panels?: { name: string; file: string }[]; cameraPlan?: { shots?: unknown[] } };
	try {
		record = JSON.parse(readFileSync(join(packet.dir, "packet.json"), "utf-8"));
	} catch {
		return null;
	}
	const panels = record.panels ?? [];
	const previousPanel = panels.find((panel) => panel.name.startsWith("previous"))?.file;
	if (!previousPanel) return null;
	const latestSequence = Math.max(
		...[...(manifest.branchRuns ?? []), ...(manifest.moduleRuns ?? [])]
			.filter((run) => ("module" in run ? run.module : run.name) === options.moduleName)
			.map((run) => run.sequence ?? run.iteration),
	);
	if (current.sequence !== latestSequence) return null;
	const image = decodePng(readFileSync(packet.comparePath));
	const previousIteration = Number(
		packet.previousDir?.match(/iterations\/(\d+)/)?.[1] ?? Math.max(1, current.iteration - 1),
	);
	const baselineLabel = `ITERATION ${previousIteration}`;
	const currentLabel = `ITERATION ${current.iteration}`;
	return {
		workspacePath: manifest.workspacePath,
		manifestPath: manifest.manifestPath,
		montagePath: packet.comparePath,
		panelPaths: panels.map((panel) => panel.file),
		views: ["stored"],
		layout: {
			panelWidth: 640,
			panelHeight: 480,
			aspect: 640 / 480,
			columns: panels.length,
			rows: 1,
		},
		subject: [],
		framing: { fromUnion: true, family: "orbit", center: [0, 0, 0], radius: 0, distance: 0, views: [] },
		labels: { baseline: baselineLabel, current: currentLabel },
		baseline: {
			blendPath: "",
			panelPaths: previousPanel ? [previousPanel] : [],
			missingSubjects: [],
			usedItsOwnExtent: false,
		},
		note: "Composed from the stored review packets; no Blender process was spawned.",
	};
}

/**
 * The checkpoint of the run immediately before this module's latest one.
 *
 * A checkpoint IS the state a run started from, so the previous run's
 * checkpoint is exactly what that run rendered — the baseline the sheet wants
 * without needing a render from that generation to have been kept.
 *
 * The baseline is this module's previous run THAT HAS A CHECKPOINT, and the
 * module's LATEST run is required to have one too. The two rules exist because
 * a record with no checkpointPath cannot be a baseline -- there is no file to
 * hand the bridge -- and the filter that guarantees the first rule used to
 * guarantee the second one silently as well: a latest run with no checkpoint
 * was filtered out and `at(-2)` then handed back the run before THAT one, so
 * the sheet compared two generations ago and reported it as the latest
 * comparison. Every recorded run in this repo does carry a checkpoint
 * (blender/branch.ts:557 and blender/module.ts:260 each copy model.blend
 * before writing their record), but the manifest is read from disk as untyped
 * JSON and a record from an older build need not, and a diagnostic tool that
 * answers the wrong question silently is worse than one that refuses.
 *
 * A run and its apply are ONE event, not two: the headless path runs a branch
 * and then applies it, and both write a record sharing the run's sequence. Keyed
 * by sequence and de-duplicated, or a single run looks like a previous
 * generation to compare against and the sheet compares the build with itself --
 * the exact false all-clear this function exists to prevent. The merge keeps the
 * branchRuns entry, which is the one that names the checkpoint the run started
 * from, which is the state that run rendered. De-duplicated on BOTH lists before
 * the ordering, so a sequence belonging to another module cannot reorder this
 * module's generations.
 *
 * Fewer than two checkpointed generations raises. A first run has nothing
 * before it, and with only one available the answer would be a sheet of
 * identical pairs that reads as proof of stability.
 *
 * The iteration comes back with the path because the sheet's labels print it: a
 * panel that says which iteration it is still means something once it is sitting
 * next to a third render.
 */
export function resolvePreviousCheckpoint(
	manifest: {
		branchRuns?: { module: string; sequence: number; iteration?: number; checkpointPath?: string }[];
		moduleRuns?: { name: string; sequence: number; iteration?: number; checkpointPath?: string }[];
	},
	moduleName: string,
): { checkpointPath: string; iteration: number | undefined } {
	// Every run of THIS module, in order, whether or not it carries a
	// checkpoint -- the latest one has to be visible here, because a latest run
	// with no checkpoint is the case that must raise rather than be skipped.
	const bySequence = new Map<number, { checkpointPath: string | undefined; iteration: number | undefined }>();
	for (const run of manifest.branchRuns ?? []) {
		if (run.module === moduleName) {
			bySequence.set(run.sequence, { checkpointPath: run.checkpointPath, iteration: run.iteration });
		}
	}
	for (const run of manifest.moduleRuns ?? []) {
		// branchRuns wins a shared sequence: it is the record that names the
		// checkpoint the run started from, which is the state that run rendered.
		if (run.name === moduleName && !bySequence.has(run.sequence)) {
			bySequence.set(run.sequence, { checkpointPath: run.checkpointPath, iteration: run.iteration });
		}
	}
	const runs = [...bySequence.entries()]
		.sort((a, b) => a[0] - b[0])
		.map(([, run]) => run);

	const latest = runs.at(-1);
	if (!latest) {
		// Its own message: "the latest one records no checkpoint" is nonsense
		// when there is no latest one, and the two cases need different
		// advice (the second is a manifest the caller pointed at the wrong
		// module or a workspace that was never run).
		throw new Error(
			`Module "${moduleName}" has no recorded runs, so there is nothing to compare against. ` +
				`Run the module, or pass baselineBlendPath pointing at a checkpoint from a run that already had ${moduleName} in it.`,
		);
	}
	if (!latest.checkpointPath) {
		throw new Error(
			`Module "${moduleName}" has ${runs.length} recorded run${runs.length === 1 ? "" : "s"} but its latest one records no checkpoint, so there is no build to compare the current state against. ` +
				`Run the module again, or pass baselineBlendPath pointing at a checkpoint from a run that already had ${moduleName} in it.`,
		);
	}

	// The generation before the latest, skipping only runs that cannot be a
	// baseline. Every run here is this module's, in this module's order.
	const previous = runs
		.slice(0, -1)
		.filter((run) => run.checkpointPath)
		.at(-1);
	if (!previous?.checkpointPath) {
		throw new Error(
			`Module "${moduleName}" has ${runs.length} recorded run${runs.length === 1 ? "" : "s"}, so there is no previous generation to compare against — a comparison needs at least two with a checkpoint. ` +
				`Run the module again, or pass baselineBlendPath pointing at a checkpoint from a run that already had ${moduleName} in it.`,
		);
	}
	return { checkpointPath: previous.checkpointPath, iteration: previous.iteration };
}
