/**
 * Minimal stand-in for the vibe-blender fork's `../config.js` so the extracted
 * blender module can run unmodified under the stock pi extension loader.
 *
 * Paths:
 *  - assets dir: this extension's `blender/` directory (scripts + skills)
 *  - bridge dir: $PI_BLENDER_BRIDGE_DIR (supports `~/`, used EXACTLY as given)
 *    or $XDG_CACHE_HOME/vibe-blender/bridge/<instance-id>
 *  - temp dir:   $XDG_CACHE_HOME/vibe-blender/tmp  (flatpak-visible)
 *
 * Every pi SESSION gets its own bridge dir and therefore its own private
 * Blender UI. The alternative — one shared dir — makes every request from every
 * session contend for a single lock and a single mutable scene, so a second
 * window costs minutes of queueing and can interleave mutations with the first.
 * The cost of isolation is memory and one more Blender window to keep straight,
 * which is the trade the user chose.
 *
 * The unit is the SESSION, not the process, and the distinction is load-bearing.
 * pi-subagents runs every subagent as its own `node` process (see
 * runs/background/async-execution.js), and a foreground child does not load
 * ambient parent extensions — it is handed the extension list in its agent
 * template's `extensions:` frontmatter. So a spawned blender-worker loaded
 * pi-vibe-blender into a brand-new process. When the id was minted with
 * randomUUID() per process, that child resolved a bridge dir no Blender had
 * ever polled, isLiveBridgeAlive() said false, and it launched a SECOND Blender
 * to service its own requests. The manager and each of its workers then drove
 * separate UIs on separate scenes, which is exactly the duplicate-window
 * failure this scheme exists to prevent — reintroduced through the delegation
 * path instead of the second-terminal path it was designed for.
 *
 * So the id is inherited, not minted: it is resolved once per process, then
 * published into process.env, which is what a spawned child inherits. Every
 * process in one session's delegation tree agrees on one dir and one UI. Two
 * genuinely separate pi sessions still mint separate ids, because each one
 * loads the extension in its own root process and never sees the other's env.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)));

export const APP_NAME = "vibe-blender";

/**
 * Env var carrying the session's instance id to child processes.
 *
 * Named separately from PI_BLENDER_BRIDGE_DIR on purpose: the bridge dir is the
 * resolved absolute path, and a child that inherited a path would be pinned to
 * whatever the parent had resolved — including a `~/`-relative or cwd-relative
 * form evaluated against the wrong directory. The id is the session identity
 * itself, so every process resolves it to the same dir from its own cwd.
 */
export const ENV_BLENDER_INSTANCE_ID = "PI_BLENDER_INSTANCE_ID";

/**
 * A usable instance id, or null.
 *
 * This id becomes a path segment, so it is validated rather than trusted: the
 * env var is a plain string that anything in the environment can set, and
 * "../.." or an absolute path in it would redirect the bridge dir out of the
 * bridge root entirely. Restricted to characters that need no escaping, and
 * refused outright if it could traverse or escape.
 */
function normalizeInstanceId(raw: string | undefined): string | null {
	const value = raw?.trim();
	if (!value) return null;
	if (value === "." || value === ".." || value.includes("/") || value.includes("\\")) return null;
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(value)) return null;
	return value;
}

/**
 * This session's bridge id: the one inherited from the parent process if there
 * is one, otherwise a fresh random one.
 */
function resolveInstanceId(): string {
	const inherited = normalizeInstanceId(process.env[ENV_BLENDER_INSTANCE_ID]);
	if (inherited) return inherited;
	// Dashes stripped so the id is clean hex in a path and in the instance files
	// it is written to. Cosmetic, but the id is what a user sees when hunting
	// through the bridge root, and "bridge/a1b2c3d4e5f6" is easier to eyeball
	// than one with a stray separator in the middle.
	return randomUUID().replace(/-/g, "").slice(0, 12);
}

const INSTANCE_ID = resolveInstanceId();
// Published at module load, NOT lazily on first use. A child is spawned from
// whatever the parent had already done, and a parent that has not touched
// Blender yet has not called getBlenderInstanceId() — so publishing lazily
// would leave a subagent spawned early in the session to mint its own id and
// launch its own Blender. Module load happens in the session's root process
// before any subagent can exist, which is exactly the guarantee needed. In a
// child this is a no-op: it re-publishes the value it just inherited.
process.env[ENV_BLENDER_INSTANCE_ID] = INSTANCE_ID;

/**
 * Stable id for this pi SESSION's private bridge, identical in every process
 * of the session's delegation tree.
 *
 * A pid alone is not an identity: the OS reuses pids, so a stale directory left
 * by a killed pi process could collide with a new one and inherit a heartbeat
 * written by a Blender this process did not start. The random id makes that
 * collision-free, and pids are recorded separately (see writeInstanceFile) for
 * reaping, where "is an owner still running" is the actual question.
 */
export function getBlenderInstanceId(): string {
	return INSTANCE_ID;
}

/** Directory holding every instance's bridge dir. */
export function getBlenderBridgeRootDir(): string {
	const envDir = process.env[ENV_BLENDER_BRIDGE_DIR]?.trim();
	if (envDir) {
		if (envDir === "~") return homedir();
		if (envDir.startsWith("~/")) return homedir() + envDir.slice(1);
		return isAbsolute(envDir) ? envDir : resolve(process.cwd(), envDir);
	}
	// Under the XDG cache home, not /tmp: the flatpak Blender sandbox cannot
	// see /tmp, and this dir has to be visible to the process we spawn.
	return join(xdgCacheHome(), "vibe-blender", "bridge");
}

