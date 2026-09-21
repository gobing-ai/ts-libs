---
schema_version: 1
name: Publish the worker script and fix the JSON-lines protocol
status: todo
template: feature-impl
created_at: 2026-09-21T03:11:42.094Z
updated_at: "2026-09-21T03:11:55.039Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - worker
  - protocol
estimate_hours: 4

dependencies: ["0074"]
---

## 0075. Publish the worker script and fix the JSON-lines protocol

### Background

ADR-027 executes the checkpoint by driving the vendored laya-mlx Python runtime as a long-lived worker. The worker is the contract every later task consumes, so its protocol has to be fixed before the TypeScript client is written. The runtime already exposes Agent.predict with the exact question map the neutral contract uses; the worker adds lifecycle and framing, not model logic.

### Requirements

- [ ] R1. packages/laya-mlx/worker/laya_worker.py constructs one Agent from options supplied on the command line or in the first line, and holds it for the process lifetime.
- [ ] R2. The worker emits a single handshake line on stdout before serving any request, reporting readiness, the resolved model, the revision, and the token budget.
- [ ] R3. Each request line carries an id, a state string, and a questions map; each response line carries the same id and either a success result or a structured error.
- [ ] R4. Errors are classified as config, request, or backend so the client can map them without parsing prose.
- [ ] R5. One request may carry more questions than the configured batch size, and the worker returns every answer keyed by its question name.
- [ ] R6. The worker contains no model logic: tokenization, batching, calibration, and answer construction all come from the installed runtime.

### Acceptance Criteria

- [ ] AC1 — A question set larger than the configured batch size is answered in chunks (req: R5)

The worker is exercised directly here by piping request lines to it on a provisioned host; the TypeScript client's view of the same protocol is covered by its own task.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** A small published Python script that wraps the installed `laya_mlx.Agent` in a read-line loop over stdin/stdout, speaking one JSON object per line.

**Why a worker and not the shipped CLI.** `laya-mlx predict` builds a fresh `Agent` per invocation, and `Agent.__init__` loads the full checkpoint into memory before answering anything. The published 7.4 ms P50 explicitly excludes model loading. A one-shot CLI call would therefore pay the entire weight load on every decision, which would make the local backend slower than the hosted one it is meant to replace. Holding one `Agent` open is the whole reason this design is viable.

**Why JSON lines.** The runtime's `predict` already returns a JSON-shaped dict, and the driver already needs a correlation mechanism for timeouts. Line-delimited JSON gives framing, correlation, and structured errors with no dependency and no parser. It also keeps the worker debuggable by hand: the protocol is something a maintainer can drive from a terminal.

**Why the error kind is an enum, not a message.** The client must translate failures into the decision error taxonomy. Matching on prose would break whenever the runtime rewords an exception. Three kinds — config, request, backend — are the smallest set that distinguishes a host problem from a caller problem from a model problem, which is exactly the distinction the taxonomy draws.

**Why the worker holds no model logic.** Every numeric path staying in the installed runtime is what lets this feature inherit the upstream validation result instead of re-earning it. A calibration or mapping step reimplemented here would be a second place for the model to drift.

### Plan

1. Write the option-parsing front half: model id or path, revision, dtype, batch size, cache directory.
2. Construct one Agent and emit the handshake line, reporting the resolved model, revision, and token budget.
3. Implement the read-line loop: parse a request, dispatch to Agent.predict, write the correlated response.
4. Classify raised exceptions into config, request, and backend kinds, including the runtime's non-finite-output error.
5. Handle a malformed or unparseable request line without killing the worker.
6. Flush after every response so the client never waits on a buffer.
7. Record the protocol in the package README beside the supported runtime version range.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History
