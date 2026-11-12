import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { join } from "node:path";
import { getBlenderAssetsDir } from "../config.js";

const RESPONSE_PREFIX = "__PI_WARM__";

interface WarmWorker {
	child: ChildProcessWithoutNullStreams;
	pending: {
		resolve: (result: WarmJobResult) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
		output: string;
	} | null;
	buffer: string;
	jobs: number;
}

export interface WarmJobResult {
	code: number;
	stdout: string;
	stderr: string;
	pid: number;
	reused: boolean;
}

export interface WarmJobOptions {
	command: string;
	args: string[];
	cwd: string;
	scriptPath: string;
	payload: Record<string, unknown>;
	scriptArgs?: string[];
	blendPath?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	onSpawn?: (pid: number) => void;
}

let idle: WarmWorker[] = [];
const live = new Set<WarmWorker>();
let spawned = 0;
let reused = 0;

export function warmPoolEnabled(): boolean {
	return /^(1|true|yes)$/i.test(process.env.PI_BLENDER_WARM_POOL ?? "");
}

export function warmPoolStats(): { spawned: number; reused: number; idle: number; live: number } {
	return { spawned, reused, idle: idle.length, live: live.size };
}

export function resetWarmPoolForTests(): void {
	for (const worker of live) worker.child.kill("SIGKILL");
	idle = [];
	live.clear();
	spawned = 0;
	reused = 0;
}

type UnrefableStream = { _handle?: { ref?: () => void; unref?: () => void } };

function setReferenced(worker: WarmWorker, referenced: boolean): void {
	const method = referenced ? "ref" : "unref";
	if (referenced) worker.child.ref();
	else worker.child.unref();
	for (const stream of [worker.child.stdin, worker.child.stdout, worker.child.stderr]) {
		// SAFETY: Node's child stdio are Socket instances at runtime; the public
		// ChildProcess type exposes only Readable/Writable, whose handles cannot
		// be ref/unref'd. Without this the idle worker keeps Node alive forever.
		(stream as unknown as UnrefableStream)._handle?.[method]?.();
	}
}

function workerLimit(): number {
	const configured = Number(process.env.PI_BLENDER_WARM_JOBS ?? 25);
	return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 25;
}

function spawnWorker(
	command: string,
	args: string[],
	cwd: string,
	onSpawn?: (pid: number) => void,
): WarmWorker {
	const driver = join(getBlenderAssetsDir(), "warm_worker.py");
	const child = spawn(command, [...args, "--background", "--factory-startup", "--python", driver], {
		cwd,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const worker: WarmWorker = { child, pending: null, buffer: "", jobs: 0 };
	child.stdout.setEncoding("utf-8");
	child.stderr.setEncoding("utf-8");
	child.stdout.on("data", (chunk: string) => {
		worker.buffer += chunk;
		const lines = worker.buffer.split("\n");
		worker.buffer = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith(RESPONSE_PREFIX) || !worker.pending) continue;
			const pending = worker.pending;
			worker.pending = null;
			clearTimeout(pending.timer);
			worker.jobs += 1;
			try {
				const response = JSON.parse(line.slice(RESPONSE_PREFIX.length)) as {
					code: number;
					stdout: string;
					stderr: string;
					pid: number;
				};
				pending.resolve({
					...response,
					stderr: `${response.stderr}${pending.output}`.trim(),
					reused: worker.jobs > 1,
				});
			} catch (error) {
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
	});
	child.stderr.on("data", (chunk: string) => {
		if (worker.pending) worker.pending.output += chunk;
	});
	// Death between idle.pop() and the write is a supported case; without these
	// listeners Node raises an unhandled 'error' and the caller's promise never
	// settles.
	const failPending = (error: Error) => {
		const pending = worker.pending;
		if (!pending) return;
		worker.pending = null;
		clearTimeout(pending.timer);
		pending.reject(error);
	};
	child.stdin.on("error", (error) => failPending(error instanceof Error ? error : new Error(String(error))));
	child.on("error", (error) => failPending(error));
	child.on("exit", (code, signal) => {
		live.delete(worker);
		idle = idle.filter((entry) => entry !== worker);
		if (worker.pending) {
			const pending = worker.pending;
			worker.pending = null;
			clearTimeout(pending.timer);
			pending.reject(
				new Error(
					`Blender warm worker exited before answering (code ${code ?? "null"}, signal ${signal ?? "none"}).${pending.output.trim() ? `\n${pending.output.trim()}` : ""}`,
				),
			);
		}
	});
	spawned += 1;
	live.add(worker);
	setReferenced(worker, false);
	if (child.pid) onSpawn?.(child.pid);
	return worker;
}

async function acquire(
	command: string,
	args: string[],
	cwd: string,
	onSpawn?: (pid: number) => void,
): Promise<WarmWorker> {
	cwd = resolvePath(cwd);
	const worker = idle.pop();
	if (worker) {
		reused += 1;
		if (worker.child.pid) onSpawn?.(worker.child.pid);
		return worker;
	}
	return spawnWorker(command, args, cwd, onSpawn);
}

function release(worker: WarmWorker, healthy: boolean): void {
	if (!healthy || worker.jobs >= workerLimit()) {
		worker.child.kill("SIGTERM");
		setTimeout(() => worker.child.kill("SIGKILL"), 2_000).unref();
		return;
	}
	idle.push(worker);
}

export async function runWarmJob(options: WarmJobOptions): Promise<WarmJobResult> {
	const worker = await acquire(options.command, options.args, options.cwd, options.onSpawn);
	const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	const timeoutMs = options.timeoutMs ?? 300_000;
	const request = {
		id,
		script: options.scriptPath,
		payload: options.payload,
		scriptArgs: options.scriptArgs ?? [],
		blendPath: options.blendPath ?? null,
		cwd: resolvePath(options.cwd),
	};
	return new Promise<WarmJobResult>((resolve, reject) => {
		const cleanup = (healthy: boolean) => {
			options.signal?.removeEventListener("abort", onAbort);
			setReferenced(worker, false);
			release(worker, healthy);
		};
		const onAbort = () => {
			worker.pending = null;
			cleanup(false);
			worker.child.kill("SIGKILL");
			reject(new Error("Blender warm job aborted."));
		};
		const timer = setTimeout(() => {
			worker.pending = null;
			cleanup(false);
			worker.child.kill("SIGKILL");
			reject(new Error(`Blender warm job timed out after ${timeoutMs} ms.`));
		}, timeoutMs);
		worker.pending = {
			resolve: (result) => {
				cleanup(result.code === 0);
				resolve(result);
			},
			reject: (error) => {
				cleanup(false);
				reject(error);
			},
			timer,
			output: "",
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		setReferenced(worker, true);
		worker.child.stdin.write(`${JSON.stringify(request)}\n`);
	});
}
