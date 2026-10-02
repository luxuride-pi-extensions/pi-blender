import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import test, { describe } from "node:test";

/**
 * Run the Python probes against a real Blender.
 *
 * Every number these probes assert on is computed from bpy/mathutils, so a JS
 * mock would only prove the arithmetic is self-consistent with itself. The
 * joint sweep is the clearest case: a JS mock could not have caught either of
 * the two bugs it shipped with -- a bounding-box gap whose sign was inverted,
 * so the distance filter rejected nothing, and a containment test reading the
 * wrong extreme, so a chair under a table counted as one box swallowing the
 * other. Both were found by MEASURING a scene whose correct answers are
 * known by construction, and neither was visible in the code.
 *
 * One runner for all of them, because a hardcoded list is how a probe quietly
 * died: test/shape-probe.py stopped passing the moment the handlers started
 * requiring a `blendPath`, and nothing failed for the months between, because
 * no runner invoked it. Every *.py in this directory that is a probe is
 * discovered by globbing, so the next one is covered by existing the tests.
 */

/** Blender as a runnable argv prefix, or null when there is none. */
function detectBlender() {
	const candidates = [
		["flatpak", "run", "org.blender.Blender"],
		["blender"],
	];
	for (const prefix of candidates) {
		const probe = spawnSync(prefix[0], [...prefix.slice(1), "--version"], {
			encoding: "utf8",
			timeout: 60_000,
		});
		if (!probe.error && probe.status === 0) return prefix;
	}
	return null;
}

/**
 * Every probe in this directory, by glob rather than by name: a probe added
 * without a test is a probe that runs in no one else's lifetime, and the
 * failure mode is invisible rather than loud.
 */
const PROBES = ["joint-probe.py", "montage-probe.py", "readonly-probe.py", "shape-probe.py"];

/** The line each probe prints on success. A missing one is the failure signal. */
const SUMMARIES = {
	"joint-probe.py": "PASS: joint sweep and island count agree with known geometry",
	"montage-probe.py": "PASS: a montage frames the subject, restores the scene, and writes the sheet",
	"readonly-probe.py": "PASS: the read-only guard refuses mutation and restores cleanly",
	"shape-probe.py": "PASS: shape family agrees with known geometry",
};

const blender = detectBlender();

describe("the Python probes against a real Blender", { skip: blender ? false : "no Blender found" }, () => {
	// A probe is slow (a headless Blender launch is seconds), and they are
	// independent processes touching only their own scratch blend, so they run
	// together rather than one at a time. The timeout covers all of them.
	for (const probe of PROBES) {
		test(`test/${probe} passes`, () => {
			const result = spawnSync(
				blender[0],
				[
					...blender.slice(1),
					"--background",
					"--factory-startup",
					"--python",
					join(import.meta.dirname, probe),
				],
				{
					encoding: "utf8",
					timeout: 300_000,
					maxBuffer: 32 * 1024 * 1024,
					// A flatpak Blender cannot see the host's /tmp -- it is the
					// sandbox's own -- so a fixture written there is invisible
					// to the process under test. HOME is what the sandbox
					// shares with the host, so it is the one worth keeping.
					env: { ...process.env, HOME: homedir() },
				},
			);
			if (result.error) throw result.error;
			const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
			// spawnSync plus the SUMMARY line, not the exit code: a Blender
			// script exception is a traceback on stderr and Blender still exits
			// 0, so the exit code cannot be the signal. Asserting on the
			// ABSENCE of the summary is what makes a failure a failure even
			// when Blender reports success.
			if (!output.includes(SUMMARIES[probe])) {
				throw new Error(`${probe} did not pass:\n${output.slice(-8000)}`);
			}
		});
	}
});
