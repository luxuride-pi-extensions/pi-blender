/**
 * The instance reaper's treatment of a dir with no owner record.
 *
 * This is the case that leaked. An instance dir can exist with no owner record
 * at all: a pi process killed between creating the dir and publishing its
 * record, or a dir from before per-process records existed. classifyBridgeDir()
 * read every such dir as unclassifiable, and the sweep only acts on "adopt" or
 * "remove", so those dirs were never removed — one permanent entry per
 * incident, growing without bound. A live user had one: an eleven-hour-stale
 * heartbeat and a launch claim naming a pid long gone, still sitting in the
 * instance root and still looking like a second Blender to anyone listing it.
 *
 * The removal condition is three pieces of positive evidence, because the
 * alternative is `rm -rf` on a directory nobody can prove is ours:
 *   1. a heartbeat file, so the dir is a bridge dir and not something a person
 *      made or a scratch directory a person put there;
 *   2. a heartbeat older than the cold-start budget, so a starting or working
 *      UI is never a candidate;
 *   3. no live launch claim — and a claim that exists but cannot be READ counts
 *      as live, because a claim is created and written in two steps and the
 * half-written state is a peer mid-launch.
 *
 * Why the decision is asserted directly rather than through the sweep: the
 * sweep resolves the instance root from the environment at import time and
 * refuses to run at all under PI_BLENDER_BRIDGE_DIR, so pointing a test at a
 * temp root that way tests the override guard instead of this function.
 * classifyBridgeDir() takes a dir and reads nothing else, which is what makes
 * the fixtures below a handful of files.
 *
 * The staleness window is manipulated rather than waited out: an old heartbeat
 * is a file with an old mtime, so each case is instant and deterministic
 * instead of depending on a real 120-second budget elapsing.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTs } from "./paths.mjs";

const { classifyBridgeDir } = await loadTs("../blender/reap.ts");

const root = mkdtempSync(join(tmpdir(), "pi-blender-reap-"));

/** A fresh instance dir under the fixture root. Each case gets its own. */
function stageDir(name) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Write a heartbeat `ageMs` old. mtime is the only signal the rule reads. */
function seedHeartbeat(dir, ageMs, pid = 999_999) {
	writeFileSync(join(dir, "heartbeat"), JSON.stringify({ pid, at: Date.now() / 1000 }));
	const when = (Date.now() - ageMs) / 1000;
	utimesSync(join(dir, "heartbeat"), when, when);
}

function seedClaim(dir, contents) {
	writeFileSync(join(dir, "launch.claim"), contents);
}

/** 130s: just past the 120s cold-start budget the rule is expressed in terms of. */
const PAST_THE_BUDGET = 130_000;
/**
 * 30s: past the 10s freshness window, short of the 120s budget.
 *
 * This is the gap the rule has to be careful about. Ten seconds is the window a
 * LIVE UI is allowed to go without beating, so a rule that reused it would
 * remove a dir belonging to a process that is merely slow. A heartbeat this
 * old is not fresh, so the existing rule 1 does not reach it — it is the only
 * way to reach the new branch, and a fresh heartbeat is a mistake in a fixture
 * here: rule 1 would decide it before the owner records were ever consulted.
 */
const STALE_BUT_INSIDE_THE_BUDGET = 30_000;

const results = [];
async function check(label, fn) {
	try {
		await fn();
		results.push([label, true]);
		console.log(`  ok  ${label}`);
	} catch (error) {
		results.push([label, false]);
		console.error(`FAIL ${label}\n     ${error.message}`);
		process.exitCode = 1;
	}
}

await check("an abandoned dir with no owner record and no claim is removed", async () => {
	const dir = stageDir("a-no-owner-no-claim");
	seedHeartbeat(dir, PAST_THE_BUDGET);

	assert.equal(
		await classifyBridgeDir(dir),
		"remove",
		"an eleven-hour-stale heartbeat with no owner record is dead weight that will never clear itself",
	);
});

await check("an unowned dir whose heartbeat is stale but INSIDE the budget is left alone", async () => {
	const dir = stageDir("b-no-owner-stale-not-past-budget");
	seedHeartbeat(dir, STALE_BUT_INSIDE_THE_BUDGET);

	assert.equal(
		await classifyBridgeDir(dir),
		"no instance file and no heartbeat; left alone",
		"a heartbeat that is merely late is a slow UI, not an abandoned dir",
	);
});

