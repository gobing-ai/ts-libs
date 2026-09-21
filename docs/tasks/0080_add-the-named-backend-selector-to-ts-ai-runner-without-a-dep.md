---
schema_version: 1
name: Add the named backend selector to ts-ai-runner without a dependency edge
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.100Z
updated_at: "2026-09-21T06:54:57.968Z"
feature_id: J
priority: P1
tags:
  - ai-runner
  - selector
  - boundaries
estimate_hours: 4

dependencies: ["0078"]
---

## 0080. Add the named backend selector to ts-ai-runner without a dependency edge

### Background

I6 asks that downstream users shift between the hosted and local backends easily. createDecisionMaker({ driver }) already switches backends today, so what is missing is only a named ergonomic. ADR-028 constrains how: ts-ai-runner may name a backend but must never depend on a driver package, because the driver already depends on ts-ai-runner for the neutral types.

### Requirements

- [x] R1. DecisionMakerOptions accepts an optional backend name alongside the existing driver option, with resolution order driver, then backend, then the hosted default.
- [x] R2. Selecting the hosted backend by name resolves the existing driver with no change in behaviour.
- [x] R3. The local backend is resolved by dynamic import when a decision is first asked, not by a static import.
- [x] R4. The ts-ai-runner manifest declares no dependency on @gobing-ai/ts-laya-mlx, and no file under packages/ai-runner/src/ imports it at module scope.
- [x] R5. Selecting the local backend without the package installed rejects with a configuration error naming the package.
- [x] R6. An application that asks decisions through createDecisionMaker compiles and runs unchanged when its configuration selects the local backend.
- [x] R7. A spur rule under .spur/rules/typescript/ makes the no-dependency invariant mechanically checkable, and also confines direct process spawning in packages/laya-mlx to ts-runtime's ProcessExecutor.

### Acceptance Criteria

- [x] AC1 — ts-ai-runner names the local backend without depending on its package (req: R3, R4, R5, R7)
- [x] AC2 — An application swaps to the local backend without editing a call site (req: R1, R2, R6)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

### Design

**What.** An additive backend name on the existing options type, resolved by dynamic import, plus the boundary rule that keeps the dependency direction honest.

**Why a name and not a constructor.** The caller already can pass a driver; what they cannot do is select a backend from configuration — a environment-driven string — without hand-wiring an import. The name closes that gap and nothing else, which is why it is sugar over the existing primitive rather than a replacement for it.

**Why driver wins over backend.** Someone passing a concrete driver has the most specific intent available, including a test double. Letting a stray backend name override it would make the injection point unreliable for exactly the case it was built for.

**Why dynamic import.** A driver package must import the neutral contract from ts-ai-runner. If ts-ai-runner imported the driver package back, the workspace graph would close a cycle — the build would either break or start depending on resolution order. Deferring the import to first use keeps the edge one-way at module scope, which is the form the rule can check.

**Why a rule and not a review note.** ADR-006 makes architectural invariants rules rather than habits. This one is easy to violate innocently — adding the package to dependencies to make an editor's import suggestion work would close the cycle without any obvious symptom until a later build. Encoding it means the gate catches it on the commit that introduces it. The same rule file carries the ProcessExecutor constraint, since both are import-shape invariants of the new package.

**Why the union stays open.** A third backend is then an additive change here and a new driver package elsewhere, with no edit to the neutral types.

### Plan

1. Add the DecisionBackend union and the optional backend field to DecisionMakerOptions.
2. Implement the resolution order in the existing factory, leaving the driver path untouched.
3. Resolve the local backend by dynamic import at first ask, caching the resolved driver.
4. Reject a missing installation with a configuration error naming the package and the install command.
5. Confirm no static import and no manifest entry references the driver package.
6. Write the spur rule covering the no-dependency invariant and the ProcessExecutor constraint.
7. Cover both names, the precedence order, and the missing-package rejection.

### Solution

Each entry cites the first changed line per file (`file:line`).

