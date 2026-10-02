// Blender writes one bootstrap blend per launch, and a session that dies without
// cleaning up leaves it behind forever. The sweep may only delete a blend whose
// owning session is provably gone: deleting a file that a running Blender still
// has open is worse than leaving an abandoned one for another pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadTs } from "./paths.mjs";

// The instance id is resolved when config.ts is evaluated, and XDG_CACHE_HOME
// decides where the bridge and blank roots live, so both must be in the
// environment before the module loads. Only XDG_CACHE_HOME is pinned, never
// PI_BLENDER_BRIDGE_DIR: an explicit bridge dir is the user's own, and the
// reaper refuses to touch it at all, which would make every removal here
// unachievable.
const root = mkdtempSync(join(tmpdir(), "pi-blender-blank-reap-"));
const env = {
  XDG_CACHE_HOME: root,
  PI_BLENDER_INSTANCE_ID: "owninstance01",
};
const cacheDir = join(root, "pi-blender");
const bridgeRoot = join(cacheDir, "bridge");
const blankDir = join(cacheDir, "blank");
mkdirSync(bridgeRoot, { recursive: true });
mkdirSync(blankDir, { recursive: true });

const { formatBlankReapResult, reapStaleBlankBlends } = await loadTs("../blender/reap.ts", env);
const { getBlankBlendDir, getBlenderInstanceId } = await loadTs("../config.ts", env);

const PAST_THE_BUDGET = 130_000; // just past the 120s launch budget
const STALE_BUT_INSIDE_THE_BUDGET = 30_000; // past the 10s heartbeat window, still launching

function stageBridge(id, { pid = null, heartbeat = null, ageMs = PAST_THE_BUDGET } = {}) {
  const dir = join(bridgeRoot, id);
  mkdirSync(join(dir, "instances"), { recursive: true });
  if (pid !== null) {
    writeFileSync(join(dir, "instances", `${pid}.json`), JSON.stringify({ pid, instanceId: id }));
  }
  if (heartbeat !== null) {
    const beat = join(dir, "heartbeat");
    writeFileSync(beat, JSON.stringify({ pid: heartbeat.pid ?? pid, at: Date.now() / 1000 }));
    const when = (Date.now() - heartbeat.ageMs) / 1000;
    utimesSync(beat, when, when);
  }
  // classifyBridgeDir judges an instance dir by its own age, so a directory
  // created moments ago reads as still launching rather than abandoned.
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(dir, when, when);
  utimesSync(join(dir, "instances"), when, when);
  return id;
}

