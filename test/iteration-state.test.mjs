import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { loadTs } from "./paths.mjs";

/**
 * blender_iteration_state exists because a manager's own memory of its loop is
 * the least reliable place to keep it: a prompt fold, a fresh critic or a
 * crashed subagent all erase it. These tests hold the state to that promise —
 * every fact comes from files on disk, so a cold process sees the same budget
 * a warm one did.
 */

const root = mkdtempSync(join(tmpdir(), "pi-blender-iteration-state-"));
after(() => rmSync(root, { recursive: true, force: true }));

const { blenderIterationState } = await loadTs("../blender/iteration-state.ts");

/** A workspace with a manifest and, optionally, a critique log. */
function makeWorkspace(name, { manifest, critique } = {}) {
  const workspacePath = join(root, name);
  mkdirSync(join(workspacePath, "modules"), { recursive: true });
  const manifestPath = join(workspacePath, "blender-workspace.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 2,
      workspaceId: name,
      workspacePath,
      blendPath: join(workspacePath, "model.blend"),
      manifestPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      latestIteration: 0,
      template: "studio",
      savedViews: {},
      renderOutputs: [],
      ...manifest,
    }),
  );
  if (critique !== undefined) writeFileSync(join(workspacePath, "critique.log"), critique);
  return workspacePath;
}

/** A branch run record shaped like the one blender_branch_run stages. */
function branchRun(iteration, stateDigest, module = "mug") {
  return {
    module,
    iteration,
    sequence: iteration,
    branchPath: `/ws/modules/${module}/branch.blend`,
    scriptPath: `/ws/modules/${module}/script.py`,
    checkpointPath: `/ws/modules/${module}/runs/${String(iteration).padStart(2, "0")}/pre-${String(iteration).padStart(2, "0")}.blend`,
    at: "2026-01-01T00:00:00.000Z",
    status: "staged",
    touchedObjects: [],
    touchedMaterials: [],
    addedObjects: [],
    removedObjects: [],
    applyObjects: [],
    stateDigest,
  };
}

/** A critique log block shaped like the one blender_log_critique appends. */
function critiqueBlock({ iteration = 1, module = "mug", score = 8, decision = "continue iterating", view = 2, reason } = {}) {
  const axes = ["Accuracy", "Geometry", "Materials", "Completeness", "Quality", "Category validity"];
  const lines = [
    `[2026-01-01T00:00:00.000Z] iteration_${String(iteration).padStart(2, "0")} module=${module} budget ${iteration}/5`,
    `Score: ${score}/12`,
  ];
  for (const axis of axes) lines.push(`${axis}: 1/2`);
  lines.push(`View adequacy: ${view}/2`, "Decision: " + (reason ? `REJECT — ${reason}` : decision));
  return lines.join("\n") + "\n\n";
}

const manifestFor = (extra) => extra;

test("reports the budget from the manifest, not from a remembered count", async () => {
  const workspacePath = makeWorkspace("budget", { manifest: manifestFor({ critiqueCounts: { mug: 3 } }) });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.budget.used, 3);
  assert.equal(state.budget.max, 5);
  assert.equal(state.budget.remaining, 2);
  assert.equal(state.budget.exhausted, false);
});

test("an exhausted budget is reported as exhausted, not as a suggestion", async () => {
  const workspacePath = makeWorkspace("exhausted", { manifest: manifestFor({ critiqueCounts: { mug: 5 } }) });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.budget.exhausted, true);
  assert.equal(state.budget.remaining, 0);
  assert.equal(state.wasteGuard.kind, "budget-exhausted");
});

test("an identical digest for two consecutive runs is a waste guard, not a verdict to re-earn", async () => {
  const workspacePath = makeWorkspace("unchanged", {
    manifest: manifestFor({ branchRuns: [branchRun(1, "aaa"), branchRun(2, "aaa")] }),
  });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.lastRun.iteration, 2);
  assert.equal(state.wasteGuard.kind, "unchanged-digest");
  assert.match(state.wasteGuard.detail, /same content/);
});