await check("a dir with no heartbeat at all is still left alone", async () => {
	const dir = stageDir("c-no-heartbeat");
	writeFileSync(join(dir, "notes.txt"), "not a bridge dir");

	assert.equal(
		await classifyBridgeDir(dir),
		"no instance file and no heartbeat; left alone",
		"a hand-made directory must never be rm -rf'd on a guess",
	);
});

await check("an unowned dir with a LIVE claim is left alone", async () => {
	const dir = stageDir("d-no-owner-live-claim");
	seedHeartbeat(dir, PAST_THE_BUDGET);
	// This process is trivially alive, which is exactly what a peer mid-launch
	// looks like: it has taken the claim and has not yet written an owner record.
	seedClaim(dir, JSON.stringify({ pid: process.pid, at: Date.now() }));

	assert.equal(
		await classifyBridgeDir(dir),
		"no instance file and no heartbeat; left alone",
		"a claim somebody is about to answer must keep its dir",
	);
});

await check("an unowned dir with a DEAD claim and an old heartbeat is removed", async () => {
	const dir = stageDir("e-no-owner-dead-claim");
	seedHeartbeat(dir, PAST_THE_BUDGET);
	// A pid far above anything this machine hands out, asserted absent so the
	// fixture cannot quietly become a live claim after a reboot.
	const deadPid = 4_194_303;
	assert.throws(() => process.kill(deadPid, 0), /ESRCH/, "the fixture pid must genuinely not exist");
	seedClaim(dir, JSON.stringify({ pid: deadPid, at: Date.now() }));

	assert.equal(
		await classifyBridgeDir(dir),
		"remove",
		"a claim from a process long gone is not an owner",
	);
});

await check("an UNREADABLE claim counts as live, not as absent", async () => {
	const dir = stageDir("f-no-owner-torn-claim");
	seedHeartbeat(dir, PAST_THE_BUDGET);
	// The exact state between a peer's openSync(path,"wx") and its write: a
	// claim that exists on disk and is not readable as JSON. Treating the parse
	// failure as "no claim" would remove a dir a peer is about to publish an
	// owner record into — the one way this rule could delete a live session's dir.
	seedClaim(dir, "");

	assert.equal(
		await classifyBridgeDir(dir),
		"no instance file and no heartbeat; left alone",
		"a claim that exists but cannot be read is a peer mid-launch",
	);
});

await check("a live heartbeat still wins over everything, owner or not", async () => {
	// The pre-existing rule, asserted so the new branch cannot have displaced
	// it: a beating heartbeat is a real UI answering in that exact dir, and the
	// owner pid is the weaker signal in both directions.
	const dir = stageDir("g-live-heartbeat-no-owner");
	seedHeartbeat(dir, 0, process.pid);

	assert.equal(await classifyBridgeDir(dir), "adopt", "a beating heartbeat means a live UI in that dir");
});

await check("a dead pid in a fresh heartbeat is still removed", async () => {
	// The crash-just-before-expiry case mtime cannot see, and the reason the
	// heartbeat check needs two signals.
	const dir = stageDir("h-fresh-heartbeat-dead-pid");
	seedHeartbeat(dir, 0, 4_194_303);

	assert.equal(await classifyBridgeDir(dir), "remove", "a confirmed dead pid beats a fresh mtime");
});

await check("a live owner with no heartbeat keeps its dir", async () => {
	// Rule 3: no heartbeat and a live owner is a process starting its Blender
	// right now. This is the branch that must NOT consult the new rule at all.
	const dir = stageDir("i-live-owner-no-heartbeat");
	writeFileSync(join(dir, "instance.json"), JSON.stringify({ pid: process.pid, instanceId: dir }));

	assert.equal(
		await classifyBridgeDir(dir),
		"owner pi still running, bridge not started yet",
		"a starting launch is not an abandoned dir",
	);
});

rmSync(root, { recursive: true, force: true });

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nreap: ${results.length - failed} passed, ${failed} failed`);
