---
schema_version: 1
name: Fork-join workflow definition schema, validation rules, and unhandled parallel rejection
status: todo
template: feature-impl
created_at: 2026-10-04T21:10:02.268Z
updated_at: "2026-10-04T21:28:11.712Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - schema
estimate_hours: 4

---

## 0093. Fork-join workflow definition schema, validation rules, and unhandled parallel rejection

### Background

Implements: R1 — Validation accepts structured fork-join and rejects invalid parallel definitions.

In `ts-dual-workflow-engine`, node definitions allow `type?: 'action' | 'gate' | 'parallel' | 'decision'` (`src/types.ts:125`, `src/schema.ts:139`), but `type: parallel` has no execution or validation backing. Authors who declare it receive silent sequential execution.

This task establishes the definition schema, typing, and validation rules for structured fork-join parallel execution within `transition-flow` workflows. It introduces `branches`, `join`, `joinPolicy`, and `failurePolicy`, and enforces that parallel regions are well-formed (valid endpoints, no cycles inside branches, converging join target). It also ensures that unsupported or malformed parallel declarations fail loudly during `validateWorkflowDef`.

### Requirements

- [ ] R1. TransitionFlowWorkflowDefSchema and types.ts accept parallel node properties: branches array, join target node ID, joinPolicy ('all'), and failurePolicy ('collect' | 'fail-fast').
- [ ] R2. validateTransitionFlow in src/config.ts enforces that parallel nodes declare non-empty branches, valid branch startNodes, an existing join target, and acyclic subgraphs within branches.
- [ ] R3. Schema and semantic validation reject nested parallel regions within a branch and unhandled parallel configurations with explicit WorkflowValidationError messages.
- [ ] R4. Out of scope: StateMachineWorkflowDef (FSM) is unchanged; general static dependency DAG execution is deferred to Feature C3.

### Acceptance Criteria

- [ ] AC1 — Validation accepts structured fork-join and rejects invalid parallel definitions (req: R1; req: R2; req: R3)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:11.193Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: Are branches declared inline or as graph edges?**
  - A: Branches declare a startNode and converge at the explicit join node. Graph edges describe transitions between nodes within each branch.
- **Q: Can joinPolicy be 'any' in v1?**
  - A: No, v1 restricts joinPolicy to 'all' to ensure reliable all-branch synchronization before proceeding. Quorum joins are deferred.
- **Q: Are nested parallel regions permitted?**
  - A: No, nested parallel regions are explicitly rejected during validation to keep barrier coordination and error recovery bounded.

### Design

**WHAT:**
Add structured fork-join fields to `FlowNodeDef` and `TransitionFlowWorkflowDefSchema` in `src/types.ts`, `src/schema.ts`, and `schemas/transition-flow-workflow.schema.json`. Add validation logic in `src/config.ts:validateTransitionFlow`.

**FROZEN NAMES & SIGNATURES:**
```ts
export type JoinPolicy = 'all';
export type FailurePolicy = 'collect' | 'fail-fast';

export interface FlowParallelBranchDef {
    readonly id: string;
    readonly startNode: string;
    readonly description?: string;
}

export interface FlowParallelNodeDef extends FlowNodeDef {
    readonly type: 'parallel';
    readonly branches: readonly FlowParallelBranchDef[];
    readonly join: string;
    readonly joinPolicy?: JoinPolicy;
    readonly failurePolicy?: FailurePolicy;
    readonly concurrencyLimit?: number;
}
```

**WHERE:**
- Primary files: `packages/dual-workflow-engine/src/types.ts`, `src/schema.ts`, `src/config.ts`, `schemas/transition-flow-workflow.schema.json`.
- Test targets: `packages/dual-workflow-engine/tests/schema.test.ts`, `tests/config.test.ts`.

**ANTI-PATTERNS:**
- Do not modify `StateMachineWorkflowDefSchema` or `StateDef` — FSM remains strictly sequential.
- Do not silently default missing branches or missing join targets; fail with `WorkflowValidationError`.

**HANDOFF TO DOWNSTREAM:**
Provides verified `FlowParallelNodeDef` and invariant checks to task 0094 (persistence ledger) and 0095 (scheduler).

### Plan

1. Update `src/types.ts` and `src/schema.ts` with `JoinPolicy`, `FailurePolicy`, `FlowParallelBranchDef`, and extended `FlowNodeDef`.
2. Update `schemas/transition-flow-workflow.schema.json` to validate the new parallel node schema.
3. Extend `src/config.ts:validateTransitionFlow` with parallel region validation (branch validation, join reachability, cycle rejection within branches, nested parallel rejection).
4. Add unit tests in `tests/schema.test.ts` and `tests/config.test.ts` verifying valid parallel configurations pass and invalid configurations fail loudly with descriptive errors.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-010 (extension registry), ADR-013 (RunLifecycle), ADR-020 (atomic commit)

### History
