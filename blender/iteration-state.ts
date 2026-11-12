import { MAX_ITERATIONS_PER_MODULE, PRESENT_SCORE_THRESHOLD } from "./critique.js";
import { parseCritiqueLog } from "./ranking.js";
import { readFile } from "node:fs/promises";
import { getWorkspaceCritiqueLogPath, loadWorkspaceManifest } from "./workspace.js";
import { collectModuleGenerations, isComparableStateDigest } from "./generations.js";
import type {
  BlenderWorkspaceManifest,
  CritiqueVerdictRecord,
  IterationState,
  IterationWasteGuard,
} from "./types.js";

/**
 * Where the iteration state comes from, and why it is derived rather than
 * remembered:
 *
 * The manager's own context is the least reliable place to keep it. A prompt
 * fold, a fresh critic, or a crashed subagent all erase whatever the manager
 * had counted, and a loop that has forgotten its budget is a loop that runs
 * forever. Everything here is read back out of files that outlive the session:
 * the manifest for what ran, the critique log for what it was worth, and the
 * recorded probe facts for what has already been established.
 */

interface RunStamp {
  iteration: number;
  sequence: number;
  stateDigest?: string;
  executionMode: "branch" | "live";
}

/**
 * Newest first, and only APPLIED generations: a failed script, a conflicted
 * merge and a branch that is still waiting for its apply are not states the next
 * run can be compared against, because none of them is in model.blend.
 */
function collectRuns(manifest: BlenderWorkspaceManifest, moduleName: string): RunStamp[] {
	return collectModuleGenerations(manifest, moduleName)
		.map((generation) => ({
			iteration: generation.iteration,
			sequence: generation.sequence,
			stateDigest: generation.stateDigest,
			executionMode: generation.executionMode,
		}))
		// The generations are already in sequence order. Sorting by iteration
		// here would be a second notion of "newest" and disagree for any record
		// whose iteration and sequence were claimed separately.
		.sort((a, b) => b.sequence - a.sequence);
}

function latestVerdict(entries: CritiqueVerdictRecord[], moduleName: string): CritiqueVerdictRecord | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.moduleName === moduleName) return entry;
  }
  return undefined;
}

/**
 * Did a brief actually reach the geometry? Two runs with the same digest are
 * the same bytes, so a re-brief that produced no digest movement changed
 * nothing a critic could see.
 */
function resolveWasteGuard(args: {
  budgetUsed: number;
  runs: RunStamp[];
  verdict: CritiqueVerdictRecord | undefined;
  previousScore: number | undefined;
  fixLanded: boolean | undefined;
}): IterationWasteGuard {
  const { budgetUsed, runs, verdict, previousScore, fixLanded } = args;
  if (budgetUsed >= MAX_ITERATIONS_PER_MODULE) {
    return {
      kind: "budget-exhausted",
      detail: `${budgetUsed} of ${MAX_ITERATIONS_PER_MODULE} iterations are spent. Spend another only with a different plan, not a re-brief of the same one.`,
    };
  }
  const [newest, previous] = runs;
  if (isComparableStateDigest(newest?.stateDigest) && newest.stateDigest === previous?.stateDigest) {
    return {
      kind: "unchanged-digest",
      detail: `Iteration ${newest.iteration} produced the same content as iteration ${previous.iteration}. A render of it would repeat the last verdict; find why the script did not change the build before running or critiquing again.`,
    };
  }
  if (fixLanded === false) {
    return {
      kind: "fix-did-not-land",
      detail: "The last brief was followed by a run, but the content did not move. The fix is either absent from the script or was overwritten by another module's apply.",
    };
  }
  if (verdict?.verdict === "continue" && previousScore !== undefined && verdict.score === previousScore) {
    return {
      kind: "score-stalled",
      detail: `Two consecutive critiques scored ${verdict.score}. The same approach is not converging; diagnose the specific axis, or reject the brief.`,
    };
  }
  return { kind: "none", detail: "No waste guard is triggered. Spending a run and a fresh critic is justified." };
}

