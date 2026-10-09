import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
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
 * Every probe in this directory, by glob rather than by name.
 *
 * Discovered, not listed. The header above this function says a hardcoded list
 * is how a probe quietly died -- and it did: test/montage-test.py existed, was
 * correct, and no runner ever invoked it. So the directory is scanned, and a
 * probe that does not declare its success line is a hard error here rather than
 * a file nothing looks at.
 *
 * `needsBlender` is read from the probe's own source (an `import bpy`) rather
 * than being declared in this file, for the same reason: a probe's requirements
 * belong to the probe. Without a declaration the only thing a missing runner
 * can do is stay quiet.
 */
function discoverProbes() {
	return readdirSync(import.meta.dirname)
		.filter((name) => name.endsWith(".py"))
		.map((name) => {
			const source = readFileSync(join(import.meta.dirname, name), "utf-8");
			return {
				name,
				needsBlender: /^\s*import bpy\b/m.test(source),
				summary: /print\(\s*(?:f?)(["'])PASS: (.+?)\1/.exec(source)?.[2],
			};
		});
}

const PROBES = discoverProbes();

/**
 * The line each probe prints on success, taken from its own source.
 *
 * A probe with no such line cannot be asserted on, and asserting nothing is
 * what made this file look like coverage while proving nothing, so it fails
 * loudly instead.
 */
function summaryFor(probe) {
	if (!probe.summary) {
		throw new Error(
			`test/${probe.name} prints no "PASS: ..." line, so a successful run cannot be told from a ` +
				`failed one. Print one, or this probe is dead weight in the suite.`,
		);
	}
	return `PASS: ${probe.summary}`;
}

const blender = detectBlender();

describe("the Python probes against a real Blender", { skip: blender ? false : "no Blender found" }, () => {
	// A probe is slow (a headless Blender launch is seconds), and they are
	// independent processes touching only their own scratch blend, so they run
	// together rather than one at a time. The timeout covers all of them.
	//
	// All of them, not only the ones that import bpy: two are pure-Python (the
	// montage tiling test, and the read-only guard's fake-bpy harness) and
	// running them here makes "discovered by globbing" literally true. A probe
	// in this directory is either run or it is not a probe.
	for (const probe of PROBES) {
		test(`test/${probe.name} passes`, () => {
			const result = spawnSync(
				blender[0],
				[
					...blender.slice(1),
					"--background",
					"--factory-startup",
					"--python",
					join(import.meta.dirname, probe.name),
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
			if (!output.includes(summaryFor(probe))) {
				throw new Error(`${probe.name} did not pass:\n${output.slice(-8000)}`);
			}
		});
	}
});
