---
schema_version: 1
name: Make manual queue cancellation terminal when handlers reject
status: done
template: feature-impl
created_at: 2026-10-14T03:37:04.998Z
updated_at: "2026-10-14T04:57:24.532Z"
feature_id: D

priority: P2
ac_numbering: task-local
ac_altitude: task-local
estimate_hours: 2
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0112-verdict.json
---

## 0112. Make manual queue cancellation terminal when handlers reject

### Background

Review of packages and scripts reproduced a manual-cancellation defect. In `packages/infra/src/job-queue/db-job-queue.ts:360`, handler errors enter failOrRetry before the manual-cancellation branch at line 366. A handler rejecting when its signal aborts therefore returns the job to pending even though cancel() returned true. The in-session injected-DAO reproduction printed `cancel true` and `state pending`; maxRetries was 5 and batchSize was 1. The existing test at `packages/infra/tests/job-queue/lease-consumer.test.ts:175` resolves on abort and misses rejection. Feature D owns the consumer. This review separately fixed inherited decision-input properties and the rule-fixture test inventory; neither resolves this queue defect.

**Refine corrections (2026-10-13)**

- Branch reordering alone guarantees every accepted cancellation → cancel currently accepts an attempt after settlement while acknowledgement is pending (`packages/infra/src/job-queue/db-job-queue.ts:203`, `packages/infra/src/job-queue/db-job-queue.ts:341`) → require the settled guard and an acknowledgement-barrier regression.
- Coincident timeout precedence was a design-only assertion → R3 and a dedicated AC now require accepted manual cancellation to win, with handler settlement controlled by promises.
- Event assertions had no frozen consumer setup → eventSink requires queueName with events → freeze a nonblank queueName and real event bus/DAO setup, including a second immediate poll.
- Environment was assumed locked → Bun.resolveSync from packages/db/src resolves parent drizzle-orm 0.44.7 while bun.lock pins 0.38.4 → add a dependency-restoration Step 0 before implementation and verification.

**Verification correction (2026-10-13)**

The earlier dependency mismatch claim came from Bun.resolveSync with a relative base path. Fresh resolution using the absolute repository packages/db/src directory selects locked drizzle-orm 0.38.4 from this repository. bun install --frozen-lockfile reports no changes. The parent 0.44.7 result was a probe error, not the package runtime dependency. Implementation behavior and regression design are unchanged.

### Requirements

- [x] R1. A manual cancellation accepted before handler settlement becomes terminal failed after settlement, whether the handler resolves or rejects, without retrying. cancel() returns false once the handler is settled, including while acknowledgement is pending.
- [x] R2. Lost-lease fencing remains stronger than cancellation; stale attempts emit no completion, failure or retry events and do not change the replacement attempt's row.
- [x] R3. Ordinary handler errors and deadline expiry retain existing retry behavior; an accepted manual cancellation takes precedence over a coincident timeout. No public API or schema changes.

### Acceptance Criteria

```gherkin
Scenario: AC1 — Rejected abort becomes terminal failure (req: R1)
  Given a claimed job with maxRetries 5 and a handler that rejects on signal abort
  When cancel(jobId) returns true and processOnce settles
  Then the row is failed with a cancellation reason and cannot run on a later poll
  And exactly one failed event and no retry event are emitted

Scenario: AC2 — Lease loss fences cancelled attempts (req: R2)
  Given an attempt whose lease ownership is lost before acknowledgement
  When it is also manually cancelled and its handler settles
  Then no acknowledgement or terminal lifecycle event is applied by that attempt

Scenario: AC3 — Uncancelled errors and timeouts still retry (req: R3)
  Given jobs with retries available and no manual cancellation
  When a handler throws or its execution deadline expires
  Then existing retry and attempt-count tests still pass

Scenario: AC4 — Settled acknowledgement refuses late cancellation (req: R1)
  Given a resolved handler and markCompleted held before the real fenced write
  When cancel(jobId) is called while acknowledgement is pending
  Then it returns false
  And releasing the write completes the job without failure or retry events

Scenario: AC5 — Accepted cancellation takes precedence over timeout (req: R3)
  Given the deadline aborted a handler that is still held before settlement
  When cancel(jobId) returns true and the handler is released
  Then the job is terminal failed with cancellation reason and no retry event
```

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-14T03:38:01.443Z

