---
schema_version: 1
name: "Workflow engine: durable named runs — create-or-attach by external key (E1)"
status: done
type: task
priority: P0
tags: [dual-workflow-engine,spur-consumer]
created_at: 2026-06-13T01:09:37.988Z
updated_at: 2026-06-13T04:09:45.336Z
---

## 0033. "Workflow engine: durable named runs — create-or-attach by external key (E1)"

### Background

The dual-workflow engine gains its first long-lived, externally-triggered consumer: a planning-layer lifecycle where one state-machine run represents one markdown task/feature over days or weeks, driven by separate short-lived CLI invocations (not one resident process). The engine must support runs that are addressable by a stable external key and whose state survives process exits. This is upstream capability E1 of a four-item set (E1 durable named runs, E2 external transition request, E3 pause/resume, E4 stable event seam).


### Requirements

- [x] **R1**: A run can be created with (or attached to by) a caller-supplied external key (e.g. 'task:0042'); create-or-attach is one API call. -> **MET** | Evidence: `packages/dual-workflow-engine/src/persistence.ts` `createOrAttachRun()`, `packages/dual-workflow-engine/src/run-lifecycle.ts` keyed run path, `packages/dual-workflow-engine/tests/run-lifecycle.test.ts`
- [x] **R2**: Run state (current state, vars, history) persists via the engine's existing persistence layer and is fully usable after process restart. -> **MET** | Evidence: `packages/dual-workflow-engine/src/schema-sql.ts`, `packages/dual-workflow-engine/tests/durable-runs.test.ts` restart survival coverage
- [x] **R3**: Lookup by external key returns the run or a clear not-found result; keys are unique per workflow definition. -> **MET** | Evidence: `findRunByKey()`, unique `(workflow_name, external_key)` index, memory/DB lookup tests
- [x] **R4**: Re-seeding: a caller can force-set the current state of an attached run (consumer-side authority reconciliation), emitting a distinguishable corrective event rather than a normal transition. -> **MET** | Evidence: `WorkflowService.reseedRun()` validates declared states and emits `workflow.run.reseeded`; adapters record `__reseed__`
- [x] **R5**: Tests cover create-or-attach, restart survival, lookup, and re-seed; per-file coverage >= 90%. -> **MET** | Evidence: `bun run spur-check` passed with 1397/1397 tests and coverage gate pass


### Q&A



### Design

Capability E1 of the four-item externally-driven-lifecycle set (E1 durable named runs, E2 external
transition request, E3 pause/resume, E4 stable event seam). Design constraints:

- External key is caller-supplied, opaque to the engine, unique per workflow definition; create-or-attach
  is one API call (no get-then-create race).
- Run state (current state, vars, history) persists through the engine's existing persistence layer —
  no second store; survives process exit/restart fully usable.
- Re-seed (force-set current state) is a first-class API for consumer-side authority reconciliation; it
  emits a **corrective** event type distinguishable from a normal transition (subscribers must be able to
  tell "the consumer overrode state" from "the machine transitioned").
- Fits the state-machine mode; transition-flow mode out of scope for E1.


### Solution

1. Persistence: add the external key to the run record (column + unique index per workflow definition)
   in the engine's existing run tables/migrations.
2. API: `createOrAttachRun({ workflow, key, initialVars? })` → run handle (existing run attached as-is);
   `findRunByKey({ workflow, key })` → run | not-found result.
3. `reseedRun(run, state)` → validates the state exists in the definition, force-sets, emits the
   corrective event, appends to run history with a reseed marker.
4. Tests: create-or-attach idempotency under concurrent calls; restart survival (new process, attach,
   state intact); key uniqueness enforcement; reseed event distinguishability. Coverage ≥90% per file;
   ship as a semver minor of the engine package.


### Plan

- [x] Add `external_key` column + unique index to `runs` table in `schema-sql.ts`
- [x] Extend `WorkflowRunRecord` with optional `external_key` field
- [x] Add `findRunByKey`, `createOrAttachRun`, `reseedRun` to `WorkflowPersistenceAdapter` interface
- [x] Implement methods in `DbWorkflowPersistenceAdapter` and `MemoryWorkflowPersistenceAdapter`
- [x] Add `workflow.run.reseeded` corrective event to `events.ts`
- [x] Wire `createOrAttachRun`, `findRunByKey`, `reseedRun` into `WorkflowService`
- [x] Export new types and methods from `index.ts`
- [x] Write tests: create-or-attach, lookup, reseed, restart survival, key uniqueness
- [x] Verify with `bun run spur-check`

### Review

**Review — 2026-06-13**

**Status:** 2 findings fixed
**Scope:** `packages/dual-workflow-engine/src/*`, `packages/dual-workflow-engine/tests/*`
**Mode:** verify
**Channel:** current
**Gate:** `bun run spur-check` -> pass; `bun run build` -> pass

#### P1 — Blockers
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Keyed run path did not attach through normal run execution | Correctness | `packages/dual-workflow-engine/src/run-lifecycle.ts` | Use `createOrAttachRun()` when `WorkflowRunOptions.externalKey` is provided and preserve the existing run id on attach |
| 2 | Reseed API did not emit the corrective event or validate target states | Correctness | `packages/dual-workflow-engine/src/service.ts` | Validate supplied state-machine definitions, persist the reseed, and emit `workflow.run.reseeded` with previous and target state |

#### P2 — Warnings
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

#### P3 — Info
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

#### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

**Fix-pass 2026-06-13:** 2 fixed, 0 failed, 0 skipped.

**Verdict:** PASS. All R1-R5 requirements implemented and verified after fix pass.

### Testing

- Command: `bun test packages/dual-workflow-engine/tests/durable-runs.test.ts packages/dual-workflow-engine/tests/run-lifecycle.test.ts`
- Result: targeted tests pass 45/45; command exits nonzero only because isolated-file coverage is below the repository coverage gate
- Command: `bun run lint`
- Result: pass — Biome clean and per-package typecheck clean
- Command: `bun run spur-check`
- Result: pass — lint/typecheck, pre-check spur rules, 1397/1397 tests, post-check coverage gate
- Command: `bun run build`
- Result: pass — all packages built

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| test | packages/dual-workflow-engine/tests/durable-runs.test.ts | Main | 2026-06-13 |

### References


### History

- Migrated from legacy format (2026-07-31)
