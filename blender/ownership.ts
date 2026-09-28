/**
 * Which pi instance owns a workspace, and who may touch it.
 *
 * Every pi process has a private bridge dir and therefore a private Blender UI
 * (see config.ts). That isolation is what makes two instances safe to run at
 * once — but it also means a second instance opening the same workspace opens
 * the SAME model.blend in a SECOND Blender. Two UIs on one file overwrite each
 * other on save, and neither knows the other exists: the second one silently
 * replaces the first one's work with a stale copy.
 *
 * So a workspace records which instance claimed it, and a live peer is
 * refused rather than shared. Sharing was considered and rejected: one UI
 * driven from two sessions has no owner for "what is selected" or "is this
 * dirty", the ambiguity the whole snapshot mechanism exists to prevent, and a
 * routing layer to send each request to the right UI is a large change for a
 * case the user does not want.
 *
 * The check is deliberately cheap and deliberately forgiving:
 *
 *   self    — our claim, do nothing.
 *   live    — a peer's pi is running with a live UI on this blend. REFUSE.
 *   dead    — nothing is answering. Take over silently.
 *   unknown — the claim is unreadable or names no live peer. Take over.
 *
 * "Take over silently" is right because a dead claim is not a fact about the
 * workspace any more: the process that wrote it is gone, so the file on disk is
 * whatever that process last saved and nobody is watching it. A claim that can
 * never block anyone is worse than no claim at all, because it makes a crashed
 * session look like a locked one.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getBlenderBridgeRootDir, getBlenderInstanceId, hasBridgeDirOverride } from "../config.js";
import { isHeartbeatFresh, isHeartbeatPidAlive, readHeartbeatBlendPath } from "./liveness.js";
import type { BlenderWorkspaceManifest, WorkspaceOwner } from "./types.js";

/** What the recorded claim means right now. */
export type OwnerLiveness = "self" | "live" | "dead" | "unknown";

export interface LiveOwnerInfo {
	instanceId: string;
	pid: number;
	bridgeDir: string;
	claimedAt: string;
	blendPath: string;
}