test("a different digest between the judged run and the fix leaves no waste guard", async () => {
  const log = critiqueBlock({ iteration: 1, score: 7, decision: "continue iterating" });
  const workspacePath = makeWorkspace("landed", {
    manifest: manifestFor({ branchRuns: [branchRun(1, "aaa"), branchRun(2, "bbb")], critiqueCounts: { mug: 1 } }),
    critique: log,
  });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.fixLanded, true);
  assert.equal(state.wasteGuard.kind, "none");
});

test("a run after the critique that did not move the content reports the fix as not landed", async () => {
  const log = critiqueBlock({ iteration: 1, score: 7, decision: "continue iterating" });
  const workspacePath = makeWorkspace("notlanded", {
    manifest: manifestFor({ branchRuns: [branchRun(1, "aaa"), branchRun(2, "aaa")], critiqueCounts: { mug: 1 } }),
    critique: log,
  });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.fixLanded, false);
});

test("two consecutive critiques at the same score are a stall", async () => {
  const log =
    critiqueBlock({ iteration: 1, score: 6, decision: "continue iterating" }) +
    critiqueBlock({ iteration: 2, score: 6, decision: "continue iterating" });
  const workspacePath = makeWorkspace("stalled", {
    manifest: manifestFor({ branchRuns: [branchRun(1, "aaa"), branchRun(2, "bbb")], critiqueCounts: { mug: 2 } }),
    critique: log,
  });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.lastVerdict.score, 6);
  assert.equal(state.previousScore, 6);
  assert.equal(state.wasteGuard.kind, "score-stalled");
});

test("a presentation carries its reject-free verdict and threshold", async () => {
  const log = critiqueBlock({ iteration: 1, score: 11, decision: "present to user" });
  const workspacePath = makeWorkspace("presented", {
    manifest: manifestFor({ branchRuns: [branchRun(1, "aaa")], critiqueCounts: { mug: 0 } }),
    critique: log,
  });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.lastVerdict.verdict, "present");
  assert.equal(state.lastVerdict.score, 11);
  assert.equal(state.presentThreshold, 8);
});

test("recorded probe facts are handed back instead of being re-measured", async () => {
  const facts = [{ statement: "Mug is 0.4m below the table plane", source: "geometry-probe pair check", iteration: 2, at: "2026-01-01T00:00:00.000Z" }];
  const workspacePath = makeWorkspace("facts", { manifest: manifestFor({ iterationNotes: { mug: facts } }) });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.knownFacts.length, 1);
  assert.equal(state.knownFacts[0].statement, facts[0].statement);
  assert.equal(state.knownFacts[0].source, "geometry-probe pair check");
});

test("a module with no history is a clean slate, not an error", async () => {
  const workspacePath = makeWorkspace("fresh", {});
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.budget.used, 0);
  assert.equal(state.lastRun, undefined);
  assert.equal(state.lastVerdict, undefined);
  assert.equal(state.knownFacts.length, 0);
  assert.equal(state.wasteGuard.kind, "none");
});

test("another module's runs and critiques are not this module's state", async () => {
  const log = critiqueBlock({ iteration: 1, module: "chair", score: 4, decision: "continue iterating" });
  const workspacePath = makeWorkspace("isolation", {
    manifest: manifestFor({ branchRuns: [branchRun(1, "aaa", "chair")], critiqueCounts: { chair: 1 } }),
    critique: log,
  });
  const state = await blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "mug" });
  assert.equal(state.lastRun, undefined);
  assert.equal(state.lastVerdict, undefined);
  assert.equal(state.budget.used, 0);
});

test("a missing moduleName is refused rather than summarised for every module at once", async () => {
  const workspacePath = makeWorkspace("no-name", {});
  await assert.rejects(
    () => blenderIterationState({ cwd: root, workspace: workspacePath, moduleName: "  " }),
    /requires the moduleName/,
  );
});
