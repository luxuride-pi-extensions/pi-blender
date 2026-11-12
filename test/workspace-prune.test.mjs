import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { loadTs } from "./paths.mjs";

/**
 * Pruning is a policy, not a clean-up habit: the newest render per module and
 * the render a current critique was judged from are evidence a loop is still
 * using. These tests pin the kept set, not just the deletion.
 */

const root = mkdtempSync(join(tmpdir(), "pi-blender-prune-"));
after(() => rmSync(root, { recursive: true, force: true }));
const { blenderWorkspacePrune } = await loadTs("../blender/retention.ts");

function makeWorkspace(name) {
  const workspacePath = join(root, name);
  mkdirSync(workspacePath, { recursive: true });
  const manifestPath = join(workspacePath, "blender-workspace.json");
  return { workspacePath, manifestPath };
}

function addFile(workspacePath, relative, content = "x") {
  const path = join(workspacePath, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function writeManifest(workspacePath, manifestPath, latestIteration, renderOutputs) {
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 2,
      workspaceId: "prune",
      workspacePath,
      blendPath: join(workspacePath, "model.blend"),
      manifestPath,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      latestIteration,
      template: "studio",
      savedViews: {},
      renderOutputs,
      branchRuns: [],
      moduleRuns: [],
    }),
  );
}

test("keeps the newest render and the critique's render; removes only older evidence", async () => {
  const { workspacePath, manifestPath } = makeWorkspace("kept");
  const oldA = addFile(workspacePath, "iteration_01/renders/a.png");
  const newA = addFile(workspacePath, "iteration_04/renders/a.png");
  const oldB = addFile(workspacePath, "iteration_00/renders/b.png");
  const criticized = addFile(workspacePath, "iteration_03/renders/a-critic.png");
  const unlisted = addFile(workspacePath, "iteration_02/renders/stray.png");
  addFile(workspacePath, "references/ref.png");
  writeManifest(workspacePath, manifestPath, 4, [
    { path: oldA, view: "front", iteration: 1, createdAt: "2026-01-01T00:00:00.000Z", module: "a" },
    { path: newA, view: "front", iteration: 4, createdAt: "2026-01-04T00:00:00.000Z", module: "a" },
    { path: oldB, view: "front", iteration: 0, createdAt: "2026-01-01T00:00:00.000Z", module: "b" },
    { path: criticized, view: "front", iteration: 3, createdAt: "2026-01-03T00:00:00.000Z", module: "a" },
  ]);
  writeFileSync(
    join(workspacePath, "critique.log"),
    [
      "[2026-01-03T00:00:00.000Z] iteration_03 module=a budget 1/5",
      "Score: 8/12",
      "View adequacy: 2/2 — fine",
      "Issues:",
      "- none",
      "Next action: present",
      "Decision: continue iterating",
      "",
    ].join("\n"),
  );

  const dry = await blenderWorkspacePrune({ cwd: root, workspace: workspacePath });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.cutoff, 2);
  assert.deepEqual(dry.kept.map((entry) => entry.path).sort(), [newA, oldB, criticized].sort());
  assert.ok(dry.wouldRemove.some((entry) => entry.path === oldA));
  assert.ok(dry.wouldRemove.some((entry) => entry.path === unlisted));
  assert.equal(readFileSync(oldA, "utf8"), "x", "a dry run must delete nothing");

  const applied = await blenderWorkspacePrune({ cwd: root, workspace: workspacePath, dryRun: false });
  assert.equal(applied.totalBytes, dry.totalBytes);
  assert.equal(readFileSync(newA, "utf8"), "x");
  assert.equal(readFileSync(oldB, "utf8"), "x");
  assert.equal(readFileSync(criticized, "utf8"), "x");
  assert.equal(readFileSync(join(workspacePath, "references/ref.png"), "utf8"), "x");
  assert.throws(() => readFileSync(oldA, "utf8"));
  assert.throws(() => readFileSync(unlisted, "utf8"));
});

test("refuses a keep count that would delete the current critique's render", async () => {
  const { workspacePath, manifestPath } = makeWorkspace("refuse");
  writeManifest(workspacePath, manifestPath, 4, []);
  await assert.rejects(
    () => blenderWorkspacePrune({ cwd: root, workspace: workspacePath, keepIterations: 0 }),
    /at least 1/,
  );
});

test("never follows a link out of the workspace, and never deletes one", async () => {
  const { workspacePath, manifestPath } = makeWorkspace("links");
  const reference = addFile(workspacePath, "references/ref.png", "reference");
  const old = addFile(workspacePath, "iteration_01/renders/old.png");
  symlinkSync(reference, join(workspacePath, "iteration_01/renders/link.png"));
  const outside = join(root, "outside.png");
  writeFileSync(outside, "outside");
  writeManifest(workspacePath, manifestPath, 4, [
    { path: old, view: "front", iteration: 1, createdAt: "2026-01-01T00:00:00.000Z", module: "a" },
    { path: outside, view: "front", iteration: 2, createdAt: "2026-01-02T00:00:00.000Z", module: "a" },
  ]);

  await blenderWorkspacePrune({ cwd: root, workspace: workspacePath, dryRun: false });

  assert.equal(readFileSync(reference, "utf8"), "reference");
  assert.equal(readFileSync(outside, "utf8"), "outside");
  assert.throws(() => readFileSync(old, "utf8"));
});