function toPid(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Same one-way rule as the reaper and the heartbeat: EPERM means alive. */
function pidIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Classify a workspace's recorded owner.
 *
 * The peer's own instance.json is the authority, not the claim's pid: the claim
 * records who WROTE it, while the bridge dir records who is USING it now. A
 * mismatch means the dir has been recycled and the claim is stale.
 */
export async function classifyWorkspaceOwner(manifest: BlenderWorkspaceManifest): Promise<OwnerLiveness> {
	const owner = manifest.owner;
	if (!owner || toPid(owner.pid) === null) return "unknown";
	if (owner.instanceId === getBlenderInstanceId()) return "self";

	const bridgeDir = join(getBlenderBridgeRootDir(), owner.instanceId);
	let recordedPid: number | null = null;
	try {
		const parsed: unknown = JSON.parse(await readFile(join(bridgeDir, "instance.json"), "utf-8"));
		if (typeof parsed === "object" && parsed !== null) {
			recordedPid = toPid((parsed as { pid?: unknown }).pid);
		}
	} catch {
		// No instance file: either the peer's dir is gone, or it was never ours
		// to begin with. Both mean nothing is answering on that dir now.
		recordedPid = null;
	}

	if (recordedPid === null) return "dead";
	// The dir belongs to a different process than the one that wrote the claim.
	if (recordedPid !== owner.pid) return "dead";
	if (!pidIsRunning(recordedPid)) return "dead";

	// The peer's pi is alive. Its UI may still be booting, so a missing
	// heartbeat is NOT grounds for a takeover — that is the same reasoning as
	// the reaper's "owner pi still running, bridge not started yet". Only a
	// heartbeat whose pid is confirmed dead contradicts a live owner.
	if (isHeartbeatFresh(bridgeDir) && !isHeartbeatPidAlive(bridgeDir)) return "dead";
	return "live";
}

/** Details for the refusal message, or null when there is no live peer. */
export async function describeLiveOwner(manifest: BlenderWorkspaceManifest): Promise<LiveOwnerInfo | null> {
	if ((await classifyWorkspaceOwner(manifest)) !== "live" || !manifest.owner) return null;
	return {
		instanceId: manifest.owner.instanceId,
		pid: manifest.owner.pid,
		bridgeDir: join(getBlenderBridgeRootDir(), manifest.owner.instanceId),
		claimedAt: manifest.owner.claimedAt,
		blendPath: manifest.owner.blendPath,
	};
}

/** The claim this process writes. */
export function buildWorkspaceOwner(blendPath: string): WorkspaceOwner {
	return {
		instanceId: getBlenderInstanceId(),
		pid: process.pid,
		blendPath,
		claimedAt: new Date().toISOString(),
	};
}

/**
 * Every OTHER live instance whose UI currently has `blendPath` open.
 *
 * This is the read-only counterpart to the refusal below, and it answers a
 * question the manifest cannot: not "who claimed this workspace" but "is anyone
 * else looking at this file right now". The two differ -- a peer's UI can hold
 * the blend while its manifest claim is stale, and a claim can be live while the
 * UI sits on a different file because the user opened something else by hand.
 *
 * Read from heartbeats rather than claims, because a beating UI is the actual
 * evidence of possession. An instance dir with no instance.json is still
 * reported (pid 0): the UI is provably up, and hiding it would be the one case
 * where a duplicate window matters most.
 */
export async function findLiveOwnersOfBlend(blendPath: string): Promise<LiveOwnerInfo[]> {
	// A pinned bridge dir has no sibling instance dirs to enumerate, so this
	// scheme is off entirely; "no peers" is the honest answer there.
	if (hasBridgeDirOverride()) return [];

	const root = getBlenderBridgeRootDir();
	const self = getBlenderInstanceId();
	let entries: string[];
	try {
		entries = await readdir(root);
	} catch {
		return [];
	}

	const found: LiveOwnerInfo[] = [];
	for (const entry of entries) {
		if (entry === self) continue;
		const bridgeDir = join(root, entry);
		// A beating heartbeat with a confirmed dead pid is a crash, not a peer.
		if (!isHeartbeatFresh(bridgeDir) || !isHeartbeatPidAlive(bridgeDir)) continue;
		if (readHeartbeatBlendPath(bridgeDir) !== blendPath) continue;

		let pid = 0;
		try {
			const parsed: unknown = JSON.parse(await readFile(join(bridgeDir, "instance.json"), "utf-8"));
			if (typeof parsed === "object" && parsed !== null) {
				pid = toPid((parsed as { pid?: unknown }).pid) ?? 0;
			}
		} catch {
			pid = 0;
		}
		found.push({ instanceId: entry, pid, bridgeDir, claimedAt: "", blendPath });
	}
	return found;
}

/**
 * Refuse a workspace another live instance is driving.
 *
 * Called from the one chokepoint every workspace tool goes through, because a
 * guard that only some callers remember is not a guard. The message names the
 * other instance and says what to do, since "refused" with no way forward
 * reads as a bug.
 */
export function assertWorkspaceOwnership(manifest: BlenderWorkspaceManifest, live: LiveOwnerInfo | null): void {
	if (!live) return;
	throw new Error(
		`This workspace is already open in another live pi instance, so opening it here would give two Blender windows one model.blend and let them overwrite each other.\n\n` +
			`  workspace: ${manifest.workspacePath}\n` +
			`  owned by:   pi instance ${live.instanceId} (pid ${live.pid}, claimed ${live.claimedAt})\n` +
			`  its UI:     ${live.bridgeDir}\n\n` +
			`Work on it in that session, or use a separate workspace for this one. If that instance has actually exited, ` +
			`re-run this call — a dead owner's claim is taken over automatically, so nothing needs cleaning up by hand.`,
	);
}
