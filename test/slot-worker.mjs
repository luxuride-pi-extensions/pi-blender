// One contender for the cross-process admission slot.
//
// A worker thread is a separate module instance contending on the same files,
// which is enough to exercise the gate: the primitive is `open(..., "wx")`, and
// a thread cannot see another thread's in-memory count any more than a process
// can.

import { parentPort, workerData } from "node:worker_threads";

const { createJiti } = await import(workerData.jiti);
const jiti = createJiti(import.meta.url, { isolated: true, interopDefault: true });
const { acquireHeadlessSlot, releaseHeadlessSlot } = await jiti.import(workerData.module);

const slot = await acquireHeadlessSlot(workerData.limit);
parentPort.postMessage({ event: "admitted", index: slot.index });
await new Promise((resolve) => parentPort.once("message", resolve));
releaseHeadlessSlot(slot);
parentPort.postMessage({ event: "released" });
