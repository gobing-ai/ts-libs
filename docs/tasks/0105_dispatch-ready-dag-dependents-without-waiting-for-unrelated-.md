---
schema_version: 1
name: Dispatch ready DAG dependents without waiting for unrelated nodes
status: done
template: feature-impl
created_at: 2026-10-07T18:45:38.827Z
updated_at: "2026-10-07T21:52:34.625Z"
feature_id: C3

priority: P2
ac_numbering: task-local
ac_altitude: task-local
dependencies: ["0103", "0104"]
estimate_hours: 6
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/run/0105-verdict.json
---

## 0105. Dispatch ready DAG dependents without waiting for unrelated nodes

### Background

The current DAG loop dispatches ready nodes with Promise.all and recomputes readiness only after the entire wave settles (dag.ts:168). Independent fast/slow roots therefore delay a child depending only on fast until slow completes. Feature C3 and README describe prerequisite-driven readiness. The existing any-policy test uses a two-wave arrangement and cannot expose an unrelated blocked root in the same wave.

The implemented dependency helper already has a deliberate skip rule: all allows a mixed done/skipped set once every parent settles, any permits the first done parent, and all-skipped parents propagate skip. Successful host return is not durable completion: runActionStep still awaits action evidence, followed by the node's branch-finalization write. Both run and resume share this scheduler seam.

**Refine corrections (2026-10-07)**

- “Successful prerequisites” could imply changing mixed done/skipped joins → current helper explicitly permits mixed completed/skipped all joins → preserve that exact rule and test it.
- “Completion” could mean host return or early status mutation → audit and branch finalization remain asynchronous → publish readiness only after the full node promise durably settles.
- “Small in-flight set” omitted simultaneous settlements and fatal races → a wake-up can coincide with several results → attach immediate fulfillment/rejection observers, latch stop-dispatch on terminal outcomes, and consume all queued settlements before admission.
- “Drain on failure/pause” omitted errors already removed from the set → rejected reasons may be undefined and RunLifecycle nests finalization errors → retain every admitted outcome, drain on all exits, and apply the ordered error contract from 0103.
- “Retain variable and pause handling” assumed a changing upstream contract → 0104 freezes durable output/status and pause acknowledgement → add 0104 as a dependency and preserve its rules; scheduling owns no recovery redesign.
- Checkbox-only AC and no environment step → use bound Gherkin scenarios and explicit frozen-lockfile alignment before implementation.

Environment/concurrency audit 2026-10-07: Bun 1.3.14, installed zod 4.2.1 vs lock 4.4.3; one main worktree/no wip tasks. Unrelated infra/utils fixes and review artifacts remain intact. Task 0103 is todo, not implemented; 0104 is also todo. Readiness of this specification does not mean either prerequisite has shipped.

### Requirements

- [x] R1. On run and resume, admit each newly eligible DAG child immediately after its required node execution promises settle durably, without waiting for unrelated in-flight nodes. Preserve all/any and mixed done/skipped/all-skipped dependency semantics.
- [x] R2. Admit each node at most once per invocation. Once a thrown node exception, fail-policy result, or pause result is observed, stop admitting new nodes and drain all already-admitted node action/audit/branch writes before run finalization or public settlement.
- [x] R3. Preserve 0103's exact single-reason and declaration-ordered multi-reason error contract, including RunLifecycle finalization-error composition, and 0104's ledger restoration, variables, counts, pause acknowledgement, and replay safety. Keep skip propagation, continue policy, dryRun, FSM, and transition-flow behavior intact.

### Acceptance Criteria

