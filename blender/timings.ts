import type { RunTimings } from "./types.js";

/** One line a manager can read without opening the timing object. */
export function formatTimings(timings?: Pick<RunTimings, "launchMs" | "execMs" | "renderMs" | "totalMs">): string {
	if (!timings) return "";
	const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
	return `${seconds(timings.launchMs)} launch, ${seconds(timings.execMs)} exec, ${seconds(timings.renderMs)} render (${seconds(timings.totalMs)} total)`;
}
