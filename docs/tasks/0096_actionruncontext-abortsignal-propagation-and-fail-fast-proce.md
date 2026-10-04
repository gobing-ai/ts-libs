---
schema_version: 1
name: ActionRunContext AbortSignal propagation and fail-fast process-group cancellation
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.280Z
updated_at: "2026-10-04T22:38:00.687Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - cancellation
estimate_hours: 6

dependencies: ["0095"]
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-runall-c2-c2f1/.spur/run/0096-verdict.json
---

## 0096. ActionRunContext AbortSignal propagation and fail-fast process-group cancellation

### Background

Implements: R3 — Fail-fast cancels active siblings with process-group cleanup.

When a workflow runs concurrent child processes (e.g. video rendering, audio compilation, web requests), failure in one branch under `fail-fast` must not leave orphaned processes running in the background.

`@gobing-ai/ts-runtime`'s `ProcessExecutor` already has Unix process-group containment and responds to `AbortSignal` by sending SIGTERM followed by SIGKILL to the entire process group. This task wires `AbortSignal` across the workflow action/guard boundaries and integrates fail-fast sibling cancellation.

### Requirements

- [x] R1. ActionRunContext and GuardContext in src/types.ts include an optional signal: AbortSignal.
- [x] R2. ShellActionRunner and ShellGuardRunner in src/host.ts forward signal to ProcessExecutor.run({ signal, ... }).
- [x] R3. Under failurePolicy 'fail-fast', when any branch execution fails, the coordinator immediately aborts all active sibling branch controllers.
- [x] R4. Out of scope: Custom process killing inside ts-dual-workflow-engine; ts-runtime owns all process-group management.

### Acceptance Criteria

- [x] AC1 — Fail-fast cancels active siblings with process-group cleanup (req: R1; req: R2; req: R3)

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

- `packages/dual-workflow-engine/src/types.ts:211`: added `signal?: AbortSignal` to `ActionRunContext`, `GuardContext`, and `WorkflowRunOptions`.
- `packages/dual-workflow-engine/src/action-step.ts:61`: added `signal` to `ActionStepDeps` and forwarded it to `host.runAction`.
- `packages/dual-workflow-engine/src/host.ts:166`: forwarded `signal` through `spawnShellCommand` to `ProcessExecutor.run` in both `ShellActionRunner` and `ShellGuardRunner`.
- `packages/dual-workflow-engine/src/transition-flow.ts:162`: implemented `abortSiblings` for `fail-fast` parallel policies and finalized aborted branches as `'cancelled'`.
- `packages/dual-workflow-engine/tests/cancellation.test.ts:7`: added test suite for `AbortSignal` propagation, sibling cancellation, and subprocess termination.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/dual-workflow-engine/src/types.ts:211` — ActionRunContext.signal?: AbortSignal |
| R2 | MET | `packages/dual-workflow-engine/src/host.ts:166` — ShellActionRunner forwards signal to ProcessExecutor.run |
| R3 | MET | `packages/dual-workflow-engine/src/transition-flow.ts:165` — fail-fast abortSiblings aborts all active sibling AbortControllers (anchor corrected from brace line :162) |
| R4 | MET | Out-of-scope row (process-group management owned by ts-runtime); boundary confirmed in commit 70f43421 |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R3 — Fail-fast cancels active siblings with process-group cleanup | MET | test | `packages/dual-workflow-engine/tests/cancellation.test.ts:41` ('fail-fast aborts active sibling branches') — anchor corrected from :7; signal exposure proof at :7; subprocess termination at :112 |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

Review of the 0096 patch:

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P2 | Shell action must forward signal to ts-runtime ProcessExecutor | `packages/dual-workflow-engine/src/host.ts:166` | FIXED — `spawnShellCommand` passes `signal` enabling Unix process-group termination |
| P2 | Branch ledger status for aborted branches | `packages/dual-workflow-engine/src/transition-flow.ts:186` | FIXED — aborted branches saved as `'cancelled'` rather than generic failure |
| P3 | Run-level signal forwarding to parallel branches | `packages/dual-workflow-engine/src/transition-flow.ts:157` | FIXED — outer `options.signal` abort events listener forwards abort to all branch controllers |
| P4 | Optional signal in ActionStepDeps | `packages/dual-workflow-engine/src/action-step.ts:61` | FIXED — optional field with fallback to `deps.options.signal` |

Residual risk: None. Process-group escalation is handled by `ts-runtime` without raw platform calls.

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-011 (Runtime process-group ownership), ADR-025 (Interruption contract)
- Dependency: 0095 (Scheduler)

### History

- 2026-10-04T22:04:55.629Z todo → wip (system)
- 2026-10-04T22:08:12.713Z wip → testing (system)
- 2026-10-04T22:08:25.881Z testing → done (system)

