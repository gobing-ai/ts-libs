---
schema_version: 1
name: Validate host prerequisites and translate failures into the decision taxonomy
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.097Z
updated_at: "2026-09-21T18:10:04.050Z"
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
| R1 | MET | `validateHostPrerequisites` runs in the constructor before any spawn (`worker-client.ts:476`); tests `prerequisites-and-taxonomy.test.ts:24,36,47` refuse non-darwin/non-arm64 before spawning; :52 accepts darwin arm64 |
| R2 | MET | Missing interpreter → DecisionConfigError with install guidance `worker-client.ts:570-580` (names LAYA_PYTHON and brew install); missing runtime import → config error naming `pip install laya-mlx` (test :87); live evidence this run: `bun run parity` on an unprovisioned interpreter failed loud through the taxonomy naming the missing laya_mlx module |
| R3 | MET | All spawn/handshake failures translate to taxonomy classes before reaching callers (worker-client.ts translation block; parity probe printed a classified DecisionConnectionError/DecisionConfigError path, no raw spawn trace) |
| R4 | MET | Kind mapping proven by tests `prerequisites-and-taxonomy.test.ts:102` (config→DecisionConfigError), :108 (request→DecisionRequestError), :114 (backend→DecisionBackendError) |
| R5 | MET | Non-finite output → DecisionBackendError naming the precision remedy: tests :122, :135; worker side classifies FloatingPointError→backend `laya_worker.py:129-130` |
| R6 | MET | Auth failures → DecisionAuthError (test :143, HF_TOKEN resolution); transport failures → DecisionConnectionError (test :153); artifact-resolution failure path seen live in this run's parity probe (`worker-client.ts:166-167`) |
| R7 | MET | Startup timeout → DecisionTimeoutError (test :166); request timeout → DecisionTimeoutError (test :180) |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R7 — Local failures surface through the existing decision error taxonomy | MET | test | Fresh `bun test` (47 pass / 0 fail): `prerequisites-and-taxonomy.test.ts:102-180` maps config/request/backend/auth/transport/timeout onto the ai-runner decision error classes |
| R10 — Missing host prerequisites are reported before any decision is attempted | MET | command | Fresh `bun run parity` on unprovisioned python3: rejected through the taxonomy naming the missing `laya_mlx` module and install command; tests :58, :87; supported runtime range documented README.md:25 |
| R13 — Non-finite model output is reported instead of being returned as an answer | MET | test | `prerequisites-and-taxonomy.test.ts:122,135` — non-finite FloatingPointError maps to DecisionBackendError naming the precision problem; no non-finite probability returned |
| R14 — An unsupported platform is refused at construction rather than at inference | MET | test | `prerequisites-and-taxonomy.test.ts:24,36,47` — constructor refuses unsupported OS/arch before any spawn; hosted backend unaffected (no code path shared) |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | tests-pass | — | `bun test` packages/laya-mlx: 47 pass / 0 fail (this run) |
| P4 | design-conformance | — | Prerequisite validation at construction, taxonomy translation at the bridge seam — as designed |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T06:42:26.766Z todo → wip (system)
- 2026-09-21T06:43:20.097Z wip → testing (system)
- 2026-09-21T06:43:20.613Z testing → done (system)

