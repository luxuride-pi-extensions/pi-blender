/**
 * How many headless Blender runs may be in flight at once.
 *
 * The ceiling a caller asks for is not the count that runs. Every headless
 * Blender is a full process with its own render thread pools, and the measured
 * cost is in the file header of MAX_PARALLEL_RUNS below. So the effective count
 * is the smallest of what was asked for, what the machine can hold, and what
 * has actually been exercised — and when those disagree, the caller's warning
 * says which term bound, because "clamped to 4" with no reason is a number the
 * operator has to re-derive by hand.
 *
 * The core term is the one that binds in practice, and deliberately so. Memory
 * is the intuitive limit and it is the wrong one on a machine like this: 16 runs
 * cost roughly 5.9 GB, which fits inside the 40 GB this box reports with room
 * spare. CPU is what serializes them, and a render that cannot get cores does
 * not run faster for wanting them.
 */

import { freemem, cpus } from "node:os";

/** Env var naming the ceiling a caller wants. Unset means DEFAULT_MAX_PARALLEL_RUNS. */
export const ENV_MAX_PARALLEL_RUNS = "PI_BLENDER_MAX_PARALLEL_RUNS";

/**
 * The ceiling used when the env var says nothing.
 *
 * Sixteen is what an uncapped fan-out wants on a machine that can carry it, and
 * it is deliberately above the count this project has measured. The default is
 * therefore routinely clamped below by the machine terms, which is the point:
 * the number is a request, and resolveRunBudget is the arbiter.
 */
export const DEFAULT_MAX_PARALLEL_RUNS = 16;

/**
 * Resident memory of one headless Blender against a real 2.3 MB blend.
 *
 * Measured on this machine, four at a time, not a figure from a spec sheet: the
 * per-process cost of loading a scene plus its render buffers is what the memory
 * term divides by, so a wrong constant makes the term a decoration. Four at
 * 366 MB is 1.4 GB, which is why the memory term almost never binds and the
 * 16-run projection of 5.7 GB fits a machine reporting 40 GB with room spare.
 */
const RSS_PER_RUN_BYTES = 366 * 1024 * 1024;

/**
 * Resident memory of one WINDOWED Blender, the /blender-watch process.
 *
 * NOT measured the way RSS_PER_RUN_BYTES above was, and deliberately reported
 * as a rough projection rather than used as a budget term. What is known: the
 * headless cost is 366 MB, and the difference is a GL context, the viewport draw
 * buffers and the undo stack, none of which a --background run allocates. A GL
 * context plus draw buffers for a 3D viewport is on the order of 100-300 MB on
 * its own before any scene is loaded, and the undo stack grows with every
 * operation applied through the bridge.
 *
 * The figure is CHOSEN to make the oversubscription visible rather than to be
 * right: it is reported beside the headless budget so an operator can see that
 * a viewer plus the resolved run count is a real claim on the machine. It is
 * NOT a clamp input, because a term this soft inside a memory budget with tens
 * of GB of slack would be a guess masquerading as a measurement, and the
 * 366 MB above, which IS measured, would stop being the honest number here.
 */
export const WATCH_WINDOW_RSS_BYTES = 1_200 * 1024 * 1024;

/**
 * Cores assumed per concurrent Blender.
 *
 * A headless render does not saturate its own thread pool — a scene this size
 * leaves most workers idle waiting on geometry — but it does not leave them
 * entirely idle either, and N Blenders that each believe they own every core
 * interleave badly enough that total throughput is worse than the serial case.
 * Three is the smallest divisor that reproduces the measured result: on the
 * 12-core box the four concurrent runs were measured on, 12 / 3 = 4, which is
 * exactly the concurrency that was exercised.
 */
const CORES_PER_RUN = 3;

/**
 * The highest concurrency this project has actually run.
 *
 * Every count above this is projected, not observed, so it is the hard ceiling
 * regardless of what the machine could nominally afford. Raising it is a
 * deliberate act that has to be made against a measurement, not a default.
 */
const MAX_MEASURED_PARALLEL_RUNS = 4;

export interface RunBudget {
	/** What the caller asked for, after env parsing. */
	requested: number;
	/** What will actually run at once. */
	effective: number;
	/** True when `effective` is below `requested`. */
	clamped: boolean;
	/** One line per term that bound the result, empty when nothing clamped. */
	reasons: string[];
	/** The whole explanation, or undefined when nothing clamped. */
	warning: string | undefined;
}

export function describeMachineLimits(): { memory: number; cores: number; coreRuns: number; rssBytes: number; coresPerRun: number } {
	// cpus() and not availableParallelism(): both are cgroup-aware, and the
	// affinity mask is the older of the two, so it cannot be newer than the
	// cgroup limit on a platform that has one.
	const cores = Math.max(1, cpus().length);
	return {
		cores,
		coreRuns: Math.max(1, Math.floor(cores / CORES_PER_RUN)),
		// A floor of one run's worth, so a nearly-full machine still permits a run
		// instead of refusing all of them and reporting an impossible count.
		memory: Math.max(1, Math.floor((freemem() * 0.5) / RSS_PER_RUN_BYTES)),
		rssBytes: RSS_PER_RUN_BYTES,
		coresPerRun: CORES_PER_RUN,
	};
}