function stageBlank(name, ageMs) {
  const file = join(blankDir, name);
  writeFileSync(file, "BLENDER");
  const when = (Date.now() - ageMs) / 1000;
  utimesSync(file, when, when);
  return file;
}

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push({ label, ok: true });
    console.log(`  ok  ${label}`);
  } catch (error) {
    results.push({ label, ok: false, error });
    console.log(`FAIL  ${label}`);
    console.log(`      ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}

test("reaping abandoned bootstrap blends", async (t) => {
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await check("the sweep sees the blank dir the config resolves", () => {
    assert.equal(getBlankBlendDir(), blankDir);
  });

  await check("a blend whose session is provably gone is removed", async () => {
    stageBridge("deadowner01", { pid: 999_998 });
    const file = stageBlank("deadowner01.blend", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(!existsSync(file), "the abandoned blend should have been deleted");
    assert.ok(result.removed.includes(file), "and reported as removed");
  });

  await check("a blend whose owning pi is still running is left alone", async () => {
    stageBridge("liveowner01", { pid: process.pid });
    const file = stageBlank("liveowner01.blend", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(existsSync(file));
    assert.ok(!result.removed.includes(file));
  });

  await check("a blend whose Blender is still beating is left alone", async () => {
    // The heartbeat PID, not the owner PID, is what says a live Blender holds
    // this file; a dead owner with a live beating Blender is the interesting case.
    stageBridge("liveblender1", { pid: 999_997, heartbeat: { pid: process.pid, ageMs: 1_000 } });
    const file = stageBlank("liveblender1.blend", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(existsSync(file));
    assert.ok(!result.removed.includes(file));
  });

  await check("a fresh heartbeat from a dead Blender is a crash, so the file goes", async () => {
    stageBridge("deadblender1", { pid: 999_997, heartbeat: { pid: 999_996, ageMs: 1_000 } });
    const file = stageBlank("deadblender1.blend", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(!existsSync(file));
    assert.ok(result.removed.includes(file));
  });

  await check("this instance's own bootstrap blend is never removed", async () => {
    const own = getBlenderInstanceId();
    const file = stageBlank(`${own}.blend`, PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(existsSync(file));
    assert.ok(!result.removed.includes(file));
  });

  await check("a fresh blend is never removed", async () => {
    stageBridge("justlaunched", { pid: 999_996, ageMs: 0 });
    const file = stageBlank("justlaunched.blend", 0);
    const result = await reapStaleBlankBlends();
    assert.ok(existsSync(file));
    assert.ok(!result.removed.includes(file));
  });

  await check("a blend inside the launch budget is never removed", async () => {
    stageBridge("stillbooting1", { pid: 999_995, ageMs: STALE_BUT_INSIDE_THE_BUDGET });
    const file = stageBlank("stillbooting1.blend", STALE_BUT_INSIDE_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(existsSync(file));
    assert.ok(!result.removed.includes(file));
  });

  await check("a blend with no bridge dir at all is left alone", async () => {
    const file = stageBlank("orphanblanks.blend", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(existsSync(file), "absence of evidence is not evidence of abandonment");
    assert.ok(!result.removed.includes(file));
  });

  await check("a .blend1 backup of an abandoned session is removed", async () => {
    stageBridge("deadowner02", { pid: 999_994 });
    const file = stageBlank("deadowner02.blend1", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(!existsSync(file), "the abandoned backup should have been deleted");
    assert.ok(result.removed.includes(file));
  });

  await check("a file that is not an instance-named blend is ignored", async () => {
    stageBridge("deadowner03", { pid: 999_993 });
    // Both names are valid files in the blank dir; neither stem could be an
    // instance id, so neither is a candidate however dead its owner is.
    const spaced = stageBlank("my notes.blend", PAST_THE_BUDGET);
    const other = stageBlank("notes.txt", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(existsSync(spaced));
    assert.ok(existsSync(other));
    assert.ok(!result.removed.includes(spaced));
    assert.ok(!result.removed.includes(other));
  });

  await check("the pinned blank path is user-owned and never swept", async () => {
    const pinned = join(root, "elsewhere.blend");
    writeFileSync(pinned, "MINE");
    const previous = process.env.PI_BLENDER_BLANK_BLEND_PATH;
    process.env.PI_BLENDER_BLANK_BLEND_PATH = pinned;
    try {
      const result = await reapStaleBlankBlends();
      assert.deepEqual(result.removed, []);
      assert.match(result.skipped[0]?.reason ?? "", /PI_BLENDER_BLANK_BLEND_PATH/);
    } finally {
      if (previous === undefined) delete process.env.PI_BLENDER_BLANK_BLEND_PATH;
      else process.env.PI_BLENDER_BLANK_BLEND_PATH = previous;
    }
  });

  await check("a missing blank dir is not an error", async () => {
    const previous = process.env.PI_BLENDER_BLANK_BLEND_PATH;
    process.env.PI_BLENDER_BLANK_BLEND_PATH = join(root, "gone", "nested.blend");
    try {
      const result = await reapStaleBlankBlends();
      assert.deepEqual(result.removed, []);
    } finally {
      if (previous === undefined) delete process.env.PI_BLENDER_BLANK_BLEND_PATH;
      else process.env.PI_BLENDER_BLANK_BLEND_PATH = previous;
    }
  });

  await check("the summary counts files and stays silent when nothing was removed", async () => {
    stageBridge("deadowner04", { pid: 999_992 });
    const file = stageBlank("deadowner04.blend", PAST_THE_BUDGET);
    const result = await reapStaleBlankBlends();
    assert.ok(result.removed.includes(file));
    assert.match(formatBlankReapResult(result) ?? "", /bootstrap blend/);
    assert.equal(formatBlankReapResult(await reapStaleBlankBlends()), undefined);
  });

  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? `all ${results.length} blank-reap checks passed` : `${failed} of ${results.length} blank-reap checks FAILED`);
});
