---
schema_version: 1
name: "Workflow engine: external transition request API (E2)"
status: done
type: task
priority: P0
tags: [dual-workflow-engine,spur-consumer]
created_at: 2026-06-13T01:09:37.989Z
updated_at: 2026-06-13T04:34:11.847Z
---

## 0034. "Workflow engine: external transition request API (E2)"

### Background

Companion to E1. Today the engine drives transitions itself while executing a run. A lifecycle consumer needs the inverse: an external caller (a CLI command) asks the engine 'may this run move from its current state to state X?', the engine evaluates the transition's guards, and either commits the transition or returns a denial with the guard report — without the engine driving any loop. The caller performs its own side effects only when the transition is allowed.


### Requirements

- [x] **R1**: requestTransition(run, toState) evaluates whether a transition from the run's current state to toState exists and runs its guards. -> **MET** | Evidence: `WorkflowService.requestTransition()` and `evaluateAndCommit()`
- [x] **R2**: Allowed: the transition commits, normal transition events fire, the result reports the new state. -> **MET** | Evidence: commit path persists transition/state and emits `workflow.node.transition` plus `workflow.transition.requested`
- [x] **R3**: Denied (no such transition, or guard failed): nothing mutates; the result carries a machine-readable reason and the guard's findings/output. -> **MET** | Evidence: denied path returns `reason`, `detail`, `guardKind`, and `guardReport`; denial tests assert no mutation
- [x] **R4**: Guard kinds usable here include shell/CLI-invoking guards (a guard that shells out and gates on exit code) consistent with existing guard semantics. -> **MET** | Evidence: built-in `ShellGuardRunner` registered by `createDefaultWorkflowEngineHost()`
- [x] **R5**: Concurrency: two simultaneous requests on one run serialize; one wins, the other re-evaluates. Tested. -> **MET** | Evidence: per-run `runLocks` serialization and concurrent request tests


### Q&A



### Design

Capability E2, companion to E1. The engine currently drives transitions while executing a run; an
externally-driven lifecycle needs the inverse — the caller asks, the engine judges, nobody loops.

- `requestTransition(run, toState)`: evaluates that a transition from the run's current state to
  `toState` exists in the definition, runs that transition's guards, then either commits (normal
  transition events fire) or denies (nothing mutates).
- Denial result is machine-readable: reason category (no-such-transition | guard-failed) + the guard's
  findings/output verbatim — consumers render this to humans.
- Guard kinds include shell/CLI-invoking guards gating on exit code, consistent with existing guard
  semantics (no new guard concept).
- Concurrency: two simultaneous requests on one run serialize; the loser re-evaluates against the new
  state rather than failing blindly.


### Solution

1. Public API on the engine facade: `requestTransition(runHandle, toState)` → `{ allowed: true, state }`
   | `{ allowed: false, reason, guardReport }`.
2. Implementation reuses the existing transition executor + guard runner; adds a per-run serialization
   point (mutex/queue) shared with normal execution so external requests and engine-driven advancement
   never interleave.
3. Commit path emits the standard transition events (E4 relies on this being indistinguishable from
   engine-driven transitions).
4. Tests: allowed/denied both reason categories; guard report passthrough (shell guard fixture);
   concurrent request serialization (one wins, loser re-evaluates); no mutation on denial. Coverage ≥90%;
   semver minor.

### Plan

- [x] Add `TransitionRequestResult` (allowed/denied union type) and `TransitionDeniedReason` to `types.ts`
- [x] Add `'workflow.transition.requested'` and `'workflow.transition.denied'` events to `events.ts`
- [x] Implement per-run serialization mutex on `WorkflowService`
- [x] Implement `requestTransition` on `WorkflowService` — find transition, evaluate guards, commit or deny
- [x] Export new types from `index.ts`
- [x] Write tests: allowed path, denied (no-such-transition), denied (guard-failed), guard report passthrough, concurrent serialization
- [x] Verify with `bun run spur-check`


### Review

**Review — 2026-06-13**

**Status:** 4 findings fixed
**Scope:** `packages/dual-workflow-engine/src/*`, `packages/dual-workflow-engine/tests/*`
**Mode:** verify
**Channel:** current
**Gate:** `bun run spur-check` -> pass; `bun run build` -> pass

#### P1 — Blockers
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Guard denial lost guard output/report | Correctness | `packages/dual-workflow-engine/src/service.ts` | Preserve rich guard evaluation reports and include them in `TransitionDenied.guardReport` |
| 2 | No shell/CLI guard existed | Correctness | `packages/dual-workflow-engine/src/host.ts` | Add built-in `ShellGuardRunner` that gates on process exit code and returns stdout/stderr/exitCode |
| 3 | Allowed external transitions did not emit the normal transition event | Correctness | `packages/dual-workflow-engine/src/service.ts` | Emit existing `workflow.node.transition` on the allowed commit path |

#### P2 — Warnings
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 4 | DB current-state lookup had ambiguous same-millisecond ordering | Correctness | `packages/dual-workflow-engine/src/persistence.ts` | Add `rowid DESC` tie-breaker when reading the latest workflow state |

#### P3 — Info
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

#### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

**Fix-pass 2026-06-13:** 4 fixed, 0 failed, 0 skipped.

**Verdict:** PASS. All R1-R5 requirements implemented and verified after fix pass.

### Testing

- Command: `bun test packages/dual-workflow-engine/tests/transition-request.test.ts packages/dual-workflow-engine/tests/host.test.ts`
- Result: targeted tests pass 34/34; command exits nonzero only because isolated-file coverage is below the repository coverage gate
- Command: `bun run lint`
- Result: pass — Biome clean and per-package typecheck clean
- Command: `bun run spur-check`
- Result: pass — lint/typecheck, pre-check spur rules, 1412/1412 tests, post-check coverage gate
- Command: `bun run build`
- Result: pass — all packages built

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| test | packages/dual-workflow-engine/tests/transition-request.test.ts | Main | 2026-06-13 |

### References



### History

- Migrated from legacy format (2026-07-31)
