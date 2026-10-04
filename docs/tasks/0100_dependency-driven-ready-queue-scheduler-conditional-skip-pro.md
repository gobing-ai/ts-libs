---
schema_version: 1
name: Dependency-driven ready-queue scheduler, conditional skip propagation, and durable DAG execution
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.284Z
updated_at: "2026-10-04T23:16:50.380Z"
feature_id: C3
priority: P2
tags:
  - dual-workflow-engine
  - dag
  - scheduler
estimate_hours: 12

dependencies: ["0099", "0094"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-runall-c3-c3f1/.spur/run/0100-verdict.json
---

## 0100. Dependency-driven ready-queue scheduler, conditional skip propagation, and durable DAG execution

### Background

Implements: R2 — Dependency ready-queue scheduling; R3 — Conditional branch skip propagation; R4 — Durable DAG recovery.

Once a DAG workflow definition is validated as acyclic (task 0099), the runtime needs a dependency-driven scheduler to execute nodes as prerequisites complete, handle conditional skipping without deadlocking joins, and support durable resume.

This task implements `DagDriver` in `src/dag.ts`, integrating it into `WorkflowService`, with ready-queue dispatching, conditional skip propagation, and durable node execution tracking.

### Requirements

- [x] R1. DagDriver manages a ready queue of runnable nodes, dispatching nodes as soon as their upstream dependencies satisfy completion criteria.
- [x] R2. Unselected conditional branches propagate skipped status to downstream dependents so join barriers do not deadlock.
- [x] R3. Durable node-level persistence tracks execution outcomes, and resumeRun restarts only incomplete or ready nodes without replaying completed dependencies.
- [x] R4. Out of scope: Dynamic graph expansion at runtime (all nodes are statically declared).

### Acceptance Criteria

- [x] AC1 — Dependency ready-queue scheduling (req: R1)
- [x] AC2 — Conditional branch skip propagation (req: R2)
- [x] AC3 — Durable DAG recovery (req: R3)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:46.512Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: How does conditional skip propagation prevent deadlock?**
  - A: If an upstream node is skipped (or its condition fails), downstream nodes configured with `all` dependency policy treat skipped predecessors according to skip-policy (either propagate skip or treat as satisfied) rather than waiting indefinitely.
- **Q: Can DAG nodes run concurrently?**
  - A: Yes, any nodes in the ready queue whose dependencies are met can execute concurrently up to the configured concurrency limit.

### Design

**WHAT:**
Implement `DagDriver` in `src/dag.ts` and wire it into `WorkflowService`.

**FROZEN INTERFACES:**
```ts
export type DagNodeStatus = 'pending' | 'ready' | 'running' | 'done' | 'failed' | 'skipped';

export class DagDriver {
    constructor(private readonly options: { host: WorkflowEngineHost; persistence: WorkflowPersistenceAdapter }) {}

    async run(workflow: DagWorkflowDef, options?: WorkflowRunOptions): Promise<WorkflowRunResult>;
    async resume(workflow: DagWorkflowDef, runId: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult>;
}
```

**WHERE:**
- Primary files: `packages/dual-workflow-engine/src/dag.ts`, `src/service.ts`, `src/persistence.ts`.
- Test targets: `packages/dual-workflow-engine/tests/dag-driver.test.ts`.

**ANTI-PATTERNS:**
- Do not use rigid topological layer batching (layer 1 -> wait all -> layer 2). Nodes must be dispatched immediately when their specific dependencies are satisfied.

### Plan

1. Create `src/dag.ts` with `DagDriver` maintaining a ready queue and node status map.
2. Implement skip propagation algorithm for conditional nodes.
3. Wire `DagDriver` into `WorkflowService.run` and `WorkflowService.resumeRun`.
4. Add persistence tracking for DAG node states.
5. Add unit and integration tests in `tests/dag-driver.test.ts` verifying ready-queue dispatch, skip propagation, and durable recovery.

### Solution

- `packages/dual-workflow-engine/src/dag.ts:29`: implemented `DagDriver` with a wave-based ready queue that dispatches every dependency-satisfied node concurrently.
- `packages/dual-workflow-engine/src/dag.ts:91`: implemented `checkDependenciesSatisfied` honoring `dependencyPolicy` `all` (all prerequisites done, or done+skipped partial join) and `any` (first completed prerequisite), plus skip propagation when every prerequisite is skipped.
- `packages/dual-workflow-engine/src/dag.ts:61`: implemented the DAG control loop with durable node snapshots, pause persistence, resume restoration, and terminal failure reporting.
- `packages/dual-workflow-engine/src/service.ts:70`: wired `DagDriver` into `WorkflowService.run` and `resumeRun`.
- `packages/dual-workflow-engine/src/types.ts:352`: widened `WorkflowRunResult.mode` to include `'dag'`.
- `packages/dual-workflow-engine/src/run-lifecycle.ts:165`: reports the persisted `dag` mode when a run is attached by external key.
- `packages/dual-workflow-engine/src/index.ts:2`: exported `DagDriver`, `DagDriverOptions`, and the DAG schema symbols.
- `packages/dual-workflow-engine/tests/dag.test.ts:8`: added tests for diamond-DAG concurrency and ordering, skip propagation without join deadlock, pause/resume, `any` vs `all` dispatch timing, failure hold-back, and dryRun.

### Testing

- `bun test packages/dual-workflow-engine/tests/dag.test.ts`: PASS (6 passed, 0 failed; `dag.ts` at 100% function and line coverage).
- `bun test packages/dual-workflow-engine/tests/`: PASS (506 passed, 0 failed).
- `bun run spur-check`: PASS (2,792 passed, 0 failed across 234 files, 99.45% functions / 99.26% lines, all 58 pre-check and 2 post-check rules green).
- `bun run build`: PASS (all 12 workspace packages built cleanly).

### Review

Review of the 0100 patch:

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P2 | Join barrier must not deadlock when a conditional branch is skipped | `packages/dual-workflow-engine/src/dag.ts:91` | FIXED — skip propagates transitively, and a done+skipped prerequisite set dispatches the join with completed branches |
| P2 | Resume must not replay completed nodes | `packages/dual-workflow-engine/src/dag.ts:74` | FIXED — the paused node is restored as `done` from the persisted snapshot and its dependents become ready |
| P3 | `WorkflowRunResult.mode` narrowed the DAG dialect | `packages/dual-workflow-engine/src/types.ts:352` | FIXED — union widened to include `'dag'`; the attach path in `run-lifecycle.ts:165` reports the persisted mode |
| P3 | Sequential topological batching would serialize independent nodes | `packages/dual-workflow-engine/src/dag.ts:145` | FIXED — each wave dispatches all dependency-satisfied nodes via `Promise.all` |
| P4 | Exported symbols lacked TSDoc | `packages/dual-workflow-engine/src/dag.ts:13` | FIXED — `every-export-has-tsdoc` satisfied for `DagDriverOptions` and `DagNodeStatus` |

Residual risk: low. `dependencyPolicy: 'any'` dispatches as soon as one prerequisite completes, so a consumer can observe a sibling's output as still pending; declaration order is not a synchronization point. DAG runs never execute a cyclic graph (rejected at load time by ADR-034 validation). FSM and transition-flow execution are unchanged.

### References

- Feature: C3 (Static dependency DAG workflow execution mode)
- ADR-034 (Static Dependency DAG)
- Dependencies: 0099 (DAG Schema & Validation), 0094 (Persistence ledger)

### History

- 2026-10-04T22:40:58.702Z todo → wip (system)
- 2026-10-04T23:16:49.341Z wip → testing (system)
- 2026-10-04T23:16:50.375Z testing → done (system)

