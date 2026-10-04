---
schema_version: 1
name: Branch observability events, tracing, and multi-channel publish E2E integration tests
status: todo
template: feature-impl
created_at: 2026-10-04T21:10:02.282Z
updated_at: "2026-10-04T21:28:36.671Z"
feature_id: C2
parent_wbs: "0092"
priority: P2
tags:
  - dual-workflow-engine
  - fork-join
  - observability
  - e2e
estimate_hours: 6

dependencies: ["0095", "0096", "0097"]
---

## 0098. Branch observability events, tracing, and multi-channel publish E2E integration tests

### Background

Implements: R8 — Existing serial workflows and FSM runs remain unchanged.

To make parallel workflows fully observable in production, the engine must emit typed branch events and OpenTelemetry span events. Additionally, a comprehensive end-to-end integration test is needed to simulate real-world publishing pipelines (such as knowledge-kit's multi-channel fan-out).

This task introduces typed branch events to `WorkflowEngineEvents`, adds span instrumentation, builds an end-to-end multi-channel publish test fixture, and verifies 100% backwards compatibility across the entire existing test suite.

### Requirements

- [ ] R1. WorkflowEngineEvents in src/events.ts defines workflow.branch.started, workflow.branch.done, workflow.branch.failed, and workflow.branch.paused.
- [ ] R2. RunLifecycle and BranchCoordinator emit branch events and add OTel span events for branch lifecycles.
- [ ] R3. Comprehensive E2E test fixture in tests/e2e-parallel.test.ts simulates 3-channel publish (podcast feed, Xiaohongshu, WeChat) verifying true concurrency, timing, and error handling.
- [ ] R4. Full test suite passes with zero regressions on existing state-machine and transition-flow fixtures.

### Acceptance Criteria

- [ ] AC1 — Existing serial workflows and FSM runs remain unchanged (req: R4)
- [ ] AC2 — Concurrent branch execution overlaps under bounded concurrency (req: R2; req: R3)
- [ ] AC3 — Collect failure policy allows all branches to complete before recording aggregate failure (req: R3)

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-04T21:28:36.064Z

#### Q&A entry — 2026-10-04T14:30:00.000Z
- **Q: Do branch events break existing event listeners?**
  - A: No, new event keys on `EventBus<WorkflowEngineEvents>` are strictly additive.
- **Q: How does the E2E test assert true parallelism?**
  - A: By executing multiple actions with known sleep durations (e.g. 50ms each) and asserting that total wall-clock time is strictly less than the sum of sequential branch durations.

### Design

**WHAT:**
Add branch event signatures in `src/events.ts`. Add emission hooks in `src/run-lifecycle.ts` and `src/transition-flow.ts`. Create `tests/e2e-parallel.test.ts`.

**FROZEN EVENT SIGNATURES:**
```ts
'workflow.branch.started': (data: {
    runId: string;
    parallelNode: string;
    branchId: string;
    node: string;
    severity: EventSeverity;
}) => void;

'workflow.branch.done': (data: {
    runId: string;
    parallelNode: string;
    branchId: string;
    durationMs: number;
    ok: boolean;
    severity: EventSeverity;
}) => void;

'workflow.branch.failed': (data: {
    runId: string;
    parallelNode: string;
    branchId: string;
    error?: string;
    severity: EventSeverity;
}) => void;
```

**WHERE:**
- Primary files: `packages/dual-workflow-engine/src/events.ts`, `src/run-lifecycle.ts`, `src/transition-flow.ts`.
- Test targets: `packages/dual-workflow-engine/tests/e2e-parallel.test.ts`, `tests/lifecycle-bus.test.ts`.

**ANTI-PATTERNS:**
- Do not modify existing event schemas or payloads.

### Plan

1. Add branch events to `WorkflowEngineEvents` in `src/events.ts`.
2. Add branch emission helpers in `src/run-lifecycle.ts` and wire them into `BranchCoordinator`.
3. Create `tests/e2e-parallel.test.ts` modeling multi-channel publishing with concurrent tasks, failure isolation, and timing assertions.
4. Run `bun run spur-check` and ensure all tests pass with zero regressions.

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-013 (Observability on ts-infra)
- Dependencies: 0095 (Scheduler), 0096 (Cancellation), 0097 (Pause/Resume)

### History
