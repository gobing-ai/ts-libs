---
schema_version: 1
name: Add the named backend selector to ts-ai-runner without a dependency edge
status: done
template: feature-impl
created_at: 2026-09-21T03:11:42.100Z
updated_at: "2026-09-21T18:10:04.990Z"
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
| R1 | MET | `packages/ai-runner/src/decision/decision-maker.ts:52-53` optional `backend` alongside `driver`; resolution order driver → backend → 'typesafe' at :105-125; tests `backend-selection.test.ts:13,23,47` |
| R2 | MET | `backend === 'typesafe'` resolves the existing driver unchanged :114; test :23 (respects apiKey requirement, same behavior) |
| R3 | MET | Local backend resolved by `await import(LAYA_DRIVER_PACKAGE)` at `decision-maker.ts:84,88` on first ask, not at module scope; test :72 |
| R4 | MET | Fresh audit this run: `jq .dependencies packages/ai-runner/package.json` → only ts-infra/ts-runtime/@typesafe-ai/sdk, no ts-laya-mlx; `rg ts-laya-mlx packages/ai-runner/src/` → sole hit is the dynamic-import string constant :84; rule `no-laya-driver-import-in-ai-runner` `.spur/rules/typescript/decision-boundaries.yaml:40-51` |
| R5 | MET | Missing package → DecisionConfigError naming `@gobing-ai/ts-laya-mlx` and the install command :97; test :85 |
| R6 | MET | Caller-side swap compiles/runs unchanged: `driver.test.ts:22` (laya driver substitutable in createDecisionMaker), `backend-selection.test.ts:72` (laya-local answers cleanly); ai-runner decision suite fresh: 47 pass / 0 fail |
| R7 | MET | `.spur/rules/typescript/decision-boundaries.yaml:40-63` — `no-laya-driver-import-in-ai-runner` (no dep/static import) + `laya-mlx-process-executor-only` (ProcessExecutor confinement in packages/laya-mlx/src) |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R6 — ts-ai-runner names the local backend without depending on its package | MET | test | Fresh `bun test tests/decision/` (47 pass / 0 fail): backend-selection.test.ts:72 (dynamic import on first ask), :85 (DecisionConfigError when absent); manifest audit: no ts-laya-mlx dependency; typesafe resolution unchanged :23 |
| R5 — An application swaps to the local backend without editing a call site | MET | test | backend-selection.test.ts:13,47,72 — driver/backend/default resolution order, existing ask/choice/score/noul calls unchanged, neutral answer shapes preserved |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

<!-- spur:record-review -->

**SECU findings** (pipeline verify step — verdict: PASS)

| Priority | Dimension | Location | Finding |
|----------|-----------|----------|----------|
| P4 | spur task check | — | task check passed |
| P4 | tests-pass | — | `bun test tests/decision/` packages/ai-runner: 47 pass / 0 fail (6 files, this run) |
| P4 | design-conformance | — | Named selector over the existing driver seam, one-way dependency, as designed (ADR-028) |
| P4 | evidence-rule-pass | — | All behavior-bearing AC rows have executable evidence or are explicitly non-behavioral. |

### References

<!-- Links to the parent feature, design docs, related tasks, or external references. -->

### History

- 2026-09-21T06:51:09.955Z todo → wip (system)
- 2026-09-21T06:54:57.414Z wip → testing (system)
- 2026-09-21T06:54:57.968Z testing → done (system)

