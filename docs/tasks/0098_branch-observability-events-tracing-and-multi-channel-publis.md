---
schema_version: 1
name: Branch observability events, tracing, and multi-channel publish E2E integration tests
status: done
template: feature-impl
created_at: 2026-10-04T21:10:02.282Z
updated_at: "2026-10-07T20:21:44.214Z"
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
done_forced: "false"
done_reason: unforced close; PASS artifact at /Users/robin/xprojects/ts-libs-runall-c2-c2f1/.spur/run/0098-verdict.json
---

## 0098. Branch observability events, tracing, and multi-channel publish E2E integration tests

### Background

Implements: R8 — Existing serial workflows and FSM runs remain unchanged.

To make parallel workflows fully observable in production, the engine must emit typed branch events and OpenTelemetry span events. Additionally, a comprehensive end-to-end integration test is needed to simulate real-world publishing pipelines (such as knowledge-kit's multi-channel fan-out).

This task introduces typed branch events to `WorkflowEngineEvents`, adds span instrumentation, builds an end-to-end multi-channel publish test fixture, and verifies 100% backwards compatibility across the entire existing test suite.

### Requirements

- [x] R1. WorkflowEngineEvents in src/events.ts defines workflow.branch.started, workflow.branch.done, workflow.branch.failed, and workflow.branch.paused.
- [x] R2. RunLifecycle and BranchCoordinator emit branch events and add OTel span events for branch lifecycles.
- [x] R3. Comprehensive E2E test fixture in tests/e2e-parallel.test.ts simulates 3-channel publish (podcast feed, Xiaohongshu, WeChat) verifying true concurrency, timing, and error handling.
- [x] R4. Full test suite passes with zero regressions on existing state-machine and transition-flow fixtures.

### Acceptance Criteria

- [x] AC1 — Existing serial workflows and FSM runs remain unchanged (req: R4)
- [x] AC2 — Concurrent branch execution overlaps under bounded concurrency (req: R2; req: R3)
- [x] AC3 — Collect failure policy allows all branches to complete before recording aggregate failure (req: R3)

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

- `packages/dual-workflow-engine/src/events.ts:149`: added `workflow.branch.started`, `workflow.branch.done`, `workflow.branch.failed`, and `workflow.branch.paused` to `WorkflowEngineEvents`.
- `packages/dual-workflow-engine/src/run-lifecycle.ts:487`: added `branchStarted`, `branchDone`, `branchFailed`, and `branchPaused` observability and span emission helpers.
- `packages/dual-workflow-engine/src/transition-flow.ts:207`: wired branch event emissions into parallel region branch dispatch and settlement.
- `packages/dual-workflow-engine/tests/e2e-parallel.test.ts:10`: implemented E2E multi-channel publish integration fixture simulating independent podcast, Xiaohongshu, and WeChat transports.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | `packages/dual-workflow-engine/src/events.ts:149`; `packages/dual-workflow-engine/tests/e2e-parallel.test.ts:10`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). Re-authored .spur/run/0098-verify-answer.txt:9 and .spur/run/0098-verdict.json:9 (follow-up verification artifacts). |
| R2 | MET | `packages/dual-workflow-engine/src/run-lifecycle.ts:495`; `packages/dual-workflow-engine/tests/e2e-parallel.test.ts:10`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
| R3 | MET | `packages/dual-workflow-engine/tests/e2e-parallel.test.ts:10`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:158`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
| R4 | MET | Serial and FSM regression suites run in the full project gate.; `packages/dual-workflow-engine/tests/e2e-parallel.test.ts:10`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| R8 — Existing serial workflows and FSM runs remain unchanged | MET | test | `packages/dual-workflow-engine/tests/e2e-parallel.test.ts:10`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
| R2 — Concurrent branch execution overlaps under bounded concurrency | MET | test | `packages/dual-workflow-engine/tests/transition-flow.test.ts:414`; `packages/dual-workflow-engine/tests/transition-flow.test.ts:549`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:439`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
| R4 — Collect failure policy allows all branches to complete before recording aggregate failure | MET | test | `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:158`; `packages/dual-workflow-engine/tests/parallel-regressions.test.ts:403`; bun run spur-check: 2836 pass / 0 fail; Biome, all package typechecks, 58 pre-check rules and 2 post-check rules pass; exit 0 (fresh this run). |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

Review of the 0098 patch:

| Priority | Finding | File:Line | Disposition |
| --- | --- | --- | --- |
| P2 | README Event Map and tests/events.test.ts synchronization | `packages/dual-workflow-engine/README.md:851` | FIXED — documented 4 new branch events and updated knownEvents array |
| P2 | True concurrency verification | `packages/dual-workflow-engine/tests/e2e-parallel.test.ts:114` | FIXED — 3 branches with 40ms, 45ms, 35ms sleep finish in <90ms (measured ~58ms) |
| P3 | Branch event payload consistency | `packages/dual-workflow-engine/src/events.ts:149` | FIXED — all branch events carry `runId`, `parallelNode`, and `branchId` for exact correlation |
| P4 | OTel span events for branches | `packages/dual-workflow-engine/src/run-lifecycle.ts:487` | FIXED — `addSpanEvent` calls mirror each branch event into OpenTelemetry trace |

Residual risk: None. Additive event signatures do not alter existing subscriber contracts.

### References

- Feature: C2 (Durable structured fork-join parallel execution)
- Umbrella Task: 0092 (Implement fork/join parallel node execution)
- ADR-013 (Observability on ts-infra)
- Dependencies: 0095 (Scheduler), 0096 (Cancellation), 0097 (Pause/Resume)

### History

- 2026-10-04T22:13:40.194Z todo → wip (system)
- 2026-10-04T22:19:12.460Z wip → testing (system)
- 2026-10-04T22:19:25.514Z testing → done (system)