Closed: accepted manual cancellation wins over handler errors and coincident timeout, after lease-loss fencing. No open design decisions.

#### Q&A entry — 2026-10-14T03:51:27.477Z

Closed in ready refinement: cancellation admission ends at handler settlement; accepted cancellation wins over timeout/errors; lease fencing remains first. Use barriers for handler/acknowledgement ordering. Locked dependency restoration is an implementation precondition, not an upgrade.

### Design

No new API. Targets: packages/infra/src/job-queue/db-job-queue.ts and packages/infra/tests/job-queue/lease-consumer.test.ts. Preserve the DBQueueConsumer/QueueConsumer signatures and the shared runWithExecutionDeadline implementation.

Algorithm: in DBQueueConsumer.cancel, return false if the active attempt is absent OR attempt.state.settled is true; otherwise set cancelled and abort synchronously as today. In processJob keep attempt.settled = true immediately after the awaited handler outcome, the lost-ownership early return first, then the existing fenced manual-cancellation markFailed/event block, then ordinary error/timedOut retry dispatch, then completion. An accepted manual cancellation wins over a coincident timeout or handler error. It still awaits settlement, retains lease ownership until settlement and preserves attempts, metrics, cleanup and token checks. No asynchronous gap is added between checking settled and setting cancelled.

Tests use the real in-memory QueueJobDao and existing EventBus<QueueEvents>, with events and a nonblank queueName on the consumer. Subscribe to queue.job.failed, queue.job.retrying and queue.job.completed. Coordinate handler start, abort observation and release with Promise.withResolvers rather than sleeps for ordering. Set batchSize: 1 and baseDelay/maxDelay: 0 so a second processOnce can expose an incorrectly retried job without timer assumptions. For the late-cancel test only, wrap markCompleted to signal entry and await a release promise before forwarding to the real DAO: cancel during that hold must return false, then completion must persist. For lease fencing, use existing token-replacement/renewal-loss patterns, hold the handler until cancellation and lease loss are both observed, then settle; assert unchanged replacement token/row and no lifecycle events. For timeout overlap, hold the handler after its signal aborts, accept manual cancellation before releasing it, then assert terminal cancellation; only the actual deadline clock needs time to advance.

Rejected alternatives: changing runWithExecutionDeadline (would change scheduler behavior); detecting cancellation from an error name (cannot distinguish manual cancellation and timeout); changing global DAO retry policy; changing acknowledgement after it has started (introduces a persistence race). Out of scope: scheduler policy, queue schema, cross-poll concurrency, cancellation of settled acknowledgements. Existing cancellation with a resolving handler remains supported.

Precondition: run bun install --frozen-lockfile and verify dependency resolution using the absolute packages/db/src directory. Fresh verification confirms Bun 1.4.3 and locked drizzle-orm 0.38.4; the earlier parent-directory mismatch was caused by a relative-base probe. Preserve manifests and lockfile. No unfinished dependencies; 0113 is independent. Workspace audit found only the main worktree and no wip tasks. Preserve current unrelated working-tree edits.

### Plan

- [x] Step 0: restore locked dependencies with bun install --frozen-lockfile; verify Bun 1.4.3 and drizzle-orm resolution from packages/db/src equals bun.lock, without changing manifests or lockfile.
- [x] Add failing regressions in packages/infra/tests/job-queue/lease-consumer.test.ts for an abort-rejecting handler and for cancellation while markCompleted is held; synchronize with promises and capture failed/retry/completed events (R1).
- [x] Add the settled guard in cancel and reorder processJob outcome dispatch after lease-loss fencing, retaining the cancellation persistence/event block (R1, R2).
- [x] Cover cancellation plus lost/replaced ownership and cancellation overlapping timeout; preserve ordinary-error, deadline and resolving-handler regressions (R2, R3).
- [x] Run bun test packages/infra/tests/job-queue, bun run spur-check and bun run build; record the final results against R1-R3.

