---
schema_version: 1
name: Dependency-driven ready-queue scheduler, conditional skip propagation, and durable DAG execution
status: todo
template: feature-impl
created_at: 2026-10-04T21:10:02.284Z
updated_at: "2026-10-04T21:28:47.042Z"
feature_id: C3
priority: P2
tags:
  - dual-workflow-engine
  - dag
  - scheduler
estimate_hours: 12

dependencies: ["0099", "0094"]
---

## 0100. Dependency-driven ready-queue scheduler, conditional skip propagation, and durable DAG execution

### Background

Implements: R2 — Dependency ready-queue scheduling; R3 — Conditional branch skip propagation; R4 — Durable DAG recovery.

Once a DAG workflow definition is validated as acyclic (task 0099), the runtime needs a dependency-driven scheduler to execute nodes as prerequisites complete, handle conditional skipping without deadlocking joins, and support durable resume.

This task implements `DagDriver` in `src/dag.ts`, integrating it into `WorkflowService`, with ready-queue dispatching, conditional skip propagation, and durable node execution tracking.

### Requirements

- [ ] R1. DagDriver manages a ready queue of runnable nodes, dispatching nodes as soon as their upstream dependencies satisfy completion criteria.
- [ ] R2. Unselected conditional branches propagate skipped status to downstream dependents so join barriers do not deadlock.
- [ ] R3. Durable node-level persistence tracks execution outcomes, and resumeRun restarts only incomplete or ready nodes without replaying completed dependencies.
- [ ] R4. Out of scope: Dynamic graph expansion at runtime (all nodes are statically declared).

### Acceptance Criteria

- [ ] AC1 — Dependency ready-queue scheduling (req: R1)
- [ ] AC2 — Conditional branch skip propagation (req: R2)
- [ ] AC3 — Durable DAG recovery (req: R3)

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

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature: C3 (Static dependency DAG workflow execution mode)
- ADR-034 (Static Dependency DAG)
- Dependencies: 0099 (DAG Schema & Validation), 0094 (Persistence ledger)

### History
