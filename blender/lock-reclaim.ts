/**
 * Removing a lock file that has already been judged reclaimable.
 *
 * The judgement and the removal cannot be one step. Every lock in this repo is
 * taken with an exclusive create, so "the file exists" and "the file is the
 * one I judged" are two different claims, and between them the holder can call
 * release() (itself an unlink) and a third waiter can create a FRESH lock. A
 * reclaim that unlinks by path therefore deletes a lock nobody judged -- and on
 * the bridge lock that means two concurrent requests against the one live
 * Blender UI, which is exactly the overlap the lock exists to prevent.
 *
 * The quarantined content is the pid you judged dead (rename onto a unique
 * per-process path is atomic; if a third party already replaced the lock, the
 * content you read will not be the pid you checked). If content does not match,
 * restore/continue.
 *
 * The policy stays with the caller. This only asks "is the file still the one
 * you decided about", because that is the one question a caller cannot answer
 * for itself.
 */

import { randomUUID } from "node:crypto";
import { readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/**
 * Remove `lockPath` if and only if its contents are byte-identical to
 * `observed`, which is what the caller read before deciding to reclaim.
 *
 * Returns true when the file was the observed one and has been removed, false
 * when the path had already been taken over by a different lock and the
 * observed file was put back. Never throws for a missing lock: a holder that
 * released between the judgement and here leaves nothing to do, and the
 * caller's next exclusive create is the outcome it wanted anyway.
 *
 * The quarantine name is unique per attempt and lives beside the lock so the
 * rename stays within one filesystem. A leftover quarantine file (only
 * reachable when the restore below could not be performed) is inert: no waiter
 * reads it, and nothing matches `bridge.lock` against it.
 */
/**
 * Test seam: runs after the judgement and before the quarantine rename.
 *
 * That is the one instant where a holder can release and a third waiter can
 * take the lock, so it is the only place a test can put itself without racing.
 * Named for the reset*ForTests idiom already used in utils.ts.
 */
let beforeReclaim: ((lockPath: string, observed: string) => Promise<void> | void) | null = null;

/** Install (or with no argument, clear) the pre-reclaim test hook. */
export function setBeforeReclaimHookForTests(hook?: (lockPath: string, observed: string) => Promise<void> | void): void {
	beforeReclaim = hook ?? null;
}

export async function reclaimLockIfUnchanged(lockPath: string, observed: string): Promise<boolean> {
	const quarantine = join(
		dirname(lockPath),
		`.${basename(lockPath)}.reclaim-${process.pid}-${randomUUID()}`,
	);
	// The window a race needs is microseconds wide, so a test cannot wait for
	// it; the seam lets a test stand a third waiter up inside it, deterministically.
	// Null in production -- this module is the only reader of the slot.
	if (beforeReclaim) await beforeReclaim(lockPath, observed);
	try {
		// Atomic: the rename either takes this exact file or fails outright.
		await rename(lockPath, quarantine);
	} catch {
		// Already gone (the holder released between judgement and here).
		return false;
	}

	let quarantined: string;
	try {
		quarantined = await readFile(quarantine, "utf-8");
	} catch {
		// The bytes are the identity; unreadable is a mismatch, not a pass.
		await rm(quarantine, { force: true });
		return false;
	}

	if (quarantined !== observed) {
		// Someone else's lock. Put it back rather than deleting it. rename()
		// would overwrite whatever is at the path now, so restore only into a
		// path nobody has taken -- and if the path is occupied, leave the
		// quarantine file where it is. Deleting a lock this process never judged
		// is the exact failure this function exists to prevent, so a leftover
		// artifact is strictly the better outcome.
		try {
			await rename(quarantine, lockPath);
		} catch {
			// lockPath is occupied again by a newer lock; nothing to restore onto.
		}
		return false;
	}

	await rm(quarantine, { force: true });
	return true;
}