### Solution

| File | Change and purpose |
|---|---|
| `packages/infra/src/job-queue/db-job-queue.ts:203` | Refuse cancellation once the attempt is settled, including its pending acknowledgement window. |
| `packages/infra/src/job-queue/db-job-queue.ts:363` | After lease-loss fencing, dispatch accepted cancellation before handler error/deadline outcomes, preserving fenced failure writes and event emission. |
| `packages/infra/tests/job-queue/lease-consumer.test.ts:385` | Real-DAO regression proves abort rejection becomes terminal failure with one failed event and no second-poll execution. |
| `packages/infra/tests/job-queue/lease-consumer.test.ts:421` | Replacement-token case proves a cancelled stale attempt cannot mutate its rival's row or emit lifecycle events. |
| `packages/infra/tests/job-queue/lease-consumer.test.ts:459` | A held acknowledgement proves late cancellation returns false and completion persists. |
| `packages/infra/tests/job-queue/lease-consumer.test.ts:498` | A held handler after deadline proves accepted cancellation wins over timeout. |

No public API, schema or dependency changes. Existing resolving-handler cancellation and ordinary error/deadline retry tests remain supported. Fresh verification corrects the former relative-base dependency probe; absolute package-local resolution matches the lockfile.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | Settled admission guard and terminal cancellation dispatch at `packages/infra/src/job-queue/db-job-queue.ts:203` and `packages/infra/src/job-queue/db-job-queue.ts:363`; executable rejecting-handler and held-ack regressions at `packages/infra/tests/job-queue/lease-consumer.test.ts:385` and `packages/infra/tests/job-queue/lease-consumer.test.ts:459` pass in the fresh full gate. |
| R2 | MET | Lease-loss early return at `packages/infra/src/job-queue/db-job-queue.ts:351` and fenced markFailed result at `packages/infra/src/job-queue/db-job-queue.ts:370`; real replacement-token and no-events regression at `packages/infra/tests/job-queue/lease-consumer.test.ts:421` passes. |
| R3 | MET | Ordinary error/deadline retry dispatch at `packages/infra/src/job-queue/db-job-queue.ts:383`; existing timeout retry at `packages/infra/tests/job-queue/lease-consumer.test.ts:58` and crash retry at `packages/infra/tests/job-queue/lease-consumer.test.ts:312` pass, as does manual-cancellation precedence at `packages/infra/tests/job-queue/lease-consumer.test.ts:498`. No public signatures or schema changes in the implementation commit. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| Scenario: AC1 — Rejected abort becomes terminal failure (req: R1) | MET | test | `packages/infra/tests/job-queue/lease-consumer.test.ts:385` — Rejecting abort produces terminal failed status, cancellation reason, exactly one failed event and no second-poll execution. Fresh full gate: 3015 pass, 0 fail. |
| Scenario: AC2 — Lease loss fences cancelled attempts (req: R2) | MET | test | `packages/infra/tests/job-queue/lease-consumer.test.ts:421` — Stolen ownership preserves the replacement token and processing row while emitting no lifecycle events. Fresh full gate: 3015 pass, 0 fail. |
| Scenario: AC3 — Uncancelled errors and timeouts still retry (req: R3) | MET | test | `packages/infra/tests/job-queue/lease-consumer.test.ts:58` — Existing deadline retry settles to pending then completes on retry; ordinary crash retry at packages/infra/tests/job-queue/lease-consumer.test.ts:312 reaches maxRetries. Fresh full gate: 3015 pass, 0 fail. |
| Scenario: AC4 — Settled acknowledgement refuses late cancellation (req: R1) | MET | test | `packages/infra/tests/job-queue/lease-consumer.test.ts:459` — Held acknowledgement refuses late cancellation and completes with exactly one completion event. Fresh full gate: 3015 pass, 0 fail. |
| Scenario: AC5 — Accepted cancellation takes precedence over timeout (req: R3) | MET | test | `packages/infra/tests/job-queue/lease-consumer.test.ts:498` — Deadline abort occurs while handler is held; accepted cancellation then settles to failed with cancellation reason and no retry event. Fresh full gate: 3015 pass, 0 fail. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

