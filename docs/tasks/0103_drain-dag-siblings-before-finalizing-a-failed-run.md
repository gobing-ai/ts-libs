---
schema_version: 1
name: Drain DAG siblings before finalizing a failed run
status: done
template: feature-impl
created_at: 2026-10-07T18:44:08.760Z
updated_at: "2026-10-07T19:56:29.875Z"
feature_id: C3

priority: P1
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 2
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/run/0103-verdict.json
---

## 0103. Drain DAG siblings before finalizing a failed run

### Background

Review on 2026-10-07 found a DAG failure-settlement defect. The local EventBus, abort-listener, and invalid-Date fixes from that review do not change the DAG driver.

Confirmed against the current tree: `packages/dual-workflow-engine/src/dag.ts:168` awaits Promise.all over the current ready-node wave. A guard or persistence rejection escapes while already-started siblings remain pending. `packages/dual-workflow-engine/src/run-lifecycle.ts:267` then attempts failed-run finalization before those siblings settle. A fresh inline Bun probe in this refinement preserved the original guard Error identity and recorded `sibling-start, finalize:failed, sibling-end`; the run row was already failed when the sibling was released. Both DagDriver.run and DagDriver.resume call the same loop (`packages/dual-workflow-engine/src/dag.ts:36`, `packages/dual-workflow-engine/src/dag.ts:47`). WorkflowService dispatches both paths to that driver.

**Refine corrections (2026-10-07)**

- Prior claim that task 0093 fixed transition-flow draining → its completed task owns schema/semantic validation → remove it as a drain precedent; no reusable drain helper was found in the driver source.
- Ambiguous per-node exception containment → the existing wave starts every ready node before awaiting results → use one Promise.allSettled barrier and inspect results after the entire wave settles.
- Ambiguous stop-dispatch rule → nodes already admitted to the current wave may finish all their work → prohibit only subsequent waves/dependents after a fatal rejection; do not abort or abandon admitted work.
- Unspecified original/additional error handling → promise rejection reasons may be any JavaScript value → rethrow one reason unchanged; aggregate multiple reasons in ready-node declaration order, including undefined, while leaving RunLifecycle finalization-error composition intact.
- Checkbox-only AC bindings → the task-local requirement coverage checker consumes Scenario titles → retain AC1–AC3 titles and express them, plus run/resume and multiple-error coverage, as bound Gherkin scenarios.
- Environment assumed aligned → Bun is 1.3.14, but installed zod is 4.2.1 while bun.lock resolves 4.4.3 → add a step-0 frozen-lockfile install precondition for implementation; no dependency range or lockfile change is needed.

Concurrency audit: one worktree on main; no wip tasks. Existing uncommitted infra/utils fixes and review artifacts are unrelated and must be preserved. Task 0105 depends on this task and owns completion-driven scheduling; task 0104 owns recovery/pause semantics.

### Requirements

- [x] R1. On DAG run and resume, await settlement of every node admitted to the current wave, including all persistence operations invoked by those nodes, before propagating any guard, template-resolution, branch-start/finalize, or action-audit exception to RunLifecycle.
- [x] R2. After draining, rethrow a single node rejection reason unchanged; throw AggregateError containing every rejection reason in ready-node declaration order when multiple nodes reject. Do not dispatch a subsequent wave after any rejection. Infrastructure/guard exceptions remain fatal independently of action onError policy.
- [x] R3. Preserve successful runs, fulfilled node-result failure/continue routing, conditional skips, pause results, dryRun semantics, and RunLifecycle's existing composition of execution and failed-finalization errors. Change only dag.ts and its regression tests; no public API, dependency, schema, FSM, or transition-flow changes.

Out of scope: cancellation or retries of admitted work; repairing a persistence operation that rejected; guaranteeing final branch rows after persistence failure; adding timeouts to uncooperative siblings; completion-driven scheduling (0105); durable recovery/pause fixes (0104).

### Acceptance Criteria