```gherkin
Feature: Completion-driven DAG node admission

  Scenario: AC1 — Ready children start while an unrelated root is blocked (req: R1)
    Given independent fast and deferred roots and a child depending only on fast
    When fast finishes its action, audit, and branch-finalization write
    Then the child starts before the unrelated root is released
    And if fast's audit or branch write is still blocked the child does not start

  Scenario: AC2 — Any and all readiness use declared prerequisites (req: R1)
    Given two prerequisites with separately deferred completions
    When one durably completes
    Then an any child starts while an all child waits
    And mixed done and skipped all joins wait for every parent then proceed
    And all-skipped prerequisite chains propagate skip without deadlock

  Scenario: AC3 — Ready-queue termination drains and does not double dispatch (req: R2)
    Given simultaneous completions and one failed or paused node with a deferred sibling write
    When the terminal outcome is observed
    Then no further node is admitted and every admitted node settles before public settlement
    And each node starts at most once even after simultaneous prerequisite completions
    And no invocation-owned write lands after run finalization

  Scenario: AC4 — Existing modes and gates pass (req: R3)
    Given real driver tests including 0103 failure and 0104 recovery regressions
    When running the completion-driven loop
    Then their error, output, count, pause, replay, and dryRun contracts remain intact
    And FSM and transition-flow tests, the canonical gate, and build pass

  Scenario: AC5 — Terminal races preserve all errors (req: R2; R3)
    Given simultaneous success, pause or fail-policy result, and exception settlements
    When the scheduler drains admitted work
    Then exceptions take precedence over fail-policy results and pauses
    And one rejected reason is rethrown unchanged and multiple reasons are declaration-ordered
    And empty in-flight state terminates only after skip propagation reaches a fixed point
    And unresolved pending nodes fail loudly
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-07T19:14:45.237Z

- Decision: readiness observes the complete persisted node promise, never only host completion or a prematurely assigned status.
- Decision: preserve existing mixed done/skipped all joins and first-done any joins; skip propagation runs to a fixed point.
- Decision: a tagged observer immediately latches terminal admission stop; the coordinator alone dispatches children and always drains before routing.
- Decision: thrown exceptions outrank failed results and pauses; node errors retain 0103 ordering, with a coordinator error appended last if present.
- Decision: 0104 is an additional execution prerequisite. Its recovery/variable/count/pause policy is consumed intact; no new recovery design.
- Decision: no concurrency flags/framework/cancellation/timeouts. The existing unbounded in-process admission remains the ceiling.

### Design

No new API. WHAT/WHY: replace DAG waves with completion-driven admission while preserving durable settlement, error routing, and recovery. WHERE: packages/dual-workflow-engine/src/dag.ts, tests/dag.test.ts, and existing recovery regressions. Keep RunLifecycle, runActionStep, adapter methods, and the dependency helper's policy; no new scheduler module/class.

Frozen loop:
1. Restore ledger/status/variables and acknowledge pauses according to 0104. Maintain an in-flight map keyed by node id, an observed-settlement queue, retained outcomes keyed by declaration index, and a stopAdmission flag. These are loop-local state, not public types/options.
2. Scan pending/ready nodes in declaration order. Apply the existing readiness/skip policy to a fixed point, so backward-declared all-skipped chains settle without stranding nodes. An all child requires all parents settled done/skipped with at least one done and none failed. An any child needs one done and need not wait for other parents. If all parents are skipped, skip the child. Paused/running/pending parents are not successful prerequisites.
3. For each eligible node, synchronously mark it running before starting any await; this reserves its admission exactly once. Immediately attach both fulfilled and rejected observers to its entire execution promise. Execution includes condition, action, audit, terminal branch write, and status/output publication from 0104. A successful host return alone does not publish readiness. Node execution retains current live completion-order setVars merging; this task does not change variable conflict policy.
4. Observers enqueue a tagged outcome retaining node id, declaration index, value or original reason. A rejection, fail-policy result, or pause result latches stopAdmission immediately when observed. Observers fulfill their tracking promise even for a rejected node; use the discriminator, not reason truthiness. Never leave a raw rejection unobserved. Observers coordinate notification/stop state, not dependent dispatch.
5. The coordinator consumes every currently queued outcome, removing those entries from the in-flight map and retaining the outcome for final routing. Check stopAdmission before each new admission scan. Without a stop, admit newly eligible nodes; with none eligible and work in flight, Promise.race over tracking promises wakes the coordinator. Race is only notification, never public completion. Recheck the queue and stop flag after every wake-up so simultaneous fatal outcomes cannot be bypassed by a success.
6. When stopAdmission is set, admit no new nodes; await all remaining admitted tracking promises (Promise.allSettled is the drain barrier), consume their outcomes, and then route. Also drain on any coordinator/checkpoint exception before letting it escape; retain its reason alongside node failures without discarding earlier outcomes. Do not abort admitted actions or repair rejected writes.
7. Node exceptions outrank fulfilled fail-policy results, which outrank pauses. Rethrow one original node reason unchanged; multiple node reasons use AggregateError(reasons, 'DAG node execution failed') in workflow declaration order, including undefined/null. A coordinator-only exception is rethrown unchanged; if both coordinator and node exceptions exist, append the coordinator reason after declaration-ordered node reasons in the same aggregate. Keep RunLifecycle's existing nested finalize-error composition. For fulfilled fail results preserve the current declaration-order last-failure reason. For pause route the first outstanding pause in declaration order using 0104.
8. Completion requires no in-flight work, no outstanding pause/failure, skip propagation at a fixed point, and no pending/ready/running nodes. Preserve named dag-unreachable-nodes failure for unresolved pending nodes rather than reporting done. dryRun uses the same admission logic with actions/node persistence suppressed as before.

Inherited contracts/prerequisites: 0103 supplies the settlement/error contract and regression suite; 0104 supplies terminal write-before-readiness, ledger output/status restoration, caller precedence, distinct-node counts, per-node replay admission, and one-at-a-time pause acknowledgement. Both must be implemented before this task. Add the missing 0104 dependency; retain 0103. Do not reimplement recovery or weaken prior tests. No downstream task currently declared. The corpus dependency warning while prerequisites remain todo is an execution warning, not an invitation to bypass them.

Tests use real WorkflowService/DagDriver/RunLifecycle with memory persistence, plus the SQLite recovery cases from 0104. Deferred actions, audit writes, and branch writes provide observable signals; no fixed sleeps or mock lifecycle. A child-start signal must arrive while the unrelated root is held; a separate held producer-write case must show that the child cannot start yet. Always release deferred work in finally. Test all/any, reverse declaration-order skip chains, simultaneous completions, pause/fail/throw competition, multiple reasons and undefined, no post-finalization writes, continue policy, pause/resume and interruption fixtures, and dryRun. Include restored nodes in the exactly-once admission counter.

Implementation step 0 aligns installed zod 4.2.1 to locked 4.4.3 with bun install --frozen-lockfile; no dependency edits. One main worktree/no wip task conflicts; preserve unrelated changes.

### Plan

- [x] 0. Confirm 0103 and 0104 are done; run bun install --frozen-lockfile, check Bun 1.3.14 / zod 4.4.3 and same-file ownership, and preserve unrelated edits.
- [x] 1. Add deferred independent-root, producer-write, and all/any tests that expose the wave barrier without sleeps (R1).
- [x] 2. Keep the node execution chain intact while replacing waves with a loop-local in-flight map, tagged observers/queue, synchronous admission reservation, and completion-triggered readiness (R1, R2).
- [x] 3. Add stop-admission/drain behavior and declaration-ordered error retention; test simultaneous fatal/success outcomes and coordinator failure cleanup (R2, R3).
- [x] 4. Test fixed-point skip propagation, no duplicate admission, fail/continue, pauses, restored ledger nodes and counts, undefined/multiple reasons, dryRun, and no post-finalization writes (R1–R3).
- [x] 5. Run upstream 0103/0104 regressions and all existing driver tests, then bun run spur-check and bun run build; inspect the surgical diff (R3).

### Solution

The completion-driven coordinator uses loop-local in-flight tracking, tagged settlements, synchronous reservation, stop-admission and terminal drain (packages/dual-workflow-engine/src/dag.ts:476-577). This re-audit moves done/skipped/failed status publication to the fulfilled observer, after the whole node chain, and output/count publication after terminal persistence. The unrelated-completion/held-producer-write regression failed before correction and passes after (packages/dual-workflow-engine/tests/dag.test.ts:782). A coordinator-only exception now escapes unchanged after admitted work drains (packages/dual-workflow-engine/src/dag.ts:573; regression packages/dual-workflow-engine/tests/dag.test.ts:836). Fail/exception/pause precedence and declaration-order aggregates remain unchanged. No concurrency flag, cancellation, retry, new public type or scheduler abstraction was added.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | packages/dual-workflow-engine/src/dag.ts:460-550 publishes only durably settled status/output and admits without a layer barrier; packages/dual-workflow-engine/tests/dag.test.ts:731,755,782,865,894,921 covers independent wakeup, held write, all/any and fixed-point skips. Fresh full gate: 2861 pass, 0 fail. |
| R2 | MET | packages/dual-workflow-engine/src/dag.ts:476-577 reserves admission, latches stop, drains all admitted work, retains all causes, and rethrows a coordinator-only cause unchanged; packages/dual-workflow-engine/tests/dag.test.ts:836,942,977,1002,1017 proves coordinator identity, fatal drain, ordered errors and pause. Fresh full gate: 2861 pass, 0 fail. |
| R3 | MET | packages/dual-workflow-engine/tests/dag.test.ts:151,183,283,514 and packages/dual-workflow-engine/tests/recovery-regressions.test.ts:103-607 retain no replay, unreachable failure, dryRun, resume draining, variables, counts and ownership. No new scheduler class, flags, dependency or public API. Fresh full gate: 2861 pass, 0 fail. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: AC1 — Ready children start while an unrelated root is blocked (req: R1) | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:731,755,782 asserts early child dispatch with unrelated work held, and no child while producer terminal write is held during an unrelated wakeup. Fresh full gate: 2861 pass, 0 fail. |
| Scenario: AC2 — Any and all readiness use declared prerequisites (req: R1) | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:865,894,921 exercises any/all, mixed skipped/done joins and reverse-declared skip fixed point. Fresh full gate: 2861 pass, 0 fail. |
| Scenario: AC3 — Ready-queue termination drains and does not double dispatch (req: R2) | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:942,977,1017 plus packages/dual-workflow-engine/src/dag.ts:476-557 proves reservation, stop/drain and no dependent admission after terminal latch. Fresh full gate: 2861 pass, 0 fail. |
| Scenario: AC4 — Existing modes and gates pass (req: R3) | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:8-660 and packages/dual-workflow-engine/tests/recovery-regressions.test.ts:103-607 retains all previous mode/recovery/drain/output/count/pause/dryRun contracts; full gate and build passed. Fresh full gate: 2861 pass, 0 fail. |
| Scenario: AC5 — Terminal races preserve all errors (req: R2; R3) | MET | test | packages/dual-workflow-engine/tests/dag.test.ts:836,977,1002,1017 plus packages/dual-workflow-engine/src/dag.ts:564-600 proves coordinator identity, ordered exceptions including undefined, fail-before-pause and unreachable failure. Fresh full gate: 2861 pass, 0 fail. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

#### Review Report — 0105

**Scope:** working tree fallback (no exact task subject tag), restricted to this task's declared source/tests plus immediate callers; source and anchors reread this run.
**Dimensions:** functional, security, efficiency, correctness, usability, architecture.
**Verdict:** PASS

##### Findings

| Priority | Dimension | Location | Finding | Disposition |
| --- | --- | --- | --- | --- |
| P4 | all | packages/dual-workflow-engine/src/dag.ts:121-600 | No open P1-P3 findings: task requirements/AC trace to real-driver tests and the fresh full gate. | ACCEPTED |
| P2 | correctness | packages/dual-workflow-engine/src/dag.ts:460-482 | A held terminal write previously published readiness early; unrelated completions could admit a child. Publication now follows durable settlement; regression packages/dual-workflow-engine/tests/dag.test.ts:782 failed before correction and passes afterward. | RESOLVED |
| P2 | correctness | packages/dual-workflow-engine/src/dag.ts:573 | A coordinator-only error was wrapped; the original reason now escapes unchanged after drainage. Regression packages/dual-workflow-engine/tests/dag.test.ts:836 failed before correction and passes afterward. | RESOLVED |

##### Functional Traceability

| Req | Status | Evidence |
| --- | --- | --- |
| R1 | MET | packages/dual-workflow-engine/src/dag.ts:460-550 publishes only durably settled status/output and admits without a layer barrier; packages/dual-workflow-engine/tests/dag.test.ts:731,755,782,865,894,921 covers independent wakeup, held write, all/any and fixed-point skips. |
| R2 | MET | packages/dual-workflow-engine/src/dag.ts:476-577 reserves admission, latches stop, drains all admitted work, retains all causes, and rethrows a coordinator-only cause unchanged; packages/dual-workflow-engine/tests/dag.test.ts:836,942,977,1002,1017 proves coordinator identity, fatal drain, ordered errors and pause. |
| R3 | MET | packages/dual-workflow-engine/tests/dag.test.ts:151,183,283,514 and packages/dual-workflow-engine/tests/recovery-regressions.test.ts:103-607 retain no replay, unreachable failure, dryRun, resume draining, variables, counts and ownership. No new scheduler class, flags, dependency or public API. |

##### SECUA Quality

Replay admission remains before ownership claim; both entry points share the same helper. Nodes reserve admission once, publish only durable completion, and drained errors keep their reasons. No secrets, unbounded new buffers, new dependencies, suppressions or skipped tests were introduced. Existing fail/continue and lifecycle error composition remain intact. Historical accepted observations are maintained by the design: no timeout for nonsettling work, action failures use fail-policy results, and variable collisions follow durable live completion / stable topological recovery ordering.

##### Architectural Depth

No candidates: DAG validation, scheduling, ledger recovery and lifecycle finalization retain their existing seams. No production FSM/transition-flow or adapter-contract changes; ADR-034 remains satisfied. Historical wave and snapshot-shortcut descriptions are superseded explicitly in Solution by tasks 0104/0105. Driver dryRun suppression retains the shared terminal-pause write contract; ledger writes remain separate from action effects with marked at-least-once replay, as documented in README.

**Validation:** bun run spur-check exit 0, 2861 pass / 0 fail, 58 pre / 2 post rules; all package builds exit 0. Receipts .spur/run/c3-verifyall/spur-check.log and build.log.

### References

- Feature C3 ready-queue scope and scenarios R2/R3/R4; README.md describes prerequisite-driven dispatch.
- docs/00_ADR.md:664 — ADR-034; ADR-013 lifecycle ownership.
- Task 0103 (todo): exact error/drain contract; task 0104 (todo): recovery, durable publication, pause policy.
- packages/dual-workflow-engine/src/dag.ts:110 — dependency helper; :168 — wave barrier; :254 — branch write; :265 — terminal routing.
- packages/dual-workflow-engine/src/action-step.ts:115 — awaited action evidence.
- packages/dual-workflow-engine/src/run-lifecycle.ts:261 — shared error/finalization owner.
- packages/dual-workflow-engine/tests/dag.test.ts:208 — existing any test's two-wave arrangement; add independent-root/write-barrier cases here.
- Environment/concurrency 2026-10-07: Bun 1.3.14, installed zod 4.2.1 vs lock 4.4.3; one main worktree, no wip tasks.

### History

- 2026-10-07T19:14:49.671Z backlog → todo (system)
- 2026-10-07T20:26:31.873Z todo → wip (system)
- 2026-10-07T20:48:48.924Z wip → testing (system)
- 2026-10-07T20:49:02.877Z testing → done (system)