**Verdict: PASS** — reviewed inline (reviewer role, fresh eyes) against Requirements/AC; evidence from `git diff` at `sp/runall-0112-0113-4480` and the full test run.

**Requirement coverage:**

| Requirement | Evidence | Status |
|---|---|---|
| R1 terminal-on-reject | Dispatch precedence `attempt.cancelled` now precedes `outcome.outcome === 'error'` (`db-job-queue.ts:363`); AC1 test: rejecting handler after accepted cancel → `failed`, one `queue.job.failed`, second poll no-op | MET |
| R2 lease-loss fencing | `attempt.lost` branch stays first (`db-job-queue.ts:348`); AC2 test: token theft mid-run + cancel → fenced `markFailed` refuses, row/`attemptToken` unchanged, zero events | MET |
| R3 cancel beats timeout | `outcome.timedOut` moved below cancelled (`db-job-queue.ts:384`); AC5 test: deadline fired, handler held pre-settlement, cancel accepted → `failed` not retry | MET |
| Acceptance window | `cancel()` refuses settled attempts (`db-job-queue.ts:203`); AC4 test: cancel during pending `markCompleted` → `false`, job completes | MET |
| AC3 ordinary errors/timeouts still retry | Existing AC10 crash-retry and timeout-retry tests unchanged and green (43/43) | MET |

**Findings:**

| Priority | Location | Finding |
|---|---|---|
| P4 | packages/infra/src/job-queue/db-job-queue.ts:366 | Terminal policy intentionally discards the handler's rejection message in favor of `job cancelled`; per spec `event.error = 'job cancelled'` — by design, no action. |
| P4 | packages/infra/tests/job-queue/lease-consumer.test.ts:376 | AC2 passes pre-fix as well (fenced write already guards); retained as regression armor for the reordered precedence. |

Residual risk: none blocking. No `biome-ignore` added; no skips.

**Confidence:** HIGH

### References

- Readiness probes: `.spur/run/refineall-0112-0113-probes.ts`; executed this refinement, using disposable in-memory databases and injected queue I/O.
- Current work: only /Users/robin/xprojects/ts-libs on main; spur task list --status wip --json returned []; no declared dependencies and no dependency between 0112 and 0113.
- Runtime: Bun 1.4.3; TypeScript 6.0.3 and @types/bun 1.4.3 match bun.lock; Drizzle resolves to locked 0.38.4 when probed with the absolute packages/db/src directory; earlier relative-base evidence is superseded by the Verification correction.
- Original review: `.spur/run/review-packages-scripts-2026-10-13.md`.
- Feature D: docs/features/D_ts-infra.md. Existing failure branch: `packages/infra/src/job-queue/db-job-queue.ts:360`; settlement/cancel race: `packages/infra/src/job-queue/db-job-queue.ts:341` and `packages/infra/src/job-queue/db-job-queue.ts:203`.

Final pre-commit readiness:
- Task 0112 remains done; all requirements and acceptance criteria MET.
- Shippable: PASS — feature D check is clean and every linked task is done.
- Review-format gate and residual sweep pass; no blocking or deferred implementation work. P4 observations describe accepted intended behavior.
- Shipping receipt: `.spur/run/0112-shippable.json:1-29`.
- Fresh verdict and source answer: `.spur/run/0112-verdict.json`, `.spur/run/0112-verify-answer.txt`.
- Source code unchanged since the successful full gate (3015 tests) and build; no redundant runtime checks repeated for these evidence-only updates. No commit made.

### History

- 2026-10-14T03:38:14.089Z backlog → todo (system)
- 2026-10-14T04:06:55.142Z todo → wip (system)
- 2026-10-14T04:15:33.354Z wip → testing (system)
- 2026-10-14T04:15:44.234Z testing → done (system)

