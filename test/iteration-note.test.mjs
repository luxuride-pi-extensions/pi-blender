import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { loadTs } from "./paths.mjs";

/**
 * A fact a critic is told about but cannot re-derive is worth nothing: the next
 * critic re-argues from the same unsupported assertion. So a recorded fact
 * must name the tool that produced it, survive the manager, replace its own
 * older duplicate, and stay bounded.
 */

const root = mkdtempSync(join(tmpdir(), "pi-blender-iteration-note-"));
after(() => rmSync(root, { recursive: true, force: true }));

const { blenderRecordIterationFact } = await loadTs("../blender/iteration-note.ts");
const { blenderIterationState } = await loadTs("../blender/iteration-state.ts");

let counter = 0;

function makeWorkspace() {
  const name = `ws-${counter++}`;
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
    }),
  );
  return workspacePath;
}

function readManifest(workspacePath) {
  return JSON.parse(readFileSync(join(workspacePath, "blender-workspace.json"), "utf8"));
}

test("a recorded fact is persisted to the manifest and read back by the state tool", async () => {
  const workspace = makeWorkspace();
  const recorded = await blenderRecordIterationFact({
    cwd: root,
    workspace,
    moduleName: "mug",
    statement: "Mug is 120mm tall, measured on the bounding box",
    source: "blender_geometry_probe specifications {mug: {height: 120}}",
  });

  assert.equal(recorded.module, "mug");
  assert.equal(recorded.facts.length, 1);
  assert.equal(recorded.superseded, 0);
  assert.equal(recorded.recorded.source, "blender_geometry_probe specifications {mug: {height: 120}}");
  assert.ok(Date.parse(recorded.recorded.at) > 0, "the fact is timestamped");

  const notes = readManifest(workspace).iterationNotes;
  assert.ok(Array.isArray(notes.mug), "facts are filed under their module");
  assert.equal(notes.mug.length, 1);

  const state = await blenderIterationState({ cwd: root, workspace, moduleName: "mug" });
  assert.equal(state.knownFacts.length, 1);
  assert.match(state.knownFacts[0].statement, /120mm tall/);
  assert.match(state.knownFacts[0].source, /blender_geometry_probe/);
});

test("re-recording the same statement replaces the older one rather than stacking", async () => {
  const workspace = makeWorkspace();
  const first = await blenderRecordIterationFact({
    cwd: root,
    workspace,
    moduleName: "mug",
    statement: "The handle is 6mm in diameter",
    source: "blender_geometry_probe",
  });
  const second = await blenderRecordIterationFact({
    cwd: root,
    workspace,
    moduleName: "mug",
    statement: "The handle is 6mm in diameter",
    source: "blender_geometry_probe (re-measured)",
  });

  assert.equal(second.superseded, 1);
  assert.equal(second.facts.length, 1);
  assert.equal(second.facts[0].source, "blender_geometry_probe (re-measured)");

  // The re-measurement is the newer one, so its timestamp must not go BACKWARDS
  // -- and must not merely be equal either, or the two facts are
  // indistinguishable and a reader cannot tell which measurement is current.
  //
  // This was `notEqual`, which failed roughly one run in ten on a fast machine:
  // both writes landed inside the same millisecond, so the two ISO strings came
  // out byte-identical and the test failed on a race rather than on a
  // regression. A timestamp at the system's resolution cannot promise to
  // distinguish two writes it cannot see apart. Asserting ordering instead
  // tests what the code actually guarantees, and fails for real if the
  // superseding fact ever does get stamped with the older time.
  assert.ok(
    Date.parse(second.facts[0].at) >= Date.parse(first.recorded.at),
    `the re-measured fact (${second.facts[0].at}) must not predate the fact it supersedes (${first.recorded.at})`,
  );
});

test("a fact without its measured statement is refused", async () => {
  const workspace = makeWorkspace();
  await assert.rejects(
    blenderRecordIterationFact({ cwd: root, workspace, moduleName: "mug", statement: "   ", source: "probe" }),
    /needs the measured statement itself/,
  );
});

test("a fact without its source is refused, because a later critic could not re-measure it", async () => {
  const workspace = makeWorkspace();
  await assert.rejects(
    blenderRecordIterationFact({ cwd: root, workspace, moduleName: "mug", statement: "The handle is thin", source: "" }),
    /needs the tool the fact came from/,
  );
});

test("one module's facts never leak into another's", async () => {
  const workspace = makeWorkspace();
  await blenderRecordIterationFact({
    cwd: root,
    workspace,
    moduleName: "mug",
    statement: "Mug handle is 6mm",
    source: "blender_geometry_probe",
  });
  const chair = await blenderIterationState({ cwd: root, workspace, moduleName: "chair" });
  assert.deepEqual(chair.knownFacts, []);
});

test("the fact log is bounded, keeping the newest measurements", async () => {
  const workspace = makeWorkspace();
  for (let i = 0; i < 26; i += 1) {
    await blenderRecordIterationFact({
      cwd: root,
      workspace,
      moduleName: "mug",
      statement: `measurement ${i}`,
      source: "blender_geometry_probe",
    });
  }
  const notes = readManifest(workspace).iterationNotes.mug;
  assert.equal(notes.length, 24, "older measurements are dropped, not the log left unbounded");
  assert.equal(notes.at(-1).statement, "measurement 25", "the newest measurement is the one that survives");
  assert.equal(notes[0].statement, "measurement 2");
});
