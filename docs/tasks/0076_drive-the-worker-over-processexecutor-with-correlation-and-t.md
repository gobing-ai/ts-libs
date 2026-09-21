---
schema_version: 1
name: Drive the worker over ProcessExecutor with correlation and timeouts
status: todo
template: feature-impl
created_at: 2026-09-21T03:11:42.096Z
updated_at: "2026-09-21T03:11:55.263Z"
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

- [ ] R1. The worker is started lazily on the first ask and reused for the driver's lifetime, so the weight load is paid once.
- [ ] R2. Process spawning goes through ts-runtime's ProcessExecutor; the package imports no node:child_process and calls no Bun.spawn directly.
- [ ] R3. The client waits for the handshake before issuing any request, bounded by startupTimeoutMs.
- [ ] R4. Responses are matched to requests by id, and a request exceeding requestTimeoutMs rejects without corrupting the stream.
- [ ] R5. Only the documented environment keys are forwarded to the child; the parent environment is not inherited wholesale.
- [ ] R6. A worker that exits is not silently restarted mid-ask: the in-flight call rejects and the next ask starts a fresh worker.

### Acceptance Criteria

- [ ] AC1 — Repeated decisions reuse one warm runtime instead of reloading the model (req: R1, R6)

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
