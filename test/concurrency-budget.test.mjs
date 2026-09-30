/**
 * Behavioural tests for the headless run budget.
 *
 * The number this file is about is one an operator reads in a warning and then
 * has to trust, so the tests assert the RESOLVED count and the reason attached
 * to it rather than that the arithmetic ran. A clamp that fires with no stated
 * term is the failure that matters: it is indistinguishable from a bug, and it
 * is the reason the binding term is reported at all.
 *
 * The env var is set per test through a child process, because the budget reads
 * process.env and the loader caches modules (see paths.mjs).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpus, freemem } from "node:os";import { fileURLToPath } from "node:url";

const RUNNER = fileURLToPath(new URL("./budget-runner.mjs", import.meta.url));

/** Resolve the budget in a fresh process under `extra` env. */
function budget(extra = {}) {
	const base = { PI_BLENDER_MAX_PARALLEL_RUNS: null, ...extra };
	const out = execFileSync(process.execPath, [RUNNER, JSON.stringify(base)], {
		encoding: "utf8",
		env: { ...process.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return JSON.parse(out);
}

test("an unset var requests the documented default of 16", () => {
	assert.equal(budget().requested, 16);
});

test("the default is routinely clamped, and says which term bound it", () => {
	// The whole point of the constant is that 16 is a request the machine
	// usually refuses. If this ever stops clamping, the ceiling has been
	// re-derived and the reasons have to be re-examined too.
	const result = budget();
	assert.equal(result.clamped, true, "the 16 default should clamp on a normal machine");
	assert.equal(result.effective, 4, "12 cores at 3 per run is the term that should bind");
	assert.ok(result.reasons.length > 0, "a clamp with no stated term is unactionable");
	assert.match(result.warning, /cores at 3 per run/);
});

test("an explicit request is honoured verbatim when the machine allows it", () => {
	const result = budget({ PI_BLENDER_MAX_PARALLEL_RUNS: "2" });
	assert.equal(result.requested, 2);
	assert.equal(result.effective, 2);
	assert.equal(result.clamped, false, "asking for less than the machine holds must not clamp");
	assert.equal(result.warning, null);
});

test("the measured ceiling binds even where memory would allow more", () => {
	// The machine here has ~40 GB, so 16 runs would fit in memory. The clamp
	// still holds at 4, because 4 is the only concurrency ever run.
	const result = budget({ PI_BLENDER_MAX_PARALLEL_RUNS: "16" });
	assert.ok(
		Math.floor((freemem() * 0.5) / (366 * 1024 * 1024)) > 4,
		"this test needs a machine where memory is not the binding term",
	);
	assert.equal(result.effective, 4);
	assert.ok(
		result.reasons.some((reason) => reason.includes("measured ceiling")),
		`expected the measured ceiling among ${JSON.stringify(result.reasons)}`,
	);
});

test("a request above the measured ceiling warns that it is projected", () => {
	const result = budget({ PI_BLENDER_MAX_PARALLEL_RUNS: "12" });
	assert.match(result.warning, /measured on this project/);
	assert.match(result.warning, /projection/);
});

test("the warning reports the memory projection in GB", () => {
	// The number is deliberately in GB, because the clamp is not a memory
	// problem and an operator who sees only "clamped" will assume it is.
	// 16 runs at the measured 366 MB each is 5.7 GB, not the ~5.9 the handoff
	// note guessed -- the note's figure was rounded from 4 runs, not computed.
	assert.match(budget({ PI_BLENDER_MAX_PARALLEL_RUNS: "16" }).warning, /5\.7 GB of memory/);
});

test("an unparseable or non-positive value falls back to the default", () => {
	// Read from a plain env var a shell profile or a typo can set. Refusing the
	// run over a stray semicolon would be worse than the default.
	for (const value of ["0", "-4", "many", "", "   ", "3.5.1", "NaN", "Infinity"]) {
		assert.equal(budget({ PI_BLENDER_MAX_PARALLEL_RUNS: value }).requested, 16, `wrongly honoured ${JSON.stringify(value)}`);
	}
});

test("a fractional request floors rather than being honoured as a count", () => {
	// A count of 3.7 runs is not 3.7 processes, and a caller that asked for 3.7
	// meant "about four" -- flooring is the safe reading, and never launching
	// more than asked for is the property that matters.
	assert.equal(budget({ PI_BLENDER_MAX_PARALLEL_RUNS: "3.9" }).requested, 3);
});

test("the gate admits exactly its limit, queues the rest, and drains clean", async () => {
	const result = JSON.parse(
		execFileSync(process.execPath, [RUNNER, JSON.stringify({ PI_PROBE_GATE: "4" })], {
			encoding: "utf8",
			env: { ...process.env },
		}),
	);
	// Twelve waiters onto a four-slot gate: all must run, none may exceed the
	// limit at any sample, and nothing may be stranded once they are done.
	assert.equal(result.peak, 4, "the gate admitted more than its limit");
	assert.equal(result.peakAfterRelease, 4, "a hand-off pushed the count above the limit");
	assert.equal(result.allRan, true, "a waiter was never admitted");
	assert.equal(result.queuedDrained, true, "a waiter was left on the queue");
	assert.equal(result.slotAfterAll, 0, "slots were not all returned");
});

test("a releasing queue hand-off does not leak or over-release a slot", async () => {
	// Releasing twice must be a no-op: a double release that decremented anyway
	// would let the gate admit runs beyond its limit, and one that was ignored
	// while decrementing would strand capacity. Both directions are checked by
	// the final count being exactly zero after every slot was handed back.
	const out = execFileSync(process.execPath, [RUNNER, JSON.stringify({ PI_PROBE_GATE_RELEASE: "2" })], {
		encoding: "utf8",
		env: { ...process.env },
	});
	assert.equal(JSON.parse(out).afterDoubleRelease, 0);
});

test("the memory and core terms describe this machine, not a hardcoded box", () => {
	// cpus() reports what this process may actually run on, and the budget must
	// use it rather than os.cpus() read at some earlier moment: the reason
	// string has to name THIS machine's core count, or an operator debugging a
	// clamp is reading a lie.
	const result = budget();
	assert.match(result.reasons.join("; "), new RegExp(`${cpus().length} cores at 3 per run`));
	// The memory term is asserted on its own rather than through `reasons`,
	// because reasons lists only BINDING terms and memory is not one here: this
	// box has enough free RAM that it would allow ~26 runs, so its absence from
	// the list is the correct report, not a missing term.
	assert.equal(result.reasons.some((reason) => reason.includes("MB per run")), false);
	assert.ok(freemem() > 0);
});