export async function blenderIterationState(options: {
  cwd: string;
  workspace: string;
  moduleName: string;
  signal?: AbortSignal;
}): Promise<IterationState> {
  const manifest = await loadWorkspaceManifest(options.cwd, options.workspace);
  const moduleName = options.moduleName.trim();
  if (!moduleName) {
    throw new Error("blender_iteration_state requires the moduleName it is reporting on. One module's history cannot be summarised for all of them.");
  }

  const budgetUsed = manifest.critiqueCounts?.[moduleName] ?? 0;
  const runs = collectRuns(manifest, moduleName);

  let entries: CritiqueVerdictRecord[] = [];
  try {
    entries = parseCritiqueLog(await readFile(getWorkspaceCritiqueLogPath(manifest.workspacePath), "utf8"));
  } catch {
    entries = [];
  }
  const verdict = latestVerdict(entries, moduleName);
  const previousVerdict = verdict
    ? [...entries].reverse().find((entry) => entry !== verdict && entry.moduleName === moduleName)
    : undefined;

  // The critic judged a render, the render came from a run, and the fix is the
  // NEXT run. Landed means a later run moved the content.
  const judgedRun = verdict?.iteration === undefined ? undefined : runs.find((run) => run.iteration === verdict.iteration);
  const laterRun = judgedRun ? runs.find((run) => run.iteration > judgedRun.iteration) : undefined;
  const fixLanded =
    isComparableStateDigest(judgedRun?.stateDigest) && isComparableStateDigest(laterRun?.stateDigest)
      ? judgedRun.stateDigest !== laterRun.stateDigest
      : undefined;

  const timed = (manifest.moduleRuns ?? []).filter(
    (run) => run.name === moduleName && run.status === "ok" && run.timings,
  );
  const timings = timed.length
    ? {
        runs: timed.length,
        launchMs: timed.reduce((sum, run) => sum + (run.timings?.launchMs ?? 0), 0),
        importMs: timed.reduce((sum, run) => sum + (run.timings?.importMs ?? 0), 0),
        execMs: timed.reduce((sum, run) => sum + (run.timings?.execMs ?? 0), 0),
        saveMs: timed.reduce((sum, run) => sum + (run.timings?.saveMs ?? 0), 0),
        renderMs: timed.reduce((sum, run) => sum + (run.timings?.renderMs ?? 0), 0),
        totalMs: timed.reduce((sum, run) => sum + (run.timings?.totalMs ?? 0), 0),
      }
    : undefined;

  return {
    workspacePath: manifest.workspacePath,
    blendPath: manifest.blendPath,
    module: moduleName,
    presentThreshold: PRESENT_SCORE_THRESHOLD,
    budget: {
      used: budgetUsed,
      max: MAX_ITERATIONS_PER_MODULE,
      remaining: Math.max(0, MAX_ITERATIONS_PER_MODULE - budgetUsed),
      exhausted: budgetUsed >= MAX_ITERATIONS_PER_MODULE,
    },
    lastRun: runs[0]
      ? { iteration: runs[0].iteration, stateDigest: runs[0].stateDigest, executionMode: runs[0].executionMode }
      : undefined,
    lastVerdict: verdict
      ? {
          iteration: verdict.iteration,
          verdict: verdict.verdict,
          score: verdict.score,
          viewUsable: verdict.viewUsable,
          rejectReason: verdict.rejectReason,
          axes: verdict.axes ?? {},
          // An absent axes map is "not logged", not "nothing is blocking":
          // turning it into [] would claim all six axes scored at least 2.
          blockingAxes: verdict.axes
            ? Object.entries(verdict.axes)
                .filter(([, score]) => score <= 1)
                .map(([label]) => label)
            : undefined,
          issues: verdict.issues,
          nextAction: verdict.nextAction,
        }
      : undefined,
    previousScore: previousVerdict?.score,
    fixLanded,
    knownFacts: manifest.iterationNotes?.[moduleName] ?? [],
    wasteGuard: resolveWasteGuard({ budgetUsed, runs, verdict, previousScore: previousVerdict?.score, fixLanded }),
    timings,
  };
}
