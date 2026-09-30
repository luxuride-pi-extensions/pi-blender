/**
 * Resolves the headless run budget (or exercises the gate) in a CHILD process.
 *
 * Why a child, as in probe.mjs: the budget reads process.env, the env var has to
 * vary per test, and the loader caches a module per instance. The gate probes
 * need child processes for a second reason — they assert on concurrency, and two
 * of them run deliberately oversized batches, so nothing they touch should
 * share a counter with the test runner.
 *
 * Usage: node test/budget-runner.mjs '<env JSON>'
 * Prints one JSON object on stdout.
 */

import { loadTs } from "./paths.mjs";

const env = JSON.parse(process.argv[2] ?? "{}");
for (const [key, value] of Object.entries(env)) {
	if (value === null) delete process.env[key];
	else process.env[key] = value;
}

const { ParallelRunGate, resolveRunBudget } = await loadTs("../blender/concurrency.ts");

/**
 * Admit many waiters onto a narrow gate and record the high-water mark.
 *
 * The waiters are NOT joined with Promise.all before being released: every
 * waiter holds its slot until the release, so joining first deadlocks on a
 * gate that is working perfectly. Each one releases as soon as it is admitted,
 * which is also how real callers behave, and the peak is sampled at the moment
 * of admission — the only moment when the in-flight count is meaningful.
 */
async function probeGate(limit, count) {
	const gate = new ParallelRunGate(limit);
	let peak = 0;
	let peakAfterRelease = 0;
	const releases = await Promise.all(
		Array.from({ length: count }, async () => {
			const release = await gate.acquire();
			peak = Math.max(peak, gate.inFlight);
			release();
			// Sampled after the hand-off: a release that also wakes a queued
			// waiter must leave the count at the limit, never above it.
			peakAfterRelease = Math.max(peakAfterRelease, gate.inFlight);
			return release;
		}),
	);
	// The returns are exercised again after the fact, so a second release of an
	// already-returned slot has to be a no-op rather than a decrement.
	releases.forEach((release) => release());
	return {
		peak,
		peakAfterRelease,
		allRan: releases.length === count,
		queuedDrained: gate.queued === 0,
		slotAfterAll: gate.inFlight,
	};
}

/** Whether the free count survives a caller that returns its slot twice. */
async function probeGateDoubleRelease(limit) {
	const gate = new ParallelRunGate(limit);
	const first = await gate.acquire();
	const second = await gate.acquire();
	first();
	first();
	second();
	second();
	return { afterDoubleRelease: gate.inFlight };
}

if (env.PI_PROBE_GATE) {
	process.stdout.write(JSON.stringify(await probeGate(Number(env.PI_PROBE_GATE), 12)));
	process.exit(0);
}
if (env.PI_PROBE_GATE_RELEASE) {
	process.stdout.write(JSON.stringify(await probeGateDoubleRelease(Number(env.PI_PROBE_GATE_RELEASE))));
	process.exit(0);
}

const budget = resolveRunBudget();
process.stdout.write(
	JSON.stringify({
		requested: budget.requested,
		effective: budget.effective,
		clamped: budget.clamped,
		reasons: budget.reasons,
		warning: budget.warning ?? null,
	}),
);
