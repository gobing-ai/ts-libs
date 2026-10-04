---
schema_version: 1
name: ActionRunContext AbortSignal propagation and fail-fast process-group cancellation
status: todo
template: feature-impl
created_at: 2026-10-04T21:10:02.280Z
updated_at: "2026-10-04T21:28:25.594Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - cancellation
estimate_hours: 6

dependencies: ["0095"]
---

## 0096. ActionRunContext AbortSignal propagation and fail-fast process-group cancellation

### Background

Implements: R3 — Fail-fast cancels active siblings with process-group cleanup.

When a workflow runs concurrent child processes (e.g. video rendering, audio compilation, web requests), failure in one branch under `fail-fast` must not leave orphaned processes running in the background.

`@gobing-ai/ts-runtime`'s `ProcessExecutor` already has Unix process-group containment and responds to `AbortSignal` by sending SIGTERM followed by SIGKILL to the entire process group. This task wires `AbortSignal` across the workflow action/guard boundaries and integrates fail-fast sibling cancellation.

### Requirements

- [ ] R1. ActionRunContext and GuardContext in src/types.ts include an optional signal: AbortSignal.
- [ ] R2. ShellActionRunner and ShellGuardRunner in src/host.ts forward signal to ProcessExecutor.run({ signal, ... }).
- [ ] R3. Under failurePolicy 'fail-fast', when any branch execution fails, the coordinator immediately aborts all active sibling branch controllers.
- [ ] R4. Out of scope: Custom process killing inside ts-dual-workflow-engine; ts-runtime owns all process-group management.

### Acceptance Criteria

- [ ] AC1 — Fail-fast cancels active siblings with process-group cleanup (req: R1; req: R2; req: R3)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:25.164Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: What happens if an action does not support cancellation?**
  - A: In-process non-shell actions receive `context.signal` and can cooperatively abort. Shell actions automatically terminate via `ts-runtime`'s process-group signal.
- **Q: Does cancellation mark the branch as 'cancelled'?**
  - A: Yes, interrupted/aborted branches are finalized with status `'cancelled'` in the branch ledger.

### Design

**WHAT:**
Propagate `AbortSignal` through `ActionRunContext` and `GuardContext`. Wire `AbortController` into each branch in `BranchCoordinator`.

**FROZEN SIGNATURES:**
```ts
export interface ActionRunContext {
    readonly runId: string;
    readonly actionId?: string;
    readonly workdir?: string;
    readonly stateOrNodeId: string;
    readonly vars: Vars;
    readonly env: Record<string, string>;
    readonly metadata?: Record<string, unknown>;
    readonly events?: EventBus<WorkflowEngineEvents>;
    readonly signal?: AbortSignal;
}
```

**WHERE:**
- Primary files: `packages/dual-workflow-engine/src/types.ts`, `src/host.ts`, `src/action-step.ts`, `src/transition-flow.ts`.
- Test targets: `packages/dual-workflow-engine/tests/cancellation.test.ts`.

**ANTI-PATTERNS:**
- Do not call `process.kill` directly from `ts-dual-workflow-engine`. ADR-011 and runtime-boundaries rules strictly require using `ProcessExecutor` from `@gobing-ai/ts-runtime`.

**HANDOFF TO DOWNSTREAM:**
Provides safe termination for fail-fast workflows and run-level abort to task 0098 (E2E tests).

### Plan

1. Add `signal?: AbortSignal` to `ActionRunContext` and `GuardContext` in `src/types.ts`.
2. Update `src/action-step.ts` and `src/host.ts` to forward `signal` into `processExecutor.run`.
3. In `BranchCoordinator` (`src/transition-flow.ts`), create an `AbortController` for each branch; on fail-fast failure, call `abort()` on active sibling controllers.
4. Add tests in `tests/cancellation.test.ts` verifying that child processes (e.g. `sleep 10`) terminate when a sibling fails under fail-fast.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-011 (Runtime process-group ownership), ADR-025 (Interruption contract)
- Dependency: 0095 (Scheduler)

### History
