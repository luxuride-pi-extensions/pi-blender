/**
 * Loads config.ts in a CHILD process and prints what it resolved, as JSON.
 *
 * Why a child process rather than importing in-process: config.ts mints the
 * session instance id at module load and publishes it into process.env, and
 * jiti caches a module per instance. An in-process harness therefore hands the
 * second test the first test's module -- same env, same id -- no matter how
 * carefully it saves and restores process.env. The cache is the thing to escape,
 * and a fresh process is the only honest way to escape it.
 *
 * Usage: node test/probe.mjs '<env JSON>'   (process.env is inherited)
 * Prints one JSON object on stdout; diagnostics go to stderr.
 */

import { loadTs } from "./paths.mjs";

const env = JSON.parse(process.argv[2] ?? "{}");
for (const [key, value] of Object.entries(env)) {
	if (value === null) delete process.env[key];
	else process.env[key] = value;
}

const config = await loadTs("../config.ts");

// writeInstanceFile touches the filesystem, so it runs only when asked for.
if (env.PI_PROBE_WRITE_INSTANCE === "1") {
	config.writeInstanceFile();
	// Read it back in the child, so the parent never has to guess what landed.
	const { readFileSync, existsSync, readdirSync } = await import("node:fs");
	const { join } = await import("node:path");
	const dir = config.getBlenderBridgeDir();
	const ownerPath = join(dir, "instances", `${process.pid}.json`);
	process.stdout.write(
		JSON.stringify({
			instanceId: config.getBlenderInstanceId(),
			bridgeDir: dir,
			shared: JSON.parse(readFileSync(join(dir, "instance.json"), "utf8")),
			ownerExists: existsSync(ownerPath),
			ownerPid: existsSync(ownerPath) ? JSON.parse(readFileSync(ownerPath, "utf8")).pid : null,
			leftoverTmp: existsSync(dir) ? readdirSync(dir).filter((n) => n.includes(".tmp")) : null,
		}),
	);
	process.exit(0);
}

process.stdout.write(
	JSON.stringify({
		instanceId: config.getBlenderInstanceId(),
		bridgeRoot: config.getBlenderBridgeRootDir(),
		bridgeDir: config.getBlenderBridgeDir(),
		hasBridgeDirOverride: config.hasBridgeDirOverride(),
		tempDir: config.getBlenderTempDir(),
		blankPath: config.getBlankBlendPath(),
		managerPrompt: config.getManagerPrompt(),
		assetsDir: config.getBlenderAssetsDir(),
		bridgeScript: config.getBundledBlenderBridgePath(),
	}),
);
