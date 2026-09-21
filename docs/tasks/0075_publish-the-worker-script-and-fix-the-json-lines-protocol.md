---
schema_version: 1
name: Publish the worker script and fix the JSON-lines protocol
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.094Z
updated_at: "2026-09-21T05:13:06.128Z"
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
| R1 | MET | `packages/laya-mlx/worker/laya_worker.py:93-116` (`build_agent` — one `Agent` from CLI flags via `parse_args` :33-52 or first-line `{"options":{...}}` via `merge_first_line_options` :55-81); `main` constructs once at :172-176 and reuses `agent` for the whole serve loop :193-199. Options plumbing exercised by tests: `--batch-size 2` (`tests/packages/laya-mlx/tests/worker-protocol.test.ts:174`) and `--dtype float8` (:189). |
| R2 | MET | Single handshake emitted before the read loop: `packages/laya-mlx/worker/laya_worker.py:178-185` (`{"ready": true, "model": str(agent.model_id), "revision": agent.revision, "maxLen": int(agent.cfg.get("max_len", 512))}` — readiness, resolved model, revision, token budget). Test asserts handshake is the first line with exact payload: `packages/laya-mlx/tests/worker-protocol.test.ts:96-103`. |
| R3 | MET | `handle_request` :132-156 validates `id`/`state`/`questions` and echoes the same `request_id` in success `{"id", ok:true, result}` (:156) and failure `{"id", ok:false, error}` (:155). Id-correlation test: `packages/laya-mlx/tests/worker-protocol.test.ts:105-129` (ids `a`, `b`). |
| R4 | MET | Three-kind taxonomy without prose parsing: `classify()` `packages/laya-mlx/worker/laya_worker.py:123-129` (FloatingPointError→backend, ValueError→request, else backend) + construction failures→`config` via `startup_failure` :89-90/:172-176. Tests assert all three kinds: `packages/laya-mlx/tests/worker-protocol.test.ts:136-140` (request, malformed), :142-149 (request, bad question), :151-159 (backend, "Non-finite"), :188-195 (config startup, exit 1). |
| R5 | MET | Worker forwards the full questions map to `agent.predict` (:153) — no worker-side truncation; chunking is inside the runtime `Agent.predict` (stub contract `tests/fixtures/packages/laya-mlx/tests/fixtures/stub_laya.py:39-60`). Oversized-batch test: `packages/laya-mlx/tests/worker-protocol.test.ts:173-186` — 5 questions vs `--batch-size 2`, all `q0..q4` keyed, `usage.chunks === 3`. |
| R6 | MET | Worker source contains only argparse/json/os/sys lifecycle+framing plumbing (`laya_worker.py` imports :24-27); no tokenization, batching, calibration, or answer-construction code — those live in `Agent.predict` (fixture docstring `packages/laya-mlx/tests/fixtures/stub_laya.py:1-5` mirrors the runtime contract). Protocol documented as runtime-owned in `worker/README.md` ("The worker contains no model logic"). |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 | MET | test | `bun test` gate run (recorded in `.spur/run/0075-test-gate.log`, proof-digest `sha256:a1963bea…`): **2335 pass / 0 fail** across 203 files, including `tests/packages/laya-mlx/tests/worker-protocol.test.ts:173-186`, which spawns the real worker via `python3` + `--module tests.fixtures.stub_laya` over `ProcessExecutor.runStreaming` (:74-82) and asserts 5 questions vs `--batch-size 2` → all answers keyed `q0..q4` with `usage.chunks === 3`, worker alive and exit 0. |
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

- 2026-09-21T04:50:56.758Z todo → wip (system)
- 2026-09-21T05:13:05.617Z wip → testing (system)
- 2026-09-21T05:13:06.128Z testing → done (system)

