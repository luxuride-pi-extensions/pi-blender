import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderBridgeDir } from "../config.js";

export type DeferredJobState = "running" | "completed" | "failed";

export interface DeferredJobRecord {
	id: string;
	type: string;
	state: DeferredJobState;
	createdAt: string;
	updatedAt: string;
	result?: unknown;
	error?: string;
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

export async function getJob(id: string): Promise<DeferredJobRecord | null> {
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

export async function listInFlightJobs(): Promise<DeferredJobRecord[]> {
	const all = await listJobs();
	return all.filter((job) => job.state === "running");
}

export function dispatchDeferredJob<T>(
	type: string,
	worker: () => Promise<T>,
	metadata?: Record<string, unknown>,
): Promise<DeferredJobHandle> {
	return createJob(type, metadata).then((job) => {
		Promise.resolve()
			.then(worker)
			.then((result) => {
				return updateJob(job.id, {
					state: "completed",
					result,
				});
			})
			.catch((error) => {
				return updateJob(job.id, {
					state: "failed",
					error: error instanceof Error ? error.message : String(error),
				});
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
