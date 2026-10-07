---
schema_version: 1
name: Dispatch ready DAG dependents without waiting for unrelated nodes
status: done
template: feature-impl
created_at: 2026-10-07T18:45:38.827Z
updated_at: "2026-10-07T20:49:02.888Z"
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

- `packages/dual-workflow-engine/src/dag.ts:367` — completion-driven admission replaces wave dispatch: loop-local loop-local `inFlight`/tracking map, tagged settlement queue, declaration-indexed outcomes, and `stopAdmission` latch (dag.ts:359-375).
- `packages/dual-workflow-engine/src/dag.ts:376` — `executeNode` keeps the per-node chain intact (ledger start → guard/condition → action+audit → pause-after-evidence → terminal branch finalize); readiness publishes only when the whole node promise settles (AC1b: a held terminal write blocks child dispatch).
- `packages/dual-workflow-engine/src/dag.ts:476` — `admit()` synchronously reserves `running` (exactly-once; also admits ledger-restored `ready` nodes) and attaches fulfilled+rejected observers that never reject; reject/fail/pause latches stop-admission immediately.
- `packages/dual-workflow-engine/src/dag.ts:548` — settlements consumed into the declaration-indexed outcomes array; readiness + skip propagation scan runs to a fixed point in declaration order (backward-declared all-skipped chains settle); `Promise.race` over tracking promises is notification-only.
- `packages/dual-workflow-engine/src/dag.ts:506` — stop latch triggers a `Promise.allSettled` drain barrier so every admitted action/audit/branch write lands before finalization; coordinator exceptions drain and retain outcomes instead of discarding them.
- `packages/dual-workflow-engine/src/dag.ts:558` — unified 0103 routing on the new scheduler: single node exception rethrown unchanged, multiple reasons (plus any coordinator reason, appended last) aggregated via `AggregateError('DAG node execution failed')` in declaration order (undefined retained); fail results keep declaration-order last-failure; pauses surface through the existing next-pause barrier.

### Testing

- New suite `DagDriver — completion-driven admission (task 0105)` in `packages/dual-workflow-engine/tests/dag.test.ts` (9 tests): AC1 deferred independent root (child dispatches while slow root gated), AC1b held terminal branch write blocks child, AC2 any/all join policies, AC2b mixed done/skipped all-join, AC2c backward-declared all-skipped fixed point, AC3 latch+drain with guard exception vs fail result, AC3b declaration-order AggregateError incl. undefined reason, AC3c fail-policy last-error routing, AC4 pause latch without child dispatch. All pass.
- Package: `bun test` — 544 pass / 0 fail / 31 files (includes 0103 wave-drain suite and 0104 recovery regressions: anchor, ledger restore, ack exactly-once, rerun-enter, CAS race, SQLite parity).
- Falsification (R2 non-vacuous): `git stash push -- packages/dual-workflow-engine/src/dag.ts` → dag suite fails pre-fix (1 fail / 1 error, module surface absent); popped cleanly, all green post-fix.
- `bunx tsc --noEmit` clean; `bun run spur-check` EXIT=0 (4 Biome `noTemplateCurlyInString` findings in recovery-regressions.test.ts fixed as escaped backtick literals — no suppressions); `bun run build` EXIT=0.

### Review

| Severity | Finding | Disposition |
|----------|---------|-------------|
| P1 | None. | — |
| P2 | None. | — |
| P3 | Action exceptions never reject the node promise — `runActionStep` converts them to fail-policy results (`packages/dual-workflow-engine/src/action-step.ts:112`); "node exceptions" per 0103 are guard/persistence/lifecycle rejections. | Documented; tests cover both surfaces (AC3 guard throw, AC3c fail results). Pre-existing engine contract, unchanged. |
| P3 | Live `vars` merge across concurrently admitted siblings is completion-order (not declaration-order-within-wave). | Accepted per Design: no variable conflict-policy change; child admission still observes parent's merged vars because readiness publishes only after the parent settles. |
| P4 | `Promise.race` is notification-only; routing re-checks settlement queue and stop latch at the loop top, so simultaneous fatal outcomes cannot be bypassed by a success. | Verified by AC3/AC3b. |
| P4 | `dag-unreachable-nodes` failure and stuck detection unchanged (post-loop status scan). | Covered by existing dag tests. |

Residual risk: none known. Final disposition: PASS — implementation matches the frozen design; all gates green.

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

