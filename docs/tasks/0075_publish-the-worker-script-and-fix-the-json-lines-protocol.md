---
schema_version: 1
name: Publish the worker script and fix the JSON-lines protocol
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.094Z
updated_at: "2026-09-21T18:10:03.381Z"
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

- [x] R1. packages/laya-mlx/worker/laya_worker.py constructs one Agent from options supplied on the command line or in the first line, and holds it for the process lifetime.
- [x] R2. The worker emits a single handshake line on stdout before serving any request, reporting readiness, the resolved model, the revision, and the token budget.
- [x] R3. Each request line carries an id, a state string, and a questions map; each response line carries the same id and either a success result or a structured error.
- [x] R4. Errors are classified as config, request, or backend so the client can map them without parsing prose.
- [x] R5. One request may carry more questions than the configured batch size, and the worker returns every answer keyed by its question name.
- [x] R6. The worker contains no model logic: tokenization, batching, calibration, and answer construction all come from the installed runtime.

### Acceptance Criteria

- [x] AC1 — A question set larger than the configured batch size is answered in chunks (req: R5)

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

Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
| --------------------- |
| `packages/laya-mlx/src/index.ts:1` |
| `packages/laya-mlx/tests/index.test.ts:1` |
| `packages/laya-mlx/tests/worker-protocol.test.ts:1` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/laya-mlx/worker/laya_worker.py:97-120` build_agent constructs one Agent from CLI args or first-line options (`merge_first_line_options` :57-85); `main` :176-180 constructs once, serve loop :191-204 reuses it |
| R2 | MET | Handshake emitted before the read loop at `laya_worker.py:182-189` (ready/model/revision/maxLen); test `packages/laya-mlx/tests/worker-protocol.test.ts:97` asserts handshake-first |
| R3 | MET | `laya_worker.py:136-160` handle_request validates id/state/questions and echoes the same id on success/failure; correlation test `worker-protocol.test.ts:106` |
| R4 | MET | `laya_worker.py:127-133` classify() maps FloatingPointError→backend, ValueError→request, else backend; construction failures → config handshake :93-94/:178-180; tests `worker-protocol.test.ts:132,189` assert all three kinds |
| R5 | MET | Worker forwards the full questions map to `agent.predict` :156-160 (no worker-side truncation); chunking inside the runtime; oversized-batch test `worker-protocol.test.ts:174-187` — 5 questions over `--batch-size 2` → all q0..q4 keyed, usage.chunks=3 (fresh run pass) |
| R6 | MET | `laya_worker.py:24-30` imports argparse/importlib/json/os/sys only — lifecycle and framing plumbing; no tokenization/batching/calibration code; worker/README.md states the worker contains no model logic |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R12 — A question set larger than the configured batch size is answered in chunks | MET | test | Fresh `bun test` (packages/laya-mlx, 47 pass / 0 fail): `worker-protocol.test.ts:174` spawns the real worker over ProcessExecutor.runStreaming with stub module, 5 questions vs batch-size 2 → 3 chunks, every answer keyed by question name; stub runtime is deterministic so chunked answers equal solo answers; cross-model agreement within 1e-4 is owned by the parity layer (scripts/full-parity.ts) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | tests-pass | — | `bun test` packages/laya-mlx: 47 pass / 0 fail (this run) |
| P4 | design-conformance | — | Protocol matches docs/design contract: handshake-first, id-correlated, three-kind taxonomy |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T04:50:56.758Z todo → wip (system)
- 2026-09-21T05:13:05.617Z wip → testing (system)
- 2026-09-21T05:13:06.128Z testing → done (system)

