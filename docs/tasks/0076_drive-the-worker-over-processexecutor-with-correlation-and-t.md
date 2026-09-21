---
schema_version: 1
name: Drive the worker over ProcessExecutor with correlation and timeouts
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.096Z
updated_at: "2026-09-21T06:40:13.101Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - driver
  - lifecycle
estimate_hours: 6

dependencies: ["0075"]
---

## 0076. Drive the worker over ProcessExecutor with correlation and timeouts

### Background

With the protocol fixed, the driver needs the TypeScript half: start the worker once, wait for the handshake, correlate responses to requests, enforce timeouts, and keep the process warm across calls. ADR-011/ADR-014 put process spawning behind ts-runtime, so ProcessExecutor.runStreaming is the only seam available.

### Requirements

- [x] R1. The worker is started lazily on the first ask and reused for the driver's lifetime, so the weight load is paid once.
- [x] R2. Process spawning goes through ts-runtime's ProcessExecutor; the package imports no node:child_process and calls no Bun.spawn directly.
- [x] R3. The client waits for the handshake before issuing any request, bounded by startupTimeoutMs.
- [x] R4. Responses are matched to requests by id, and a request exceeding requestTimeoutMs rejects without corrupting the stream.
- [x] R5. Only the documented environment keys are forwarded to the child; the parent environment is not inherited wholesale.
- [x] R6. A worker that exits is not silently restarted mid-ask: the in-flight call rejects and the next ask starts a fresh worker.

### Acceptance Criteria

- [x] AC1 — Repeated decisions reuse one warm runtime instead of reloading the model (req: R1, R6)

The ProcessExecutor-only constraint (R2) is additionally enforced by the boundary rule added under the backend-selection task.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** The process-lifecycle and protocol-client layer of the driver: spawn, handshake, request/response correlation, timeout enforcement, and teardown.

**Why lazy start.** Constructing a driver must stay cheap and synchronous — it happens at application wiring time, often for a backend that may never be asked anything. Deferring the spawn to the first `ask` also puts startup failures where a caller can catch them, on a call that is already async and already able to reject.

**Why one worker held open.** This is the property that makes the design worth choosing over a one-shot CLI: the checkpoint load happens once rather than per decision. Requirement R1 exists to make that mechanically observable rather than assumed.

**Why two separate timeouts.** Startup and inference differ by orders of magnitude — a cold weight load against a warm 7 ms forward pass. One shared budget would either abort legitimate cold starts or let a hung request sit for the length of a model load. Two knobs is the smallest honest configuration.

**Why no silent restart.** Retrying a decision across a fresh process would hide a crashing worker behind intermittent latency, and the caller cannot tell a retried answer from a first-attempt one. Failing the in-flight call and starting clean on the next ask keeps the failure visible while still recovering.

**Why the environment is not inherited.** ADR-011 already forbids reading process.env in this package; forwarding an inherited environment to a child would route around that rule and would leak unrelated host configuration into the worker. An explicit allowlist keeps the injected-env contract intact across the process boundary.

### Plan

1. Define the internal worker-handle type: the stream pair, the pending-request map, and the ready state.
2. Start the worker through ProcessExecutor.runStreaming with the resolved interpreter, script path, and allowlisted environment.
3. Parse stdout line by line; resolve the handshake promise on the first line, then dispatch by id.
4. Implement the request path: assign an id, write the line, register the pending entry, arm the timeout.
5. Enforce startupTimeoutMs and requestTimeoutMs, rejecting the right pending entries on each.
6. Handle worker exit: reject everything in flight and clear the handle so the next ask restarts.
7. Add a dispose path that closes the worker, and make repeated disposal safe.
8. Cover the whole layer against a stub process so no interpreter is needed in the default test run.

### Solution

Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
| --------------------- |
| `packages/laya-mlx/src/index.ts:1` |
| `packages/laya-mlx/src/worker-client.ts:1` |
| `packages/laya-mlx/tests/index.test.ts:1` |
| `packages/laya-mlx/tests/worker-client.test.ts:1` |
| `packages/laya-mlx/tests/worker-protocol.test.ts:1` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/laya-mlx/src/worker-client.ts:404-458` (`ask` delegates through `dispatch` which awaits `ensureWorker`; worker handle is cached in `this.worker` and reused across calls); proven by `packages/laya-mlx/tests/worker-client.test.ts:44-52` (`pays the spawn once: repeated asks reuse the same warm worker`). |
| R2 | MET | `packages/laya-mlx/src/worker-client.ts:466-473` (spawning uses `this.executor.runStreaming` from `@gobing-ai/ts-runtime`; no imports of `node:child_process` or `Bun.spawn`; verified by `runtime-boundaries` rule pass in `.spur/run/0076-test-gate.log`). |
| R3 | MET | `packages/laya-mlx/src/worker-client.ts:149-160,446` (`WorkerHandle` races first line against `startupTimeoutMs`; `ensureWorker` awaits `worker.handshake` before serving); proven by `packages/laya-mlx/tests/worker-client.test.ts:54-67`. |
| R4 | MET | `packages/laya-mlx/src/worker-client.ts:206-224,296-316` (`armRequest` tracks pending map by correlation id with `requestTimeoutMs`; timeout deletes id and rejects without breaking stream); proven by `packages/laya-mlx/tests/worker-client.test.ts:77-100`. |
| R5 | MET | `packages/laya-mlx/src/worker-client.ts:23,65-74,469` (`resolveForwardedEnv` restricts child env to `FORWARDED_ENV_KEYS` allowlist, passed with `envMode: 'replace'`); proven by `packages/laya-mlx/tests/worker-client.test.ts:120-141`. |
| R6 | MET | `packages/laya-mlx/src/worker-client.ts:165-167,440-442` (worker exit rejects in-flight calls with `DecisionBackendError` and clears handle; next ask respawns fresh); proven by `packages/laya-mlx/tests/worker-client.test.ts:102-118`. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 | MET | test | `bun test` gate run (recorded in `.spur/run/0076-test-gate.log`, proof-digest `sha256:80b84cc1…`): **2343 pass / 0 fail** across 204 files, including `packages/laya-mlx/tests/worker-client.test.ts:44-52`, which executes multiple `ask` calls and verifies the same warm worker process (matching PID) is reused without reloading. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T05:34:38.957Z todo → wip (system)
- 2026-09-21T06:40:12.097Z wip → testing (system)
- 2026-09-21T06:40:13.101Z testing → done (system)