```gherkin
Feature: DAG wave settlement before failure finalization

  Scenario: AC1 — A deferred sibling is drained after a throwing guard (req: R1)
    Given two ready nodes with a throwing guard and a deferred sibling action
    And the guard waits until that sibling has started
    When the guard throws and the sibling action or an invoked audit write remains blocked
    Then the public promise remains pending and the run row remains running
    And releasing every sibling write allows failed finalization and rejection
    And no node-dependent action starts and no invocation-owned write lands after rejection

  Scenario: AC2 — Persistence failure drains started work and preserves errors (req: R1; R2)
    Given a node whose branch-start, branch-finalize, or action-finalize persistence hook rejects
    And another admitted node has deferred action and branch-finalization work
    When the rejecting operation fails
    Then that sibling work settles before failed-run finalization or public rejection
    And the single rejection is the exact original reason
    And no next wave starts and no unhandled rejection occurs

  Scenario: AC3 — Existing driver semantics stay intact (req: R3)
    Given successful, condition-skipped, paused, dryRun, and action fail/continue DAG cases
    When all node execution promises fulfill
    Then existing result-routing behavior remains unchanged
    And the existing FSM and transition-flow suites still pass

  Scenario: AC4 — Run and resume share drain behavior (req: R1; R3)
    Given a fresh run or a legitimately seeded paused run resumed through WorkflowService
    When a ready-node exception occurs while a sibling remains blocked
    Then both entry paths wait for the admitted wave before terminal persistence and rejection

  Scenario: AC5 — Multiple failures retain every cause (req: R2; R3)
    Given multiple ready nodes rejecting in a different order from their declaration
    When all admitted work settles
    Then AggregateError.errors contains the original reasons in declaration order
    And a lone undefined rejection is still propagated as a rejection
    And a rejected failed-run finalization remains combined by the existing RunLifecycle AggregateError contract
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-07T19:00:44.900Z

- Decision: all current-wave members are admitted work; drain them fully and stop before any later wave. Cancellation, storage retries, and sibling timeouts are out of scope.
- Decision: preserve single-reason identity; use ordered AggregateError for multiple reasons, then retain the existing RunLifecycle finalization-error wrapper.
- Decision: retain normal onError result handling; guard/template/persistence exceptions remain fatal.
- Decision: task 0105 owns scheduling changes and must preserve this invariant; task 0104 owns recovery and pause semantics. Neither is a prerequisite for 0103.
- Decision: synchronize installed dependencies with the existing lockfile at implementation step 0. This refinement changes only the task specification.

### Design

No new API. WHAT/WHY: replace the early-rejecting wave barrier with the standard Promise.allSettled barrier so DAG work cannot outlive its public result. WHERE: packages/dual-workflow-engine/src/dag.ts; regression tests in packages/dual-workflow-engine/tests/dag.test.ts. Keep the existing node callback, ready-node collection, and fulfilled-result routing.

Frozen algorithm:

1. Call Promise.allSettled on the existing readyNodes.map callback. The complete ready wave is already admitted before any asynchronous rejection is observed; allow its guard/action/write chains to settle.
2. Once every promise settles, inspect status discriminators. Collect reasons from rejected results in input order; never use truthiness or drop undefined/null reasons.
3. One rejection: throw that exact reason. Multiple rejections: throw new AggregateError(reasons, 'DAG node execution failed'). Check rejection count before processing fulfilled failed/paused/done results; exceptions take precedence over normal result routing.
4. With zero rejections, unwrap fulfilled values and retain the existing result processing unchanged. Do not enter another scheduler iteration when there are rejected results.
5. Leave RunLifecycle as the sole run-finalization owner. Its existing catch attempts failed finalization and, if that fails, throws AggregateError([executionError, finalizeError], 'Workflow execution and failure persistence failed'). Preserve this error tree rather than replacing it.

No new per-node catch/finalize/retry logic, abort controller, scheduler class, concurrency configuration, or public error type. A rejected persistence hook may leave its own ledger row incomplete; this task drains invoked work, not storage recovery. A sibling that never settles still prevents completion, just as successful-wave behavior does; a timeout policy is outside this task.

Tests must use the real WorkflowService/DagDriver/RunLifecycle with MemoryWorkflowPersistenceAdapter. Wrap only individual persistence hooks to inject failure or deferred settlement; spy on finalizeRun while still calling the real adapter for success. Deferred promises provide ordering: observe sibling start, trigger exception, hold action/audit/branch writes separately, assert the run is running and the public promise pending, then release and inspect error identity/order and the complete event/write log. Always release deferred gates in test cleanup. Do not mock RunLifecycle or replace the driver, and do not use fixed-duration sleeps as the ordering oracle. Bun's test runner detects unhandled errors. For resume, seed a valid paused snapshot with a dedicated anchor already considered complete and other ready test nodes; do not depend on the broken interruption-recovery path owned by 0104.

Prerequisites/handoff: no incomplete prerequisite. 0093 is historical schema context only. 0105 must carry this drain/error contract into its future in-flight scheduler; it must not convert a wake-up Promise.race into early run settlement. No active same-file task or second worktree was found. Preserve the existing unrelated working-tree edits. Implementation precondition: bun install --frozen-lockfile to align the installed zod 4.2.1 with locked 4.4.3, without changing bun.lock or package manifests.

### Plan

- [x] 0. Run bun install --frozen-lockfile and confirm Bun 1.3.14 / installed zod 4.4.3. Preserve unrelated edits and confirm no new same-file wip work; do not hand-edit dependency versions.
- [x] 1. In tests/dag.test.ts, add a deferred guard/action regression through WorkflowService and record action, audit, branch-write, run-finalization, and promise-settlement order; demonstrate the pre-fix failure (R1).
- [x] 2. Replace Promise.all with Promise.allSettled at the existing DAG wave seam; rethrow one reason by identity or multiple via ordered AggregateError before existing fulfilled-result handling (R1, R2).
- [x] 3. Extend the regression with injected branch-start, branch-finalize, and action-finalize failures; hold a sibling write pending and assert no next-wave action or post-settlement writes (R1, R2).
- [x] 4. Add reverse-completion-order multi-error, undefined-reason, run-finalization failure, and seeded-resume cases; retain fail/continue, skip, pause, dryRun, and success routing (R1–R3).
- [x] 5. Verify with the repository's bun run spur-check and bun run build. Use targeted assertion results during development; the global coverage configuration can fail partial-suite exits, so only the full gate certifies completion (R3).

### Solution

`packages/dual-workflow-engine/src/dag.ts` — the ready-wave dispatch barrier at the former `Promise.all` seam is now `Promise.allSettled` over the unchanged per-node callback (dag.ts:171). After the whole wave settles, fulfilled values and rejection reasons are separated in a single pass that preserves ready-node declaration order (dag.ts:232). Exceptions take precedence over result routing: exactly one rejection is rethrown with its original identity (any JS value, including `undefined`); multiple rejections throw `new AggregateError(reasons, 'DAG node execution failed')` (dag.ts:240). Throwing before the fulfilled-result loop also guarantees no subsequent wave is dispatched; zero rejections flows into the unchanged failed/paused/done routing. RunLifecycle (run-lifecycle.ts:267) remains the sole finalization owner and its combined-error tree is untouched. Both DagDriver.run and DagDriver.resume share the loop, so the barrier covers both entry paths with no extra code.

`packages/dual-workflow-engine/tests/dag.test.ts` — new `RecordingAdapter` (call-order recorder + injected finalize rejections/holds + refused failed-finalization) over the real `MemoryWorkflowPersistenceAdapter`; six barrier tests: deferred-guard drain with pre-finalize settle ordering, persistence-hook rejection with held sibling write (run pending while held, exact reason identity, no next wave), seeded-paused resume drain, declaration-order `AggregateError`, single non-Error/`undefined` reason identity, and refused failed-finalization staying combined by the existing `AggregateError([executionError, finalizeError])` contract. Falsification: reverting only dag.ts to `Promise.all` fails 4 of the new tests (drain, persistence-reject pendingness, resume drain, aggregation); restored, 14/14 pass.

Documented deviation: the collected `results` array uses a widened literal (`status` union + optional `error`) instead of the callback's discriminated union; behavior is identical and `res.error` stays reachable after the `failed` check.

### Testing

- `cd packages/dual-workflow-engine && bun test` — 530 pass / 0 fail (includes the 6 new barrier tests and the untouched 0100/0101 suites).
- `bun x tsc --noEmit` (dual-workflow-engine) — clean.
- `bun run spur-check` (worktree root, final change) — exit 0: Biome clean, per-package typecheck clean, all package tests green, `recommended-pre-check` + `recommended-post-check` rule presets pass (`--fail-on warning`).
- `bun run build` — exit 0, every package builds.
- Falsification probe: `git stash push -- src/dag.ts` (pre-fix `Promise.all`) → 4 new tests fail as designed; `git stash pop` → 14/14 dag tests pass. Pre-fix failure modes match the defect: `finalizeRun:failed` recorded while a started sibling's branch finalize was still held, and no `AggregateError` for multi-rejection waves.

### Review

| Severity | Finding | Disposition |
| --- | --- | --- |
| P3 | Post-barrier `results` array uses a widened literal union instead of the callback's four-member discriminated union, so `res.status === 'failed'` no longer narrows via discriminants | Accepted — behavior identical; `res.error` read stays guarded by the same status check; recorded as a documented deviation in Solution |
| P4 | A node callback rejection leaves its own `__dag__` ledger `saveBranchStart` row unsettled | Pre-existing, out of scope — Design excludes storage recovery and post-rejection ledger repair; 0104 owns recovery semantics |
| P4 | Multiple `step.outcome === 'fail'` nodes in one wave keep last-in-order `failureError` semantics | Pre-existing, by design — fulfilled-result routing preserved (R3) |

SECUA review of the final diff (src/dag.ts + tests/dag.test.ts): no P1/P2 findings. No suppression comments, no skipped tests, no drive-by refactors; the format pass touched only the new test file. Residual risk: a sibling action that never settles still blocks run completion exactly as a never-settling successful wave would (unchanged from the approved Design; timeout policy remains out of scope). Disposition: PASS — review findings are advisory/pre-existing; gate evidence is fresh.

### References

- ADR-013 (run lifecycle ownership) and ADR-034 (DAG mode) in docs/00_ADR.md.
- Feature C3; task 0093 (schema/validation context only, complete).
- Task 0105 (dependent scheduler work); task 0104 (separate recovery/pause work).
- packages/dual-workflow-engine/src/dag.ts:36 — run enters the shared loop.
- packages/dual-workflow-engine/src/dag.ts:47 — resume enters the same loop.
- packages/dual-workflow-engine/src/dag.ts:168 — current Promise.all barrier.
- packages/dual-workflow-engine/src/action-step.ts:115 — awaited audit finalization.
- packages/dual-workflow-engine/src/run-lifecycle.ts:267 — failure finalization after loop rejection.
- packages/dual-workflow-engine/src/run-lifecycle.ts:269 — existing combined-error contract.
- packages/dual-workflow-engine/tests/dag.test.ts:1 — real service/host/memory-adapter test layer.
- Environment audit 2026-10-07: Bun 1.3.14; installed zod 4.2.1, locked zod 4.4.3; implementation step 0 aligns them.
- Concurrency audit 2026-10-07: git worktree list shows one main worktree; spur task list --status wip --json returned [].

### History

- 2026-10-07T18:46:59.660Z backlog → todo (system)
- 2026-10-07T19:31:20.379Z todo → wip (system)
- 2026-10-07T19:55:10.395Z wip → testing (system)
- 2026-10-07T19:56:29.864Z testing → done (system)

