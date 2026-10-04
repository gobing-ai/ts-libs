---
schema_version: 1
id: "C2"
name: "Durable structured fork-join parallel execution"
status: done
priority: P2
tags: []
created_at: "2026-10-04T21:08:28.440Z"
updated_at: "2026-10-04T22:22:24.817Z"
---

# C2: Durable structured fork-join parallel execution

## Goal

Provide durable, bounded structured fork-join parallel node execution within `transition-flow` workflows, enabling independent workflow branches (such as multi-channel publishing pipelines) to execute concurrently with isolated variable states, deterministic join aggregation, process-group cancellation, and restart-safe persistence without altering sequential state-machine (FSM) semantics.

## Scope

- In:
  - `transition-flow` schema and validation for structured fork-join (`type: parallel` / parallel region with explicit join and failure policies: `joinPolicy: 'all'`, `failurePolicy: 'collect' | 'fail-fast'`).
  - Fail-loud validation error for unhandled parallel structures or unsupported nesting.
  - Durable branch execution ledger (`workflow_branches` or equivalent SQLite/D1 compatible schema) tracking per-branch status, start/completion, and output deltas.
  - Bounded in-process scheduler respecting concurrency limits, running eligible branch actions concurrently while the coordinator owns the parent run lifecycle.
  - Variable isolation: branches read fork-time snapshot, write isolated deltas; deterministic join merger in declaration order with conflict rejection.
  - Cooperative and process-group cancellation: propagate `AbortSignal` through `ActionRunContext` and `GuardContext` into `ts-runtime`'s `ProcessExecutor`.
  - Per-branch pause, resume, and crash recovery: resume addresses paused branches without replaying already-succeeded sibling work; unresumable actions require `resumeRerun: true`.
  - Branch-scoped observability events (`workflow.branch.started`, `workflow.branch.done`, etc.) and trace spans.
  - End-to-end integration and concurrency tests including multi-channel publishing simulation.
- Out:
  - Modifications to `state-machine` (FSM) driver or state definitions (FSM remains purely sequential).
  - Arbitrary static dependency DAG scheduling without explicit fork-join boundaries (owned by Feature `C3`).
  - Dynamic fan-out / runtime collection partitioning (owned by future map/reduce extensions).
  - Distributed multi-worker dispatch (in-process single coordinator with persistent ledger only).
  - Downstream CLI presentation, Mermaid layout, and task/workflow migration in Spur or knowledge-kit (owned by downstream repositories).

## Acceptance Criteria

```gherkin
Feature: Durable structured fork-join parallel execution

  @core
  Scenario: R1 — Validation accepts structured fork-join and rejects invalid parallel definitions
    Given a transition-flow workflow definition with a parallel node declaring branches and an explicit join
    When validateWorkflowDef validates the workflow
    Then validation succeeds for valid fork-join structures and fails with named errors on missing branches, cycles inside branches, or undeclared join targets

  @core
  Scenario: R2 — Concurrent branch execution overlaps under bounded concurrency
    Given a parallel node with multiple independent branches
    When TransitionFlowDriver executes the workflow
    Then active branch actions execute concurrently up to the configured concurrency bound before the join advances

  @core
  Scenario: R3 — Fail-fast cancels active siblings with process-group cleanup
    Given a parallel node with failurePolicy fail-fast and two long-running child process branches
    When one branch fails
    Then its sibling's process group is terminated via AbortSignal and the parent run records the failing branch and reason

  @core
  Scenario: R4 — Collect failure policy allows all branches to complete before recording aggregate failure
    Given a parallel node with failurePolicy collect where one branch fails and another succeeds
    When the parallel region executes to completion
    Then every sibling finishes execution, outcomes are recorded, and the join reports aggregate status

  @core
  Scenario: R5 — Branch variable isolation and deterministic join merge
    Given two concurrent branches that set distinct runtime variables
    When both branches succeed and join
    Then both variable deltas are merged into the parent run's effective variables, and write collisions on the same variable key fail or follow strict declaration-order precedence

  @core
  Scenario: R6 — Persisted branch execution ledger and idempotent join activation
    Given a durable run in SQLite or D1 with persistence enabled
    When a parallel node executes
    Then each branch has a distinct persisted execution record, and a crash right after branches complete does not re-execute branches upon restart

  @core
  Scenario: R7 — Per-branch pause and resume preserves completed siblings
    Given a branch containing a node with pause: true
    When the workflow executes
    Then sibling branches run to completion, the run pauses at the branch barrier, and a subsequent resume continues only the paused branch without re-executing completed siblings

  @core
  Scenario: R8 — Existing serial workflows and FSM runs remain unchanged
    Given existing transition-flow and state-machine workflow definitions
    When executed on the updated engine
    Then execution behavior, persistence schemas, and finalization results remain identical to baseline
```

## Tasks

<!-- AUTO-GENERATED by spur feature refresh -->
| WBS | Task | Status |
| --- | ---- | ------ |
| 0092 | Implement fork/join parallel node execution in ts-dual-workflow-engine | done |
| 0093 | Fork-join workflow definition schema, validation rules, and unhandled parallel rejection | done |
| 0094 | Durable branch execution ledger schema, persistence adapter methods, and atomic join commit | done |
| 0095 | TransitionFlowDriver parallel region scheduler, concurrency bounding, and variable isolation | done |
| 0096 | ActionRunContext AbortSignal propagation and fail-fast process-group cancellation | done |
| 0097 | Per-branch pause, resume, and crash recovery with resumeRerun checks | done |
| 0098 | Branch observability events, tracing, and multi-channel publish E2E integration tests | done |
<!-- END AUTO-GENERATED -->

## Notes

Addresses the core limitation identified in task 0092 and downstream publishing workflows: enabling concurrent execution of independent transport channels without faking concurrency inside single actions. Builds on ts-runtime's existing ProcessExecutor cancellation and ADR-020 atomic batch persistence.

## History

- 2026-10-04T22:21:20.945Z backlog → active (system)
- 2026-10-04T22:22:24.259Z active → verifying (system)
- 2026-10-04T22:22:24.817Z verifying → done (system)

