import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderBridgeDir } from "../config.js";

export type DeferredJobState = "running" | "completed" | "failed" | "cancelled";

export interface DeferredJobRecord {
	id: string;
	type: string;
	state: DeferredJobState;
	createdAt: string;
	updatedAt: string;
	result?: unknown;
	error?: string;
	/** Why a cancelled job was cancelled, kept alongside its final state. */
	cancelReason?: string;
	metadata?: Record<string, unknown>;
}

export interface DeferredJobHandle {
	jobId: string;
	state: DeferredJobState;
}

export function getJobsDir(): string {
	return join(getBlenderBridgeDir(), "jobs");
}

export async function createJob(
	type: string,
	metadata?: Record<string, unknown>,
): Promise<DeferredJobRecord> {
	const jobsDir = getJobsDir();
	await mkdir(jobsDir, { recursive: true });
	const id = randomUUID();
	const now = new Date().toISOString();
	const record: DeferredJobRecord = {
		id,
		type,
		state: "running",
		createdAt: now,
		updatedAt: now,
		metadata,
	};
	const filePath = join(jobsDir, `${id}.json`);
	await writeFile(filePath, JSON.stringify(record, null, 2), "utf-8");
	return record;
}

export async function updateJob(
	id: string,
	updates: Partial<DeferredJobRecord>,
): Promise<DeferredJobRecord> {
	if (!isJobId(id)) {
		throw new Error(`Refusing to update job "${id}": not a job id.`);
	}
	const jobsDir = getJobsDir();
	const filePath = join(jobsDir, `${id}.json`);
	let current: DeferredJobRecord;
	try {
		const raw = await readFile(filePath, "utf-8");
		current = JSON.parse(raw);
	} catch {
		current = {
			id,
			type: updates.type ?? "unknown",
			state: "running",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
	}
	const updated: DeferredJobRecord = {
		...current,
		...updates,
		updatedAt: new Date().toISOString(),
	};
	await writeFile(filePath, JSON.stringify(updated, null, 2), "utf-8");
	return updated;
}

/**
 * Whether a job id is one this module could have minted.
 *
 * `id` reaches here from a model-supplied `jobId` parameter, and it is
 * interpolated into a path. Unvalidated, `"../../../.ssh/id_ed25519"` resolves
 * outside the jobs directory: `join()` normalizes the segments, so the read
 * lands on any `<that path>.json` the process can reach. Jobs are created by
 * `randomUUID()`, so the only legitimate shape is a UUID.
 */
function isJobId(id: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export async function getJob(id: string): Promise<DeferredJobRecord | null> {
	if (!isJobId(id)) return null;
	const jobsDir = getJobsDir();
	const filePath = join(jobsDir, `${id}.json`);
	try {
		const raw = await readFile(filePath, "utf-8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

export async function listJobs(): Promise<DeferredJobRecord[]> {
	const jobsDir = getJobsDir();
	try {
		const entries = await readdir(jobsDir);
		const records: DeferredJobRecord[] = [];
		for (const file of entries) {
			if (!file.endsWith(".json")) continue;
			try {
				const raw = await readFile(join(jobsDir, file), "utf-8");
				records.push(JSON.parse(raw));
			} catch {
				// Ignore corrupt or concurrent writes
			}
		}
		records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return records;
	} catch {
		return [];
	}
}

/** Abort handles for jobs this process dispatched; a job from an earlier process has none. */
const inFlight = new Map<string, AbortController>();

/**
 * Mark a running job cancelled and abort its worker.
 *
 * The state is written before the abort so the worker's rejection cannot land
 * as "failed" on a job the user just cancelled. A worker that had already
 * finished goes through `finishJob`, which leaves a cancelled record alone.
 */
export async function cancelJob(
	id: string,
	reason = "cancelled by request",
): Promise<DeferredJobRecord> {
	const job = await getJob(id);
	if (!job) {
		throw new Error(`Job "${id}" not found in job registry.`);
	}
	if (job.state === "cancelled") return job;
	if (job.state !== "running") {
		throw new Error(`Job "${id}" is already ${job.state}.`);
	}
	// Write the decision BEFORE aborting: the abort rejects the worker
	// synchronously, and its catch would otherwise race this write and land as
	// "failed" on a job the user just cancelled.
	await updateJob(id, { state: "cancelled", cancelReason: reason });
	inFlight.get(id)?.abort(new Error(reason));
	inFlight.delete(id);
	const settled = (await getJob(id)) as DeferredJobRecord;
	if (settled.state === "cancelled") return settled;
	// A worker outcome read before this write can land after it; the decision wins.
	return (await updateJob(id, { state: "cancelled", cancelReason: reason })) as DeferredJobRecord;
}

async function finishJob(id: string, updates: Partial<DeferredJobRecord>): Promise<void> {
	const current = await getJob(id);
	// A cancelled job is a decision, not a missing update: its worker may
	// finish a fraction of a second later while the process is dying.
	if (current?.state === "cancelled") return;
	await updateJob(id, updates);
}

export async function listInFlightJobs(): Promise<DeferredJobRecord[]> {
	const all = await listJobs();
	return all.filter((job) => job.state === "running");
}

export function dispatchDeferredJob<T>(
	type: string,
	worker: (signal: AbortSignal) => Promise<T>,
	metadata?: Record<string, unknown>,
): Promise<DeferredJobHandle> {
	return createJob(type, metadata).then((job) => {
		const controller = new AbortController();
		inFlight.set(job.id, controller);
		Promise.resolve()
			.then(() => worker(controller.signal))
			.then(async (result) => {
				await finishJob(job.id, { state: "completed", result });
			})
			.catch(async (error) => {
				await finishJob(job.id, {
					state: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				inFlight.delete(job.id);
			});

		return {
			jobId: job.id,
			state: "running",
		};
	});
}

export async function blenderJobStatus(options: { jobId: string }): Promise<DeferredJobRecord> {
	const job = await getJob(options.jobId);
	if (!job) {
		throw new Error(`Job "${options.jobId}" not found in job registry.`);
	}
	return job;
}
