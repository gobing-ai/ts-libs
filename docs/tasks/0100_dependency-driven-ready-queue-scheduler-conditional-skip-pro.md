---
schema_version: 1
name: Dependency-driven ready-queue scheduler, conditional skip propagation, and durable DAG execution
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.284Z
updated_at: "2026-10-07T21:52:26.542Z"
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

The current scheduler at packages/dual-workflow-engine/src/dag.ts:476-550 is completion-driven: dependents become ready only after their complete node promise durably settles, independently of unrelated roots. The original wave implementation and frozen illustrative resume signature were superseded by tasks 0101,0104,0105: the shipped resume accepts external key and options while retaining the existing lifecycle contract. Skip policy/fixed point is at lines 328-359,525-542; durable restoration/anchor at lines 226-287. The re-audit fixes premature status/output/count publication and proves the held-write/unrelated-wakeup race at packages/dual-workflow-engine/tests/dag.test.ts:782.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/dual-workflow-engine/src/dag.ts:476-550 admits ready nodes on complete node settlement; packages/dual-workflow-engine/tests/dag.test.ts:8,731,782 proves diamond ordering, independent-child dispatch and durable write barrier. Fresh full gate: 2861 pass, 0 fail. |
| R2 | MET | packages/dual-workflow-engine/src/dag.ts:328-359,525-542 implements all/any and fixed-point skip propagation; packages/dual-workflow-engine/tests/dag.test.ts:57,865,894,921 verifies conditional, mixed and reverse-declared skips. Fresh full gate: 2861 pass, 0 fail. |
| R3 | MET | packages/dual-workflow-engine/src/dag.ts:226-287 restores ledger statuses/output/count, and lines 460-470 commit before publication; packages/dual-workflow-engine/tests/recovery-regressions.test.ts:161,219,247,321,531 verifies interruption, variable precedence, counting and SQLite. Fresh full gate: 2861 pass, 0 fail. |
| R4 | MET | packages/dual-workflow-engine/src/dag.ts:528 iterates only statically declared workflow nodes; dynamic expansion remains out of scope. Fresh full gate: 2861 pass, 0 fail. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: R2 — Dependency ready-queue scheduling | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:8,731,782,865 tests prerequisites, immediate child admission, durable settlement and all/any. Fresh full gate: 2861 pass, 0 fail. |
| Scenario: R3 — Conditional branch skip propagation | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:57,894,921 checks skipped branches, mixed joins and reverse-declared fixed-point propagation. Fresh full gate: 2861 pass, 0 fail. |
| Scenario: R4 — Durable DAG recovery | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:151 and packages/dual-workflow-engine/tests/recovery-regressions.test.ts:161,219,247,321,531 tests no replay, persisted variables/counts and SQLite recovery. Fresh full gate: 2861 pass, 0 fail. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0100

**Scope:** working tree fallback (no exact task subject tag), restricted to this task's declared source/tests plus immediate callers; source and anchors reread this run.
**Dimensions:** functional, security, efficiency, correctness, usability, architecture.
**Verdict:** PASS

##### Findings

| Priority | Dimension | Location | Finding | Disposition |
| --- | --- | --- | --- | --- |
| P4 | all | packages/dual-workflow-engine/src/dag.ts:121-600 | No open P1-P3 findings: task requirements/AC trace to real-driver tests and the fresh full gate. | ACCEPTED |
| P2 | correctness | packages/dual-workflow-engine/src/dag.ts:460-482 | A held terminal write previously published readiness early; unrelated completions could admit a child. Publication now follows durable settlement; regression packages/dual-workflow-engine/tests/dag.test.ts:782 failed before correction and passes afterward. | RESOLVED |

##### Functional Traceability

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | packages/dual-workflow-engine/src/dag.ts:476-550 admits ready nodes on complete node settlement; packages/dual-workflow-engine/tests/dag.test.ts:8,731,782 proves diamond ordering, independent-child dispatch and durable write barrier. |
| R2 | MET | packages/dual-workflow-engine/src/dag.ts:328-359,525-542 implements all/any and fixed-point skip propagation; packages/dual-workflow-engine/tests/dag.test.ts:57,865,894,921 verifies conditional, mixed and reverse-declared skips. |
| R3 | MET | packages/dual-workflow-engine/src/dag.ts:226-287 restores ledger statuses/output/count, and lines 460-470 commit before publication; packages/dual-workflow-engine/tests/recovery-regressions.test.ts:161,219,247,321,531 verifies interruption, variable precedence, counting and SQLite. |
| R4 | MET | packages/dual-workflow-engine/src/dag.ts:528 iterates only statically declared workflow nodes; dynamic expansion remains out of scope. |

##### SECUA Quality

Replay admission remains before ownership claim; both entry points share the same helper. Nodes reserve admission once, publish only durable completion, and drained errors keep their reasons. No secrets, unbounded new buffers, new dependencies, suppressions or skipped tests were introduced. Existing fail/continue and lifecycle error composition remain intact. Historical accepted observations are maintained by the design: no timeout for nonsettling work, action failures use fail-policy results, and variable collisions follow durable live completion / stable topological recovery ordering.

##### Architectural Depth

No candidates: DAG validation, scheduling, ledger recovery and lifecycle finalization retain their existing seams. No production FSM/transition-flow or adapter-contract changes; ADR-034 remains satisfied. Historical wave and snapshot-shortcut descriptions are superseded explicitly in Solution by tasks 0104/0105. Driver dryRun suppression retains the shared terminal-pause write contract; ledger writes remain separate from action effects with marked at-least-once replay, as documented in README.

**Validation:** bun run spur-check exit 0, 2861 pass / 0 fail, 58 pre / 2 post rules; all package builds exit 0. Receipts .spur/run/c3-verifyall/spur-check.log and build.log.

### References

- Feature: C3 (Static dependency DAG workflow execution mode)
- ADR-034 (Static Dependency DAG)
- Dependencies: 0099 (DAG Schema & Validation), 0094 (Persistence ledger)

### History

- 2026-10-04T22:40:58.702Z todo → wip (system)
- 2026-10-04T23:16:49.341Z wip → testing (system)
- 2026-10-04T23:16:50.375Z testing → done (system)

