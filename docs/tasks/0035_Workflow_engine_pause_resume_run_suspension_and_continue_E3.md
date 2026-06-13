---
name: "Workflow engine: pause/resume — run suspension and continue (E3)"
description: "Workflow engine: pause/resume — run suspension and continue (E3)"
status: Done
created_at: 2026-06-13T01:09:37.989Z
updated_at: 2026-06-13T01:09:37.989Z
folder: docs/tasks
type: task
feature-id: ""
priority: P0
tags: ["dual-workflow-engine","spur-consumer"]
impl_progress:
  planning: done
  design: done
  implementation: done
  review: done
  testing: done
---

## 0035. "Workflow engine: pause/resume — run suspension and continue (E3)"

### Background

Human-in-the-loop support: a workflow definition must be able to declare a state where the run suspends (e.g. an approval checkpoint in an execution pipeline) instead of auto-advancing. A later, separate process invocation resumes the run. Consumers list paused runs to discover what awaits approval.


### Requirements

- [x] **R1**: A state (or action) can mark the run paused; the engine stops advancing and persists the paused position. -> **MET** | Evidence: `StateDef.pause` / `FlowNodeDef.pause` attribute; both drivers check after enter/action execution
- [x] **R2**: A resume API continues a paused run from where it stopped; resuming a non-paused run is a clear error. -> **MET** | Evidence: `WorkflowService.resumeRun()` validates status=paused; `WorkflowResumeError` for invalid attempts
- [x] **R3**: Paused runs are queryable (by workflow, by status, most-recent-first) so a CLI can implement 'continue the latest paused run, after confirmation'. -> **MET** | Evidence: `listPausedRuns({ workflowName?, limit? })` on both persistence adapters
- [x] **R4**: Pause/resume fire their own lifecycle events distinguishable from normal transitions. -> **MET** | Evidence: `workflow.run.paused` and `workflow.run.resumed` events in `events.ts`
- [x] **R5**: Tests: pause persists across restart; resume completes the run; query ordering. -> **MET** | Evidence: 20 dedicated tests in `tests/pause-resume.test.ts`


### Q&A



### Design

Capability E3: human-in-the-loop suspension. A workflow definition must be able to declare a pause point
(e.g. an approval checkpoint); the run suspends instead of auto-advancing, and a later, separate process
invocation resumes it.

- Pause is declarative (a state attribute or pause action kind in the definition schema) — not a
  consumer-side hack.
- Paused position persists (E1 persistence); resuming a non-paused run is a clear, typed error.
- Paused runs are queryable: by workflow, by status, most-recent-first ordering — sufficient for a CLI
  implementing "continue the latest paused run after confirmation".
- Pause and resume emit their own lifecycle events, distinguishable from normal transitions.


### Solution

1. Definition schema: add the pause declaration (state-level attribute, schema files updated + validated);
   engine execution honors it by persisting a `paused` run status at that point.
2. API: `resumeRun(runHandle)` continues from the paused position; `listPausedRuns({ workflow?, limit?,
   order: recent-first })` for discovery.
3. Events: `run.paused` / `run.resumed` (naming per existing event conventions) on the same seam as
   transition events.
4. Tests: pause persists across simulated restart; resume completes the run; resume-non-paused typed
   error; query ordering with multiple paused runs. Coverage ≥90%; semver minor (schema addition is
   backward-compatible — absent attribute = never pauses).


### Plan


- [x] Extend `WorkflowStatus` type with `'paused'`
- [x] Add `pause?: boolean` to `StateDef` and `FlowNodeDef` in `types.ts`
- [x] Add `run.paused` / `run.resumed` events to `events.ts`
- [x] Add `listPausedRuns` to `WorkflowPersistenceAdapter` interface
- [x] Implement `listPausedRuns` in `DbWorkflowPersistenceAdapter` and `MemoryWorkflowPersistenceAdapter`
- [x] Add `pause` to Zod schemas (`StateDef` → `pause: z.boolean().optional()`, `FlowNodeDef` → `pause: z.boolean().optional()`)
- [x] Add `pause` to JSON Schema files (both state-machine and transition-flow)
- [x] Modify `StateMachineDriver.loop` to check `current.pause` after enter actions → finalize as `'paused'` instead of continuing
- [x] Modify `TransitionFlowDriver.loop` to check `current.pause` after node action → finalize as `'paused'` instead of continuing
- [x] Add `RunLifecycle.pause()` method: finalize run as paused, emit `workflow.run.paused`
- [x] Add `RunLifecycle.resume()` static method for driver resume paths
- [x] Add `resumeRun(workflow, runId, options?)` to `WorkflowService`: load run, validate status=paused, re-enter driver from current state
- [x] Add `WorkflowResumeError` for non-paused resume attempts
- [x] Export new types and methods from `index.ts`
- [x] Write tests: pause point halts, resume completes, resume-non-paused error, list ordering, persistence across restart, events fired
- [x] Verify with `bun run spur-check`

### Review

**Review — 2026-06-13**

**Status:** 1 finding fixed
**Scope:** `packages/dual-workflow-engine/src/*`, `packages/dual-workflow-engine/tests/*`, `packages/dual-workflow-engine/schemas/*`
**Mode:** verify
**Channel:** current
**Gate:** `bun run spur-check` -> pass; `bun run build` -> pass

#### P1 — Blockers
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

#### P2 — Warnings
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

#### P3 — Info
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Missing regression that resumed runs leave paused discovery | Correctness | `packages/dual-workflow-engine/tests/pause-resume.test.ts` | Assert resumed state-machine and transition-flow runs persist `done` status and no longer appear in `listPausedRuns()` |

#### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

**Fix-pass 2026-06-13:** 1 fixed, 0 failed, 0 skipped.

**Verdict:** PASS. All R1-R5 requirements implemented and verified after fix pass.

### Testing

- Command: `bun test packages/dual-workflow-engine/tests/pause-resume.test.ts`
- Result: 20/20 tests pass; command exits nonzero only because isolated-file coverage is below the repository coverage gate
- Command: `bun run lint`
- Result: pass — Biome clean and per-package typecheck clean
- Command: `bun run spur-check`
- Result: pass — lint/typecheck, pre-check spur rules, 1436/1436 tests, post-check coverage gate
- Command: `bun run build`
- Result: pass — all packages built



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| test | packages/dual-workflow-engine/tests/pause-resume.test.ts | Main | 2026-06-13 |

### References

