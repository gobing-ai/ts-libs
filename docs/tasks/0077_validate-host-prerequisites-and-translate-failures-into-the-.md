---
schema_version: 1
name: Validate host prerequisites and translate failures into the decision taxonomy
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.097Z
updated_at: "2026-09-21T06:43:20.613Z"
feature_id: J
priority: P1
tags:
  - laya-mlx
  - errors
  - prerequisites
estimate_hours: 5

dependencies: ["0076"]
---

## 0077. Validate host prerequisites and translate failures into the decision taxonomy

### Background

This package is platform-locked and depends on a host-side runtime it does not install. Those constraints become support burden unless they are reported precisely. ai-runner already owns a seven-class decision error taxonomy shipped with the TypeSafe driver; the local driver reuses it rather than inventing local error types.

### Requirements

- [x] R1. An unsupported platform is refused with a configuration error naming the platform requirement, before any process is spawned.
- [x] R2. A missing interpreter, or a present interpreter that cannot import the runtime, is reported as a configuration error naming the missing piece and the command that installs it.
- [x] R3. No raw process-spawn message reaches the caller.
- [x] R4. Worker error kinds map to the taxonomy: config to DecisionConfigError, request to DecisionRequestError, backend to DecisionBackendError.
- [x] R5. Non-finite model output is reported as a decision error naming the precision problem, and no answer containing a non-finite probability is returned.
- [x] R6. Credential and transport failures during artifact resolution surface as DecisionAuthError and DecisionConnectionError respectively.
- [x] R7. Both timeout paths surface as DecisionTimeoutError.

### Acceptance Criteria

- [x] AC1 — Local failures surface through the existing decision error taxonomy (req: R4, R6, R7)
- [x] AC2 — Missing host prerequisites are reported before any decision is attempted (req: R2, R3)
- [x] AC3 — An unsupported platform is refused at construction rather than at inference (req: R1)
- [x] AC4 — Non-finite model output is reported instead of being returned as an answer (req: R5)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** The construction-time prerequisite checks and the single translation point from worker failures to the decision error taxonomy.

**Why check the platform before spawning.** An unsupported host produces a confusing failure if it is discovered by a process that fails to start — the message describes a missing binary rather than the real constraint. Checking first turns a support question into a sentence the caller can act on.

**Why the install command is part of the message.** The one prerequisite this package cannot satisfy for the user is the host runtime. A configuration error that names the missing distribution without saying how to get it converts directly into a support request; naming the command is the cheapest possible documentation, delivered at the moment it is needed.

**Why reuse the existing taxonomy.** The whole premise of feature J is that a caller can swap backends without editing a call site. Code that catches DecisionAuthError around a hosted call must keep working when the local backend is selected. Introducing local error classes would break exactly the substitutability the feature exists to prove.

**Why one translation point.** Scattering error construction across the lifecycle, protocol, and mapping layers would make the taxonomy a convention rather than a guarantee. A single translator keeps every failure path auditable and gives the tests one surface to enumerate against.

**On the non-finite path.** The runtime raises on non-finite outputs rather than returning them, and it names the precision remedy. That message is worth preserving through the translation rather than flattening, because the actionable part is the dtype, not the fact of failure.

### Plan

1. Write the platform check and the interpreter resolution order: explicit option, environment key, then the default on PATH.
2. Build the configuration errors for each prerequisite, each naming the requirement and the command that satisfies it.
3. Detect a failed import of the runtime from the worker's startup behaviour and report it as configuration, not backend.
4. Write the translator from worker error kinds to the taxonomy classes.
5. Map the two timeout paths and the worker-exit path onto their classes.
6. Map artifact credential and transport failures onto DecisionAuthError and DecisionConnectionError.
7. Enumerate every branch in tests against a stub process, asserting class and message content.

### Solution

Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
| --------------------- |
| `packages/laya-mlx/src/index.ts:1` |
| `packages/laya-mlx/src/worker-client.ts:1` |
| `packages/laya-mlx/tests/index.test.ts:1` |
| `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:1` |
| `packages/laya-mlx/tests/worker-client.test.ts:1` |
| `packages/laya-mlx/tests/worker-protocol.test.ts:1` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/laya-mlx/src/worker-client.ts:98-107,411` (`validateHostPrerequisites` called in `LayaWorkerClient` constructor, refusing non-darwin or non-arm64 before process spawn); proven by `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:22-52`. |
| R2 | MET | `packages/laya-mlx/src/worker-client.ts:145-151,514-521` (missing python reports `DecisionConfigError` with `brew install python@3.11`, unimportable runtime reports `pip install laya-mlx`); proven by `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:55-94`. |
| R3 | MET | `packages/laya-mlx/src/worker-client.ts:514-521` (raw spawn errors from `runStreaming` caught and wrapped in `DecisionConfigError`); proven by `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:55-70`. |
| R4 | MET | `packages/laya-mlx/src/worker-client.ts:159-167` (`translateWorkerError` maps `config` to `DecisionConfigError`, `request` to `DecisionRequestError`, `backend` to `DecisionBackendError`); proven by `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:97-115`. |
| R5 | MET | `packages/laya-mlx/src/worker-client.ts:152-158,350-359` (non-finite error messages and answers with non-finite values reject with `DecisionBackendError` naming `float32`); proven by `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:117-133`. |
| R6 | MET | `packages/laya-mlx/src/worker-client.ts:125-144` (`translateWorkerError` maps auth/credential patterns to `DecisionAuthError` and connection/transport failures to `DecisionConnectionError`); proven by `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:136-156`. |
| R7 | MET | `packages/laya-mlx/src/worker-client.ts:192-200,248-257` (`startupTimeoutMs` and `requestTimeoutMs` rejections throw `DecisionTimeoutError`); proven by `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:159-183`. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 | MET | test | `bun test` gate run (recorded in `.spur/run/0077-test-gate.log`, proof-digest `sha256:057edde4…`): `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:97-115,136-183` passes 7 tests verifying error kinds map onto the decision taxonomy (`DecisionConfigError`, `DecisionRequestError`, `DecisionBackendError`, `DecisionAuthError`, `DecisionConnectionError`, `DecisionTimeoutError`). |
| AC2 | MET | test | `bun test` gate run (recorded in `.spur/run/0077-test-gate.log`, proof-digest `sha256:057edde4…`): `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:55-94` passes 3 tests proving missing python and missing runtime are reported as `DecisionConfigError` with install guidance before any decision runs. |
| AC3 | MET | test | `bun test` gate run (recorded in `.spur/run/0077-test-gate.log`, proof-digest `sha256:057edde4…`): `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:22-52` passes 4 tests proving non-darwin and non-arm64 platforms are refused at constructor time before process spawning. |
| AC4 | MET | test | `bun test` gate run (recorded in `.spur/run/0077-test-gate.log`, proof-digest `sha256:057edde4…`): `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:117-133` passes 2 tests proving non-finite outputs reject with `DecisionBackendError` naming the precision remedy. |
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

- 2026-09-21T06:42:26.766Z todo → wip (system)
- 2026-09-21T06:43:20.097Z wip → testing (system)
- 2026-09-21T06:43:20.613Z testing → done (system)

