/**
 * Stand-in for the pi-blender fork's `../core/exec.js`.
 * Same ExecResult shape as the original (stdout, stderr, code, killed),
 * but runs the command as an argv array (no shell) so flatpak wrapper
 * commands like "flatpak run --command=blender org.blender.Blender" work.
 */

import { spawn } from "node:child_process";

export interface ExecOptions {
	signal?: AbortSignal;
	timeout?: number;
	cwd?: string;
	/**
	 * Called with the child's pid as soon as it exists, before any output.
	 *
	 * The pid is knowable only here: it is minted by the spawn, and the
	 * promise resolves at exit. A caller that needs to record the process
	 * against something (a lease file, a registry) while the process is still
	 * running has no other hook for it.
	 */
	onSpawn?: (pid: number) => void;
}

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Operation aborted.");
	}
	return await new Promise((resolvePromise) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let killed = false;
		let spawnError: Error | undefined;
		let settled = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let abortListener: (() => void) | undefined;

		// Before any stream handling: a listener that registers the child can
		// run before the process has produced a byte, and a pid learned late
		// would leave the earliest part of the run unrecorded.
		if (options?.onSpawn && proc.pid !== undefined) options.onSpawn(proc.pid);

		const finish = () => {
			// `error` and `close` can both fire (a failed exec emits error, then
			// close); resolving twice is harmless for a Promise but used to
			// double-clear timers and re-report a settled result.
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			if (abortListener && options?.signal) {
				options.signal.removeEventListener("abort", abortListener);
			}
			// A process that never started has no exit code and was not killed, so
			// the old `?? (killed ? 1 : 0)` reported success for a spawn failure
			// (e.g. a bad BLENDER_PATH producing ENOENT) and callers checking
			// `code !== 0` saw a clean run. Report 127, the conventional
			// "command not found" status, and say so on stderr.
			let code: number;
			if (spawnError) {
				code = 127;
			} else if (proc.exitCode !== null) {
				code = proc.exitCode;
			} else {
				code = killed ? 1 : 0;
			}
			resolvePromise({ stdout, stderr, code, killed });
		};

		const killProcess = () => {
			if (killed) return;
			killed = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5_000).unref();
		};

		if (options?.timeout) {
			timeoutId = setTimeout(killProcess, options.timeout);
		}

		if (options?.signal) {
			abortListener = () => killProcess();
			options.signal.addEventListener("abort", abortListener, { once: true });
		}

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		proc.on("error", (error) => {
			spawnError = error;
			stderr += `\n${error.message}`;
			finish();
		});
		proc.on("close", (code) => {
			// A null code with no spawn error means the process died on a signal
			// (killed here, or externally) rather than exiting normally.
			if (code === null) killed = true;
			finish();
		});
	});
}
