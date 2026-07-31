---
template: issue
schema_version: 1
name: "NodeSchedulerAdapter.stop() abandons in-flight scheduled actions"
description: ""
status: done
type: issue
profile: standard
feature_id: null
parent_wbs: null
priority: P2
tags: ["bug"]
dependencies: []
created_at: "2026-07-31T19:37:58.852Z"
updated_at: "2026-07-31T21:03:09.945Z"
---

## 0058. NodeSchedulerAdapter.stop() abandons in-flight scheduled actions

### Background
Found by `/sp:dev-review packages --focus all` (2026-07-31), during the sweep that also produced the
`DBQueueConsumer.stop()` drain-race fix. Surfaced as a sibling of that defect but deliberately **not**
fixed in the same change, because the remedy alters a public interface rather than repairing a broken
promise.

`NodeSchedulerAdapter` starts each entry with `setInterval(this._onScheduledTick.bind(this, entry), interval)`
(`packages/infra/src/scheduler/node.ts:89`). `_onScheduledTick` is `async` (`:92`), so every tick is
launched as a floating promise with no retained handle. `stop()` (`:76-84`) sets `running = false` and
clears each `entry.timer`, then resolves — it has no way to observe, let alone await, a tick already
executing.

Consequence: `await scheduler.stop()` resolves while a scheduled action is mid-execution. `Application`
documents shutdown as a deterministic reverse fan-out that includes scheduler stop
(`packages/infra/src/application/index.ts:82-84`), so `await app.stop()` followed by process exit can
tear down an action partway — a torn DB write or a half-flushed batch.

**Why this was separated from the queue fix.** The queue consumer made a *false claim*: it emitted
`queue.consumer.stopped` with `drained: true` while work continued, so restoring truthfulness was a
pure bug fix. `SchedulerAdapter.stop()` claims only "stop scheduling" — no counter, no drain timeout,
no drained flag. Adding a drain is a **new guarantee** on a two-implementation public interface
(`scheduler/node.ts`, `scheduler/cloudflare.ts`) that makes `stop()` newly blocking for existing
callers. That is an API decision, not a defect repair.
### Requirements
R1. Decide and record the `SchedulerAdapter.stop()` contract — does it drain in-flight ticks, or is
abandoning them the documented behavior? This is the gating decision; R2–R5 apply only if draining is
chosen. Because `SchedulerAdapter` is a public two-implementation interface, record the outcome as a
dated `docs/00_ADR.md` entry (ADR-014 governs the ts-infra subpath/adapter split this touches).

R2. If draining: `NodeSchedulerAdapter` retains in-flight tick promises and `stop()` awaits them,
bounded by a configurable timeout — mirror the `drainTimeoutMs` + `settleWithin` shape already proven
in `packages/infra/src/job-queue/db-job-queue.ts:126-135,305-322` rather than inventing a second
mechanism. A stuck action must not block shutdown indefinitely.

R3. If draining: define `CloudflareSchedulerAdapter`'s behavior under the same contract
(`packages/infra/src/scheduler/cloudflare.ts`). Workers' execution model may make draining a no-op or
`waitUntil`-shaped; either is acceptable if stated explicitly — silent divergence between the two
adapters is not.

R4. Backward compatibility — `stop()` becoming blocking is observable to existing callers, notably
`Application`'s reverse fan-out teardown. Assess whether this is a breaking change for
`@gobing-ai/ts-infra` consumers and record the verdict in `CHANGELOG.md` under the correct heading.

R5. Tests — a regression test proving `stop()` waits for an in-flight tick, and a second proving the
wait is bounded when an action hangs. Mirror the pair added for the queue consumer in
`packages/infra/tests/job-queue/db-job-queue.test.ts:167-241` (race regression + timeout bound). Each
test must fail against the unfixed source; no `.skip`.
### Acceptance Criteria
```gherkin
Feature: SchedulerAdapter.stop() has a stated, tested in-flight contract

  Scenario: R1 — The stop() contract is decided and recorded
    Given SchedulerAdapter is a public interface with a Node and a Cloudflare implementation
    When the contract decision is made
    Then a dated docs/00_ADR.md entry states whether stop() drains in-flight ticks or abandons them
    And SchedulerAdapter.stop() carries TSDoc matching that decision

  Scenario: R2 — stop() waits for a tick already executing
    Given a registered action that is mid-execution when stop() is called
    When await scheduler.stop() resolves
    Then the action has completed
    And no action body runs after stop() has resolved

  Scenario: R2b — The drain wait is bounded
    Given a registered action that never settles
    When stop() is called
    Then stop() resolves within the configured drain timeout rather than hanging

  Scenario: R3 — The Cloudflare adapter's behavior is explicit
    Given the same contract applies to both adapters
    When CloudflareSchedulerAdapter.stop() is inspected
    Then its in-flight behavior is implemented or documented as a deliberate no-op

  Scenario: R4 — Compatibility impact is recorded
    Given stop() may become blocking for existing callers
    When the change is released
    Then CHANGELOG.md records it under Fixed or Breaking Changes per the assessed impact

  Scenario: R5 — Regression tests fail without the fix
    Given the two new scheduler tests
    When they run against the unfixed source
    Then each fails, and each passes against the fixed source
```
### Q&A

<!-- Clarifications and triage decisions. Keep empty if none. -->

### Design

<!-- Fix approach and tradeoffs. Keep this short unless the issue changes architecture. -->

