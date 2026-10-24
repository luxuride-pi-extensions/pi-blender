# ADR 0001: Do Not Rewrite pi-blender as an MCP Server

* **Status:** Accepted
* **Date:** 2026-10-19
* **Deciders:** pi-blender maintainers
* **Consulted:** Issue #16 (Transport-agnostic core and in-process MCP façade), Issue #17

---

## Context

A recurring question in discussions regarding `pi-blender` architecture is whether the extension should be rewritten as a standalone Model Context Protocol (MCP) server, or replaced with / rebased on the baseline `blender_mcp` project.

On the surface, an MCP server appears to offer broad client reach: any agent harness or editor supporting MCP could query Blender tools over JSON-RPC. However, `pi-blender` is not simply an execution wrapper exposing `bpy.ops` to a language model. It is an end-to-end 3D modeling workflow engine built around live UI inspection, measured geometry probes, bounded feedback loops, atomic module checkpoints, and scene contamination auditing.

This Architecture Decision Record (ADR) records the decision not to rewrite `pi-blender` as an MCP server, documents the architectural mechanisms that would be lost in such a rewrite, and establishes the criteria any future architectural proposal must satisfy.

---

## Decision

**We will not rewrite `pi-blender` as an MCP server.**

Instead, we adopt an **in-process MCP façade on an extracted, transport-agnostic core** (see Issue #16).

The dependency hierarchy remains:

$$\text{pi extension} \longrightarrow \text{core service} \longleftarrow \text{MCP façade (stdio / in-process)}$$

The core capability layer handles tool registration definitions, probe computations, and bridge dispatch without depending on pi runtime globals. The pi extension provides the workflow orchestration (manager mode, `/blender` command, prompt injection, manager gate hook, and agent definitions). Third-party clients desiring MCP compatibility interact with an in-process MCP server façade exposing capabilities, without sacrificing the local execution and file-backed workflow semantics of the core.

---

## Why Not, Concretely: Four Mechanisms Lost

A rewrite into a standalone MCP server is not a benign port of transport protocols. It actively breaks or degrades four fundamental mechanisms that `pi-blender` relies on and that the baseline `blender_mcp` class does not possess:

### 1. The Bridge Lock

The live Blender UI is **one mutable session**. When multiple tool calls, parallel subagents (`blender-worker`, `blender-critic`, `blender-diagnostician`), or concurrent pi sessions execute concurrently, uncoordinated access to the live scene causes race conditions, state interleaving, dropped selection context, and corrupt blend files.

* **Existing implementation:** `requestLiveBlenderBridge()` takes `acquireBridgeLock()` before writing a request file into the bridge directory. This cross-process file lock (`<bridge dir>/bridge.lock`) guarantees serialization across parallel pi sessions and spawned subagents. If a session crashes, the lock is stale-reclaimed atomically after 10 minutes (`LIVE_BRIDGE_LOCK_STALE_MS`). Waiters receive diagnostic timeouts naming the holder pid, label, and elapsed duration ("wait your turn").
* **Under a standalone MCP server:** The lock would have to become authoritative for every external client of the server socket. Moving the lock inside a standalone server process invents a distributed locking problem across disconnected client connections to solve a problem `pi-blender` already solved locally using an atomic filesystem lock with robust crash recovery.

### 2. Live / Headless Fallback

`pi-blender` tools communicate through `requestBridge()`, which transparently chooses between a live running Blender instance and a detached background run:

* **Existing implementation:** If the live bridge heartbeat is fresh, requests dispatch directly to the interactive Blender UI. If the UI is absent or the heartbeat expires, `requestBridge()` dispatches to a headless `blender --background` invocation. The constant `WINDOW_ONLY_REQUEST_TYPES` (`set-mode`, `capture-view`) strictly isolates the only two request types that fundamentally require an active graphical viewport and cannot run headlessly; all other requests fallback seamlessly.
* **Under a standalone MCP server:** A stateless MCP server interposed between agent and Blender must make dispatch decisions on the agent's behalf. It routinely gets this wrong in the most critical real-world failure mode: when a live UI is alive but busy executing a long render or baking pass. An external server either prematurely assumes death and spawns conflicting headless tasks, or queues blindly across disconnected client sessions.

### 3. Iteration and Module State

Acceptance criteria, per-module budgets, and revision checkpoints are not ephemeral tool arguments—they constitute a persistent, disk-backed workflow:

* **Existing implementation:** `blender_iteration_state` derives per-module budgets from the workspace manifest and `critique.log`. `blender_module_revert` inspects history and refuses to revert if subsequent runs have touched the shared `model.blend` (preventing silent destruction of dependent work unless `force: true` is passed). These states are deliberately stored on disk, scoped per workspace and per module.
* **Under a standalone MCP server:** An MCP server would either have to hold iteration and budget state in-memory (making it volatile across server restarts and creating desynchronization bugs across multiple client processes) or continuously parse and synchronize disk state across JSON-RPC boundaries, gaining nothing over the current direct-filesystem architecture while adding latency and failure points.

### 4. Isolation and Parallelism

Authoring in `pi-blender` parallelizes across workers, but execution remains strictly isolated and budgeted:

* **Existing implementation:** `blender_module_run` and `blender_branch_run` execute authoring code against isolated `branch.blend` copies. Parallel runs are gated by `resolveRunBudget()`, which measures physical system resources—hardware core count, resident memory per headless Blender run (`RSS_PER_RUN_BYTES` $\approx 366\text{ MB}$), and free memory (`os.freemem()`)—to enforce safe concurrency limits.
* **Under a standalone MCP server:** A standalone daemon owns a single global budget. It cannot distinguish between multiple independent tasks, per-session worker fan-outs, and external client demands. The per-session, per-workspace budget resolution that protects developer workstations from out-of-memory lockups would be replaced by an uncoordinated global queue.

---

## What an MCP Rewrite Would Buy vs. What It Costs

### What It Would Buy

1. **Client Reach:** Ability to be invoked from IDEs or harnesses outside pi.
   * *Resolution:* Fully addressed by extracting a transport-agnostic core with an in-process MCP adapter (Issue #16), without rewriting `pi-blender` into an external server.
2. **Standard Protocol:** A standard JSON-RPC wire format.
   * *Resolution:* Standard protocols are valuable when interoperating across heterogeneous multi-vendor ecosystems. For Blender integration, the wire protocol is the simplest piece; the valuable intellectual property is the domain logic: geometric probes, topology checks, render budgets, visual critique logs, and reversible module operations.

### What It Would Cost

* **Loss of Type Safety:** Replacing strongly typed TypeScript / TypeBox schemas with loose JSON-RPC message payloads across an IPC boundary.
* **Process Boundary Overhead:** Splitting high-frequency status queries, probe evaluations, and image probes across socket hops.
* **Testing Friction:** Invalidating 35+ automated test suites (`test/*.test.mjs`, `test/blender-probes.test.mjs`), which currently run directly against Node and Blender CLI without requiring the harness and lifecycle overhead of an external daemon.

---

## Licensing and Security Considerations

### Provenance and Licensing

Both projects are **GPL-3.0-or-later**:

* `blender_mcp` is licensed under **GPL-3.0-or-later**.
* `pi-blender` is licensed under **GPL-3.0-or-later**.

So the licenses are compatible, and copyleft is no longer an obstacle: GPLv3 code may be combined with GPLv3 code. The reason not to vendor, link or derive from `blender_mcp` is provenance, not permission.

Keeping this codebase self-derived keeps every line in it attributable to this project's own authorship or to a clearly-identified, compatibly-licensed source (the MIT-licensed BlenderAgent extraction recorded in `README.md`, and the Blender reference material under `docs/reference/` whose terms are stated in `docs/reference/NOTICE`). That is what makes the license status of any given file answerable without a chain-of-custody audit, and it is an explicit project goal.

It also keeps the design independent. An MCP-server architecture carries assumptions -- process model, transport, tool granularity, state ownership -- that this project has deliberately rejected (see the Decision section). Inheriting an implementation would import those assumptions along with it.

### Security and Sandboxing Posture

The security philosophies of `blender_mcp` and `pi-blender` are diametrically opposed:

* `blender_mcp` operates under an explicit "no guards" stance. Its upstream documentation states:
  > *"The MCP server will execute LLM generated code in Blender without any guards in place to protect your data from removal or being sent to a remote location... To keep your data safe it is recommended to use a virtual machine."*
  Its `weak_sandbox.py` is documented as *"not really a sandbox, more guidance"*, blocking only `sys.exit` and four basic operators.
* `pi-blender`'s core value proposition is safety, measurement, and reversibility:
  - Non-destructive branch runs (`branch.blend`) before merging to `model.blend`.
  - Reversible runs with cross-module contamination auditing.
  - Read-only Python evaluation tools (`blender_read_only_python`).
  - Specialized geometric and image probes (`blender_geometry_probe`, `blender_image_probe`) that give models verified quantitative feedback without blind script execution.

Rebuilding `pi-blender` to fit the `blender_mcp` model would be a deliberate regression in safety, reproducibility, and architecture.

---

## Conclusion & Guidance for Future Proposals

Acceptance criteria, critique loops, and reversible module runs are not disposable tool wrappers—they are the workflow, and the workflow is the product.

Any future proposal to rewrite `pi-blender` as an external MCP server must directly argue against this ADR and provide concrete, working solutions for:
1. Cross-process bridge locking and crash stale-reclamation without introducing distributed locking services.
2. Reliable live vs. headless fallback that never misdiagnoses a busy UI.
3. Disk-based iteration and revert state guarantees without in-memory state drift.
4. Per-session dynamic concurrency budgeting based on measured system memory.
5. Preservation of GPL-3.0-or-later licensing, with clear attribution for any vendored or third-party code.
6. Preservation of reversible, guarded branch execution.