/**
 * The machine's own limits, as counts.
 *
 * Memory is judged against FREE memory, not total, because a fan-out competes
 * with whatever the user already has open; total memory is the number a budget
 * should not trust. Both terms floor at 1, since a run that cannot be given a
 * single slot is a deadlock rather than a throttling decision.
 */
function machineLimits(): { memory: number; cores: number; coreRuns: number } {
	const { memory, cores, coreRuns } = describeMachineLimits();
	return { memory, cores, coreRuns };
}

/**
 * The ceiling named by the environment, or the default.
 *
 * An unparseable or non-positive value falls back to the default rather than
 * being honoured or thrown on. This is read from a plain env var that a shell
 * profile, a task runner, or a typo can set, and refusing the whole run over
 * `PI_BLENDER_MAX_PARALLEL_RUNS=16;` would make a missing colon look like a
 * concurrency bug.
 */
export function resolveMaxParallelRuns(): number {
	const raw = process.env[ENV_MAX_PARALLEL_RUNS]?.trim();
	if (!raw) return DEFAULT_MAX_PARALLEL_RUNS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_PARALLEL_RUNS;
	return Math.floor(parsed);
}

/**
 * What will actually run, and why that is less than what was asked for.
 *
 * `requested` defaults to the env ceiling, so the ordinary path is a caller that
 * fans out as wide as the operator allows. A caller with a narrower budget of
 * its own passes it explicitly; the machine terms still apply, because a caller
 * asking for fewer runs than the box can hold is not a request to overcommit.
 */
export function resolveRunBudget(requested: number = resolveMaxParallelRuns()): RunBudget {
	const { memory, cores, coreRuns } = machineLimits();
	const rssMb = Math.round(RSS_PER_RUN_BYTES / (1024 * 1024));
	const terms: Array<{ name: string; limit: number }> = [
		{ name: "measured ceiling", limit: MAX_MEASURED_PARALLEL_RUNS },
		{ name: `${cores} cores at ${CORES_PER_RUN} per run`, limit: coreRuns },
		{ name: `free memory at ${rssMb} MB per run`, limit: memory },
	];

	const binding = terms.filter((term) => term.limit < requested);
	const effective = Math.max(1, Math.min(requested, ...terms.map((term) => term.limit)));
	const reasons = binding.map((term) => `${term.name} allows ${term.limit}`);

	if (effective >= requested) {
		return { requested, effective, clamped: false, reasons: [], warning: undefined };
	}

	const gb = Math.round(((requested * RSS_PER_RUN_BYTES) / (1024 * 1024 * 1024)) * 10) / 10;
	const warning =
		`${ENV_MAX_PARALLEL_RUNS}=${requested} requested; clamping to ${effective} (${reasons.join("; ")}). ` +
		`Only ${MAX_MEASURED_PARALLEL_RUNS} concurrent headless Blenders have been measured on this project, so anything above that is a projection. ` +
		`${requested} runs need about ${gb} GB of memory, which memory is rarely the term that binds -- ` +
		`cores are, because N Blenders each render-thread-pooling into the same ${cores} of them do not scale past the pool. ` +
		`Set ${ENV_MAX_PARALLEL_RUNS} to the count you actually intend to run concurrently and this stops clamping; ` +
		`or leave it unset and the default ${DEFAULT_MAX_PARALLEL_RUNS} applies, clamped the same way.`;

	return { requested, effective, clamped: true, reasons, warning };
}

/**
 * A FIFO gate holding at most `limit` headless runs.
 *
 * FIFO rather than a free-for-all, because module runs are authored against a
 * branch state: the run that gets a slot first is the one whose result is
 * nearest the state the others were briefed against, and a barging waiter would
 * let a late arrival overtake it for no benefit.
 */
export class ParallelRunGate {
	private active = 0;
	private readonly waiters: Array<() => void> = [];

	constructor(readonly limit: number) {}

	/** Slots held by admitted runs plus slots already promised to a woken waiter. */
	get inFlight(): number {
		return this.active;
	}

	get queued(): number {
		return this.waiters.length;
	}

	/**
	 * Take a slot, or wait for one.
	 *
	 * The queued path does NOT increment on wake-up, and that asymmetry is the
	 * whole correctness of the gate. `active` counts a slot as taken from the
	 * moment a releaser hands it to a waiter, so it never dips between the
	 * release and the waiter's resumption. If the count did dip, a caller
	 * arriving in that window would be admitted on the free slot, and the woken
	 * waiter would then take its own — running limit + 1.
	 */
	async acquire(): Promise<() => void> {
		if (this.active < this.limit) {
			this.active += 1;
			return this.#release();
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		return this.#release();
	}

	#release(): () => void {
		let released = false;
		return () => {
			// Idempotent, because a caller unwinding through a finally after an
			// exception has already returned its slot can hand it back twice, and
			// a double release would permanently inflate the free count.
			if (released) return;
			released = true;
			const next = this.waiters.shift();
			// With a waiter, the slot is transferred: the count is unchanged,
			// because the waiter is already inside it. Without one, it frees.
			if (next) next();
			else this.active -= 1;
		};
	}
}
