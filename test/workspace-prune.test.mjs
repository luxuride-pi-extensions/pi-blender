import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