### Plan

<!-- Ordered debugging/fix checklist. Fill before moving to todo/wip. -->

### Root Cause
`setInterval` at `packages/infra/src/scheduler/node.ts:89` invokes an `async` handler
(`_onScheduledTick`, `:92`) and discards the returned promise. Nothing holds a reference to the
executing tick, so the adapter has no handle to await.

`stop()` (`:76-84`) therefore drains nothing it cannot see: it flips `running = false` and calls
`clearInterval` on each `entry.timer`, which prevents *future* ticks but has no effect on one already
running. `clearInterval` on an interval whose callback is currently executing is a no-op for that
execution.

Identical in shape to the `DBQueueConsumer` drain race fixed alongside this ticket — async work
launched from a timer with no retained handle — and the same remedy applies (retain the promise,
await it under a bound). The two differ only in blast radius: the consumer additionally *asserted* a
clean drain via `queue.consumer.stopped`, whereas the scheduler makes no claim at all.
### Solution

**R1 — drain, not abandon.** `Application.performShutdown` is a documented
deterministic reverse fan-out that includes scheduler stop
(`packages/infra/src/application/index.ts:82-84`); abandoning a mid-flight tick
would tear down a half-written row or half-flushed batch. Recorded as ADR-024 in
`docs/00_ADR.md`.

**R2 — Node adapter retains in-flight ticks and drains under a shared deadline.**
- Shared `settleWithin(p, deadline)` primitive extracted to
  `packages/infra/src/internals/drain.ts` (was a private copy in
  `db-job-queue.ts`); `db-job-queue.ts` now imports it, removing the duplicate.
- `NodeSchedulerAdapterConfig { drainTimeoutMs?: number }` added at
  `packages/infra/src/scheduler/node.ts:50-57`; the constructor (`:72-80`)
  validates it (`RangeError` on negative/non-finite) and defaults to `30_000`.
- `inflight = new Set<Promise<void>>()` field (`:70`) tracks ticks (unlike the
  queue consumer's single `pollPromise`, `setInterval` can stack overlapping
  ticks, so a `Set` is needed).
- `startEntry()` (`:120-135`) wraps the async handler in an arrow that captures
  the returned promise (`setInterval` otherwise discards it), adds it to the
  set, and removes it on settle via `tick.then(cleanup, cleanup)`
  (`_onScheduledTick` never rejects — it has a `try/catch`, `:140-147` — so the
  cleanup runs on both paths with no unhandled-rejection risk).
- `stop()` (`:101-118`) clears intervals first, then drains with a single
  shared absolute deadline `Date.now() + drainTimeoutMs` so the bound is not
  compounded per tick.
- `NodeSchedulerAdapterConfig` exported from the `/scheduler-node` subpath
  (`packages/infra/src/scheduler-node.ts`).

**R3 — Cloudflare is a deliberate no-op.** `cloudflare.ts` `stop()` gains TSDoc:
  Cron Triggers fire externally and `ctx.waitUntil()` already bounds each
  action, so there is no in-flight handle to drain. `types.ts`
  `SchedulerAdapter.stop()` carries the drain contract in its TSDoc.

**R4 — classified as `Fixed`, not breaking.** `stop()`'s signature is unchanged;
callers that already `await stop()` keep working. The only observable difference
is timing — `stop()` now blocks up to `drainTimeoutMs` instead of resolving
immediately while a tick runs on. Recorded under `### Fixed` in `CHANGELOG.md`.

### Testing

`packages/infra/tests/scheduler-node.test.ts` — 4 tests:

- **R2 — `stop()` waits for an in-flight tick before resolving**: registers a
  slow action that blocks on a `Promise.withResolvers` gate; starts the
  scheduler; awaits the action's `started` signal; asserts `stop()` has not
  resolved after microtask settling while the tick is blocked; then releases
  the gate and asserts the action completed before `stop()` resolved.
- **R2b — the drain wait is bounded when an action hangs**: registers an action
  that awaits an unresolved promise; uses a low `drainTimeoutMs: 50`; asserts
  `stop()` resolves in `[40, 2000)` ms (near the 50 ms deadline). This is the
  documented exception to `ts-no-test-timers`: `settleWithin` enforces its
  deadline with a real `setTimeout`, so the bound is only observable against the
  real clock.
- **constructor rejects an invalid `drainTimeoutMs`**: `RangeError` on `-1`,
  `Infinity`, `NaN`.
- **default drainTimeoutMs keeps the no-arg path backward compatible**: the
  bare `new NodeSchedulerAdapter()` constructor still works.

Coverage (bun test --coverage, packages/infra): `src/internals/drain.ts`,
`src/scheduler/node.ts`, `src/scheduler/cloudflare.ts`, `src/scheduler-node.ts`,
and `src/scheduler-cloudflare.ts` all at 100% line / 100% branch.

Verification:
```
bun test packages/infra/tests/scheduler-node.test.ts   # 5 pass (incl. smoke), 0 fail
bun test packages/infra/tests/internals/drain.test.ts   # 4 pass, 0 fail
bun test packages/infra                                   # 314 pass, 0 fail
bun run spur-check                                        # clean (Biome + per-pkg tsc + 49 rules + coverage-gate)
bun run build                                             # all 8 packages clean
```

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

<!-- Links to failing logs, related issues, tasks, docs, or external references. -->

### History