export function getBlenderAssetsDir(): string {
	return join(EXTENSION_DIR, "blender");
}

export function getBundledBlenderBridgePath(): string {
	return resolve(join(getBlenderAssetsDir(), "live-bridge.py"));
}

export function getBundledBlankBootstrapPath(): string {
	return resolve(join(getBlenderAssetsDir(), "blank-bootstrap.py"));
}

/**
 * Path the launch bootstrap saves a clean, empty blend to (flatpak-visible).
 *
 * Per-instance for the same reason the bridge dir is: this file is written by
 * the Blender we spawn, and two instances sharing one path would have two
 * Blenders overwriting each other's bootstrap blend — the exact silent-clobber
 * class the request-claim in live-bridge.py exists to prevent.
 */
export function getBlankBlendPath(): string {
	const envPath = process.env.PI_BLENDER_BLANK_BLEND_PATH?.trim();
	if (envPath) {
		if (envPath === "~") return homedir();
		if (envPath.startsWith("~/")) return homedir() + envPath.slice(1);
		return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
	}
	return join(xdgCacheHome(), "vibe-blender", "blank", `${getBlenderInstanceId()}.blend`);
}

export const ENV_BLENDER_BRIDGE_DIR = "PI_BLENDER_BRIDGE_DIR";

/**
 * Whether the user pinned one specific bridge dir by hand.
 *
 * This switches OFF the per-instance scheme entirely: there is no instance
 * subdirectory, so there are no sibling instance dirs, and anything that
 * sweeps for them (the reaper) must not run. Someone who sets this is naming
 * one bridge deliberately, and their directory's contents are theirs.
 */
export function hasBridgeDirOverride(): boolean {
	return Boolean(process.env[ENV_BLENDER_BRIDGE_DIR]?.trim());
}

function xdgCacheHome(): string {
	return process.env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache");
}

/**
 * This pi instance's private bridge dir.
 *
 * $PI_BLENDER_BRIDGE_DIR is honoured EXACTLY as given, with no instance
 * subdirectory appended. Someone who sets it is naming one specific bridge on
 * purpose — to share a UI with another process, or to point at a dir a running
 * Blender already polls — and silently nesting a subdir under it would give a
 * Blender that can never see the requests.
 */
export function getBlenderBridgeDir(): string {
	if (process.env[ENV_BLENDER_BRIDGE_DIR]?.trim()) {
		return getBlenderBridgeRootDir();
	}
	return join(getBlenderBridgeRootDir(), getBlenderInstanceId());
}

/** Subdirectory holding one ownership record per pi process sharing the dir. */
const INSTANCE_OWNERS_DIR_NAME = "instances";

/**
 * Record that THIS pi process is an owner of the bridge dir, so a later sweep
 * can tell an orphan (no owner alive) from a live instance (an owner alive).
 *
 * One file per pid, written only by that pid. A single shared record would have
 * to be read-modify-written by every process in the session's tree, and two
 * processes claiming at the same moment would clobber each other's entry — the
 * surviving record would name one owner, and a sweep seeing that one pid gone
 * would classify a dir a live Blender was about to poll as an orphan. Separate
 * files cannot lose an update, because no process ever writes another's.
 *
 * `instance.json` is still written, holding this process's own record, so a
 * sweep running older code (an already-running pi that loaded the previous
 * version) still finds something it can read.
 */
export function writeInstanceFile(): void {
	const dir = getBlenderBridgeDir();
	mkdirSync(dir, { recursive: true });
	const record = {
		pid: process.pid,
		instanceId: getBlenderInstanceId(),
		startedAt: new Date().toISOString(),
	};
	// Atomic publish, matching writeManifest in blender/workspace.ts. A peer
	// reading this file while it is half-written would see invalid JSON, and
	// the ownership check treats unreadable-as-dead -- so a plain writeFile
	// here could hand a LIVE peer's dir to a newcomer's sweep on a torn read.
	const ownersDir = join(dir, INSTANCE_OWNERS_DIR_NAME);
	mkdirSync(ownersDir, { recursive: true });
	const ownersPath = join(ownersDir, `${process.pid}.json`);
	const ownersTemp = join(ownersDir, `${process.pid}.${Date.now()}.tmp`);
	writeFileSync(ownersTemp, JSON.stringify(record), "utf-8");
	renameSync(ownersTemp, ownersPath);

	const path = join(dir, "instance.json");
	const tempPath = join(dir, `instance.${process.pid}.tmp`);
	writeFileSync(tempPath, JSON.stringify(record), "utf-8");
	renameSync(tempPath, path);
}

/**
 * Directory safe for flatpak-launched Blender to read and write temp scripts.
 * /tmp and $XDG_RUNTIME_DIR are NOT visible inside the org.blender.Blender
 * sandbox; the XDG cache home is bind-mounted.
 */
const ensuredTempDirs = new Set<string>();

export function getBlenderTempDir(): string {
	const dir = process.env.PI_BLENDER_TMP_DIR?.trim()
		? process.env.PI_BLENDER_TMP_DIR
		: join(xdgCacheHome(), "vibe-blender", "tmp");
	// mkdirSync is a blocking syscall on a path reached from async tool code,
	// on every temp script. The directory only needs creating once per process;
	// if something removes it later, the next write surfaces the error rather
	// than silently racing a half-created dir.
	if (!ensuredTempDirs.has(dir)) {
		mkdirSync(dir, { recursive: true });
		ensuredTempDirs.add(dir);
	}
	return dir;
}