test("protects the render a critique judged even when it has no module", async () => {
  const { workspacePath, manifestPath } = makeWorkspace("moduleless");
  const judged = addFile(workspacePath, "iteration_02/renders/view.png");
  const older = addFile(workspacePath, "iteration_01/renders/view.png");
  writeManifest(workspacePath, manifestPath, 4, [
    { path: judged, view: "front", iteration: 2, createdAt: "2026-01-02T00:00:00.000Z" },
    { path: older, view: "front", iteration: 1, createdAt: "2026-01-01T00:00:00.000Z" },
  ]);
  writeFileSync(
    join(workspacePath, "critique.log"),
    [
      "[2026-01-02T00:00:00.000Z] iteration_02 module=a budget 1/5",
      "Score: 8/12",
      "View adequacy: 2/2",
      "Issues:",
      "- none",
      "Next action: present",
      "Decision: continue iterating",
      "",
    ].join("\n"),
  );

  const dry = await blenderWorkspacePrune({ cwd: root, workspace: workspacePath });
  assert.ok(dry.kept.some((entry) => entry.path === judged), "a module-less judged render is still evidence");
});

test("reports checkpoint and branch storage by kind, and keeps each module's newest checkpoint", async () => {
  const { workspacePath, manifestPath } = makeWorkspace("blend-storage");
  const oldest = addFile(workspacePath, "modules/a/runs/00/pre-00.blend", "a0");
  const old = addFile(workspacePath, "modules/a/runs/01/pre-01.blend", "a1");
  const newest = addFile(workspacePath, "modules/a/runs/02/pre-02.blend", "a2");
  const only = addFile(workspacePath, "modules/b/runs/01/pre-01.blend", "b1");
  const branch = addFile(workspacePath, "modules/a/branch-01.blend", "branch");
  const model = addFile(workspacePath, "model.blend", "model");
  const run = (module, iteration, sequence, status, checkpointPath, branchPath) => ({
    module,
    iteration,
    sequence,
    status,
    at: "2026-01-01T00:00:00.000Z",
    touchedObjects: [],
    touchedMaterials: [],
    addedObjects: [],
    removedObjects: [],
    applyObjects: [],
    branchPath,
    checkpointPath,
    scriptPath: join(workspacePath, "modules", module, "script.py"),
  });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 2,
      workspacePath,
      blendPath: model,
      manifestPath,
      latestIteration: 4,
      renderOutputs: [],
      references: [],
      branchRuns: [
        run("a", 0, 0, "applied", oldest, join(workspacePath, "modules/a/branch-00.blend")),
        run("a", 1, 1, "applied", old, branch),
        run("a", 2, 2, "applied", newest, join(workspacePath, "modules/a/branch-02.blend")),
        run("b", 1, 3, "applied", only, join(workspacePath, "modules/b/branch-01.blend")),
      ],
      moduleRuns: [],
    }),
  );
  const previous = process.env.PI_BLENDER_CHECKPOINT_BUDGET_MB;
  process.env.PI_BLENDER_CHECKPOINT_BUDGET_MB = "0";
  try {
    const dry = await blenderWorkspacePrune({ cwd: workspacePath, workspace: workspacePath, includeCheckpoints: true, includeBranches: true });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.checkpoints, { files: 1, bytes: 2 }, "only the oldest checkpoint is over budget; newest and previous stay");
    assert.equal(dry.branches.files, 1, "the applied branch whose file exists is a candidate");
    assert.equal(dry.wouldRemove.find((entry) => entry.kind === "checkpoint")?.path, oldest);
    assert.equal(dry.wouldRemove.find((entry) => entry.kind === "branch")?.path, branch);
    assert.match(dry.note, /checkpoints 1\/2 bytes/);
    const applied = await blenderWorkspacePrune({ cwd: workspacePath, workspace: workspacePath, dryRun: false, includeCheckpoints: true, includeBranches: true });
    assert.equal(applied.dryRun, false);
    assert.equal(readFileSync(newest, "utf8"), "a2", "the newest checkpoint survives");
    const next = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(next.branchRuns[1].branchRetired, true);
    assert.equal(next.branchRuns[1].retiredAt !== undefined, true);
  } finally {
    if (previous === undefined) delete process.env.PI_BLENDER_CHECKPOINT_BUDGET_MB;
    else process.env.PI_BLENDER_CHECKPOINT_BUDGET_MB = previous;
  }
});