| Change (`file:line`) |
| --------------------- |
| `packages/ai-runner/src/decision/decision-maker.ts:105` |
| `packages/ai-runner/src/decision/decision-maker.ts:109` |
| `packages/ai-runner/src/decision/decision-maker.ts:112` |
| `packages/ai-runner/src/decision/decision-maker.ts:139` |
| `packages/ai-runner/src/decision/decision-maker.ts:148` |
| `packages/ai-runner/src/decision/decision-maker.ts:45` |
| `packages/ai-runner/src/decision/decision-maker.ts:50` |
| `packages/ai-runner/src/decision/decision-maker.ts:52` |
| `packages/ai-runner/src/decision/decision-maker.ts:65` |
| `packages/ai-runner/src/decision/decision-maker.ts:84` |
| `packages/ai-runner/tests/decision/backend-selection.test.ts:1` |
| `packages/laya-mlx/src/driver.ts:1` |
| `packages/laya-mlx/src/index.ts:1` |
| `packages/laya-mlx/src/worker-client.ts:1` |
| `packages/laya-mlx/tests/artifact-resolution.test.ts:1` |
| `packages/laya-mlx/tests/driver.test.ts:1` |
| `packages/laya-mlx/tests/index.test.ts:1` |
| `packages/laya-mlx/tests/prerequisites-and-taxonomy.test.ts:1` |
| `packages/laya-mlx/tests/worker-client.test.ts:1` |
| `packages/laya-mlx/tests/worker-protocol.test.ts:1` |

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/ai-runner/src/decision/decision-maker.ts:46-64,116-133` (`DecisionMakerOptions` accepts `backend?: DecisionBackend` with resolution order `driver` → `backend` → `'typesafe'`); proven by `packages/ai-runner/tests/decision/backend-selection.test.ts:18-65`. |
| R2 | MET | `packages/ai-runner/src/decision/decision-maker.ts:118-129` (selecting `backend: 'typesafe'` uses `createTypesafeDriver` identical to the default); proven by `packages/ai-runner/tests/decision/backend-selection.test.ts:28-65`. |
| R3 | MET | `packages/ai-runner/src/decision/decision-maker.ts:85-103,130-133` (`'laya-local'` resolved by dynamic import `await import(LAYA_DRIVER_PACKAGE)` on first ask); proven by `packages/ai-runner/tests/decision/backend-selection.test.ts:68-84`. |
| R4 | MET | `packages/ai-runner/package.json:52-57` (no dependency on `@gobing-ai/ts-laya-mlx`; enforced mechanically by `no-laya-driver-import-in-ai-runner` rule in `.spur/rules/typescript/decision-boundaries.yaml:27-37`). |
| R5 | MET | `packages/ai-runner/src/decision/decision-maker.ts:94-102` (missing package rejection raises `DecisionConfigError` naming `@gobing-ai/ts-laya-mlx`); proven by `packages/ai-runner/tests/decision/backend-selection.test.ts:86-93`. |
| R6 | MET | `packages/ai-runner/tests/decision/backend-selection.test.ts:68-84` (`createDecisionMaker({ backend: 'laya-local' })` executes `.choice(...)` seamlessly with identical call-site ergonomics). |
| R7 | MET | `.spur/rules/typescript/decision-boundaries.yaml:27-52` (spur rules `no-laya-driver-import-in-ai-runner` and `laya-mlx-process-executor-only` validated and passing in gate `.spur/run/0080-test-gate.log`). |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 | MET | test | `bun test` gate run (recorded in `.spur/run/0080-test-gate.log`, proof-digest `sha256:ffb7ed28…`): `packages/ai-runner/tests/decision/backend-selection.test.ts:68-93` and spur rule `no-laya-driver-import-in-ai-runner` prove `ts-ai-runner` names `'laya-local'` via dynamic import without any static import or dependency edge. |
| AC2 | MET | test | `bun test` gate run (recorded in `.spur/run/0080-test-gate.log`, proof-digest `sha256:ffb7ed28…`): `packages/ai-runner/tests/decision/backend-selection.test.ts:18-84` verifies that an application configures `backend: 'laya-local'` or `'typesafe'` and calls `.choice(...)` with no call-site changes. |
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

- 2026-09-21T06:51:09.955Z todo → wip (system)
- 2026-09-21T06:54:57.414Z wip → testing (system)
- 2026-09-21T06:54:57.968Z testing → done (system)

