/**
 * Child-process contender for the session-wide headless budget.
 *
 * It holds the slot until the parent kills it, which is what lets the parent
 * assert the slot is not reclaimed while the owner's Blender (here, the child
 * itself) is alive, and is reclaimed after the owner dies.
 */
const modulePath = process.argv[2];
const limit = Number(process.argv[3] ?? "1");
const jitiPath = process.argv[4];
const { createJiti } = await import(jitiPath);
const jiti = createJiti(import.meta.url, { isolated: true, interopDefault: true });
const leases = await jiti.import(modulePath);
const slot = await leases.acquireHeadlessSlot(limit);
process.send?.({ admitted: true, index: slot.index, path: slot.path });
process.on("SIGTERM", () => {
	leases.releaseHeadlessSlot(slot);
	process.exit(0);
});
