import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

/**
 * Run the joint sweep against a real Blender.
 *
 * Every number the joint check reports is computed from bpy/mathutils, so a
 * JS mock would only prove the arithmetic is self-consistent with itself --
 * it could not have caught the two bugs this sweep actually shipped with: a
 * bounding-box gap whose sign was inverted, so the distance filter never
 * rejected anything, and a containment test that read the wrong extreme, so a
 * chair under a table counted as one box swallowing the other. Both were
 * found by MEASURING a scene whose correct answers are known by
 * construction, and neither was visible in the code.
 *
 * The sibling probes in this directory (shape-probe.py, montage-probe.py,
 * readonly-probe.py) predate the `blendPath` the geometry handler requires,
 * so they throw before they assert anything and no runner here invokes them.
 * This file drives the one that works.
 */

/** Blender as a runnable argv prefix, or null when there is none. */
function detectBlender() {
	const candidates = [
		{ how: "flatpak", prefix: ["flatpak", "run", "org.blender.Blender"] },
		{ how: "path", prefix: ["blender"] },
	];
	for (const candidate of candidates) {
		const probe = spawnSync(candidate.prefix[0], [...candidate.prefix.slice(1), "--version"], {
			encoding: "utf8",
			timeout: 60_000,
		});
		if (!probe.error && probe.status === 0) return candidate.prefix;
	}
	return null;
}

describe("joint sweep against a real Blender", () => {
	const blender = detectBlender();
	test("test/joint-probe.py passes", { skip: blender ? false : "no Blender found" }, () => {
		const result = spawnSync(
			blender[0],
			[
				...blender.slice(1),
				"--background",
				"--factory-startup",
				"--python",
				join(import.meta.dirname, "joint-probe.py"),
			],
			{
				encoding: "utf8",
				timeout: 300_000,
				maxBuffer: 32 * 1024 * 1024,
				// A flatpak Blender cannot see the host's /tmp -- it is the
				// sandbox's own -- so a fixture written there is invisible to
				// the process under test. The scratch dir only has to be one
				// the sandbox shares, so keep whatever HOME gives us.
				env: { ...process.env, HOME: homedir() },
			},
		);
		if (result.error) throw result.error;
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		// spawnSync plus the SUMMARY line, not the exit code: a Blender script
		// exception is a traceback on stderr and Blender still exits 0, so the
		// exit code cannot be the signal. Assert on the absence of the summary
		// so a failure is a failure even when Blender reports success.
		if (!output.includes("PASS: joint sweep and island count agree with known geometry")) {
			throw new Error(`joint-probe.py did not pass:\n${output.slice(-8000)}`);
		}
	});
});
