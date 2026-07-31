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
updated_at: "2026-07-31T21:46:20.172Z"
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
`docs/00_ADR.md:337-371`.

**R2 — Node adapter retains in-flight ticks and drains under a shared deadline.**
- Shared `settleWithin(p, deadline)` primitive extracted to
  `packages/infra/src/internals/drain.ts:18-29` (was a private copy in
  `db-job-queue.ts`); `packages/infra/src/job-queue/db-job-queue.ts:11` now
  imports it, removing the duplicate. The extracted version is semantically
  identical to the copy it replaced (same `remaining <= 0` early return, same
  `clearTimeout` + `then(done, done)`); only `new Promise` became
  `Promise.withResolvers`.
- `NodeSchedulerAdapterConfig { drainTimeoutMs?: number }` added at
  `packages/infra/src/scheduler/node.ts:50-57`; the constructor (`:73-81`)
  validates it (`RangeError` on negative/non-finite) and defaults to `30_000`.
- `inflight = new Set<Promise<void>>()` field (`:71`) tracks ticks (unlike the
  queue consumer's single `pollPromise`, `setInterval` can stack overlapping
  ticks, so a `Set` is needed).
- `startEntry()` (`:121-136`) wraps the async handler in an arrow that captures
  the returned promise (`setInterval` otherwise discards it), adds it to the
  set, and removes it on settle via `tick.then(cleanup, cleanup)`
  (`_onScheduledTick` never rejects — it has a `try/catch`, `:141-148` — so the
  cleanup runs on both paths with no unhandled-rejection risk).
- `stop()` (`:102-119`) clears intervals first, then drains with a single
  shared absolute deadline `Date.now() + drainTimeoutMs` so the bound is not
  compounded per tick.
- `NodeSchedulerAdapterConfig` exported from the `/scheduler-node` subpath
  (`packages/infra/src/scheduler-node.ts:1`).

**R3 — Cloudflare is a deliberate no-op.**
`packages/infra/src/scheduler/cloudflare.ts:42-51` — `stop()` gains TSDoc: Cron
Triggers fire externally and `ctx.waitUntil()` already bounds each action, so
there is no in-flight handle to drain. `packages/infra/src/scheduler/types.ts:8-14`
— `SchedulerAdapter.stop()` carries the drain contract in its TSDoc.

**R4 — classified as `Fixed`, not breaking.** `stop()`'s signature is unchanged;
callers that already `await stop()` keep working. The only observable difference
is timing — `stop()` now blocks up to `drainTimeoutMs` instead of resolving
immediately while a tick runs on. Recorded under `### Fixed` in
`CHANGELOG.md:30`.

**Known limitation (not repaired here — see 0059).** `drainTimeoutMs` is
reachable only by constructing the adapter directly. The bootstrap path
`packages/infra/src/application-node.ts:273` hardcodes `new NodeSchedulerAdapter()`
and unconditionally overwrites a caller-supplied `SchedulerOptions.adapter`
(`packages/infra/src/application/types.ts:82`), so the bound is not configurable
through `createNodeApplication`. Pre-existing behaviour; that file is untouched
by this change.
### Testing
`packages/infra/tests/scheduler-node.test.ts` — 4 tests (+1 pre-existing subpath smoke):

- **R2 — `stop()` waits for an in-flight tick before resolving** (`:34-69`): registers a
  slow action that blocks on a `Promise.withResolvers` gate; starts the scheduler; awaits
  the action's `started` signal; asserts `stop()` has not resolved after microtask settling
  while the tick is blocked; then releases the gate and asserts the action completed before
  `stop()` resolved. The 5 ms cron stacks several gated ticks, so this also exercises the
  `Set<Promise<void>>` (vs. the queue consumer's single handle).
- **R2b — the drain wait is bounded when an action hangs** (`:71-98`): registers an action
  that awaits an unresolved promise; uses a low `drainTimeoutMs: 50`; asserts `stop()`
  resolves in `[40, 2000)` ms. Documented exception to `ts-no-test-timers`: `settleWithin`
  enforces its deadline with a real `setTimeout`, so the bound is only observable against
  the real clock.
- **constructor rejects an invalid `drainTimeoutMs`** (`:100-104`): `RangeError` on `-1`,
  `Infinity`, `NaN`.
- **default `drainTimeoutMs` keeps the no-arg path backward compatible** (`:106-109`): the
  bare `new NodeSchedulerAdapter()` constructor still works (the shape
  `packages/infra/src/application-node.ts:273` uses).

**Per-Requirement Traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 — decide + record `stop()` contract (dated ADR + TSDoc) | MET | ADR-024 `docs/00_ADR.md:337-371` (Status Accepted · Date 2026-07-31 · Amends ADR-014); TSDoc on `SchedulerAdapter.stop()` `packages/infra/src/scheduler/types.ts:8-14` states drain + bound + abandon-at-deadline |
| R2 — Node retains in-flight ticks; `stop()` awaits, bounded, reusing the proven shape | MET | `inflight` Set `packages/infra/src/scheduler/node.ts:71`; tick capture `:128-135`; `stop()` drain `:102-119` with one shared absolute deadline `:115`; `settleWithin` extracted to `packages/infra/src/internals/drain.ts:18-29` and imported by both `packages/infra/src/scheduler/node.ts:6` and `packages/infra/src/job-queue/db-job-queue.ts:11` (no second mechanism); config + `RangeError` validation `:50-57,73-81`, default `30_000` |
| R3 — Cloudflare behavior explicit under the same contract | MET | `packages/infra/src/scheduler/cloudflare.ts:42-51` TSDoc: deliberate no-op, rationale (Cron Triggers fire externally; `ctx.waitUntil()` already bounds each action), cites ADR-024; corroborated by ADR-024 § Cloudflare adapter |
| R4 — compat assessed + recorded under the correct CHANGELOG heading | MET | `CHANGELOG.md:30` under `### Fixed` (heading `:27`, next heading `### Security` `:34`); verdict = fix not breaking (signature unchanged; only timing observable), corroborated by ADR-024 § Compatibility |
| R5 — two regression tests, each failing against unfixed source, no `.skip` | MET | `packages/infra/tests/scheduler-node.test.ts:34-69` + `:71-98`; falsification re-run this session against `8cb038e~1` in a detached worktree — see command evidence below; no `.skip` in file |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| R1 — The stop() contract is decided and recorded | MET | static | `docs/00_ADR.md:337-371` (dated entry); `packages/infra/src/scheduler/types.ts:8-14` (matching TSDoc) |
| R2 — stop() waits for a tick already executing | MET | test | `packages/infra/tests/scheduler-node.test.ts:34-69` — asserts `stopResolved === false` while gated, `actionCompleted === true` once resolved. Second clause ("no action body runs after stop() resolved") holds structurally: `clearInterval` precedes the drain (`packages/infra/src/scheduler/node.ts:104-109`) and every retained tick is awaited — with the documented carve-out that a tick abandoned at the deadline (R2b path) does continue |
| R2b — The drain wait is bounded | MET | test | `packages/infra/tests/scheduler-node.test.ts:71-98` — `stop()` resolves in `[40, 2000)` ms against `drainTimeoutMs: 50` |
| R3 — The Cloudflare adapter's behavior is explicit | MET | static | `packages/infra/src/scheduler/cloudflare.ts:42-51` — documented deliberate no-op with rationale, not silent divergence |
| R4 — Compatibility impact is recorded | MET | static | `CHANGELOG.md:30` under `### Fixed`; config addition also noted at `CHANGELOG.md:16` under `### Added` |
| R5 — Regression tests fail without the fix | MET | command | Independent falsification, this session: `git worktree add <scratch> 8cb038e~1`, new test file copied in, `bun test packages/infra/tests/scheduler-node.test.ts` → `2 pass, 3 fail`; R2 failed `Expected: false / Received: true` (`:62`), R2b failed `Expected: >= 40 / Received: 0` (`:93`). Worktree removed; `git status` clean |

**Verification (re-run this session, 2026-07-31)**

```
bun test packages/infra/tests/scheduler-node.test.ts packages/infra/tests/internals/drain.test.ts
    # 9 pass, 0 fail, 15 expect() calls
bun test packages/infra                # 314 pass, 0 fail
bun run spur-check                     # clean — Biome + per-pkg tsc + both rule presets
                                       #   (recommended-pre-check, recommended-post-check
                                       #    incl. coverage-gate + every-export-has-tsdoc)
                                       #   1705 pass, 0 fail across 173 files
bun run build                          # all 8 packages exit 0
git worktree add <scratch> 8cb038e~1   # R5 falsification: 2 pass, 3 fail against unfixed source
```

Coverage (`bun test packages/infra`), measured this session — bun reports **% Funcs / % Lines**
(not branch): `src/internals/drain.ts`, `src/scheduler/node.ts`, `src/scheduler/cloudflare.ts`,
`src/scheduler-node.ts`, `src/scheduler-cloudflare.ts` — all **100.00 / 100.00**.

**Verify verdict: PASS** — 5/5 requirements MET, 6/6 AC MET, no blocker and no unresolved major
finding. Design conformance: ADR-024 is the design record (the `### Design` section is empty by
template); all 6 of its claims classify DONE, no silent deviation.

Findings from this re-audit and their disposition:

1. **Repaired.** `### Solution` line anchors were systematically off by one against the
   committed source — `:70`→`:71` (`inflight`), `:72-80`→`:73-81` (constructor),
   `:120-135`→`:121-136` (`startEntry`), `:101-118`→`:102-119` (`stop()`),
   `:140-147`→`:141-148` (`_onScheduledTick`). The subject was present in every cited range,
   so no row was failed. `### Solution` has been rewritten with corrected, project-root-relative
   anchors; `spur task check 0058 --strict-core` now reports no stale-anchor warnings.
2. **Repaired.** The prior `## Testing` coverage line claimed "100% line / 100% branch"; bun
   measures **Funcs/Lines**, not branch. Restated above against what was actually measured.
3. **Advisory, no action** (`packages/infra/src/scheduler/node.ts:116-118`): a tick abandoned
   at the deadline stays in `inflight` until it eventually settles, so a later
   `start()`/`stop()` cycle re-awaits it against the new deadline. Bounded, so it cannot hang
   shutdown — recorded as known behaviour, not a defect.
4. **Deferred to 0059** (pre-existing, out of 0058's scope — `application-node.ts` is untouched
   by commit `8cb038e`): the bootstrap path hardcodes `new NodeSchedulerAdapter()` at
   `packages/infra/src/application-node.ts:273` and unconditionally overwrites a caller-supplied
   `SchedulerOptions.adapter` (`packages/infra/src/application/types.ts:82`), so both the
   documented injection point and the ADR-024 `drainTimeoutMs` bound are unreachable through
   `createNodeApplication`. `CHANGELOG.md:16`'s "configurable without injecting a whole adapter"
   holds for direct construction only. Filed as task 0059 with requirements and AC; the
   `### Solution` section links it as a known limitation.

`feature_id` remains null: the only defined features are `A` (Grok coding agent) and `B` (System
Events observability), neither of which covers scheduler shutdown. The residual L4 advisory is
accepted rather than cleared with a false link.

Artifacts written by this verify run (both gitignored, disclosed per the fix-pass disclosure
rule): `.spur/run/0058-verdict.json` — full verdict, per-requirement and per-AC rows;
`.spur/run/0058-fix-created.json` — follow-up ledger recording 0059. No source, test, CHANGELOG,
or ADR file was modified by this re-audit — the only tracked changes are this task file's
`### Solution` / `## Testing` sections and the new `docs/tasks/0059_*.md`.
### Review
Independent review (`/sp:dev-verify 0058 --focus all`, review dimension), 2026-07-31. Reviewer is
not the implementer. Scope: commit `8cb038e` — `packages/infra/src/internals/drain.ts` (new),
`scheduler/node.ts`, `scheduler/cloudflare.ts`, `scheduler/types.ts`, `scheduler-node.ts`,
`job-queue/db-job-queue.ts`, tests, `CHANGELOG.md`, `docs/00_ADR.md`.

| Priority | Finding | Disposition |
|---|---|---|
| P1 | None. | — |
| P2 | None. | — |
| P3 | `### Solution` line anchors were systematically off by one against the committed source (`:70`→`:71`, `:72-80`→`:73-81`, `:120-135`→`:121-136`, `:101-118`→`:102-119`, `:140-147`→`:141-148`), and the coverage line claimed "100% branch" where bun measures Funcs/Lines. | **Fixed** — `### Solution` and `## Testing` rewritten with corrected, project-root-relative anchors and the metric actually measured. `spur task check --strict-core` now reports no stale-anchor warnings. |
| P3 | The `settleWithin` extraction also rewired `db-job-queue.ts`'s shutdown path — the highest blast-radius part of the change, since it touches a *different* adapter's drain. | **Verified equivalent** — diffed the extracted `internals/drain.ts:18-29` against the private copy it replaced: identical `remaining <= 0` early return, identical `clearTimeout` + `then(done, done)`. Only `new Promise` → `Promise.withResolvers`. No behaviour change smuggled into the queue consumer. |
| P4 | A tick abandoned at the drain deadline stays in `inflight` until it eventually settles (`packages/infra/src/scheduler/node.ts:116-118`), so a later `start()`/`stop()` cycle re-awaits it against the new deadline. | **Accepted** — bounded by the shared absolute deadline, so it cannot hang shutdown. Recorded as known behaviour, not a defect. |
| P3 | `packages/infra/src/application-node.ts:273` hardcoded `new NodeSchedulerAdapter()` and overwrote a caller-supplied `SchedulerOptions.adapter`, making the new `drainTimeoutMs` bound unreachable from `createNodeApplication`. Pre-existing — that file is untouched by `8cb038e` — but surfaced by this work. | **Filed and since fixed** — raised as task 0059, implemented in commit `1360313` (`schedulerOpts.adapter ?? new NodeSchedulerAdapter()` + `entries` forward), independently verified PASS. |

**Architecture.** The `internals/drain.ts` extraction is the right call: it removes a genuine
duplicate rather than inventing an abstraction, documents *why* it exists, and is deliberately not
re-exported from the package barrel (`internals/drain.ts:1-9`) so consumers depend on adapter
behaviour rather than the helper. `Set<Promise<void>>` over the queue consumer's single
`pollPromise` is justified and documented — `setInterval` can stack ticks when action duration
exceeds the interval, which the R2 regression test actually exercises (a 5 ms cron against a gated
action). The single shared absolute deadline in `stop()` is the correct shape; a per-tick duration
bound would compound.

**Security / efficiency / usability.** No secrets, no injection surface, no untrusted input.
`settleWithin` allocates one timer per in-flight promise, bounded by tick stacking — not a concern
at this scale. `RangeError` names both the field and the received value. TSDoc is present on the
config, the class, `stop()`, and the `SchedulerAdapter` interface, and the Cloudflare divergence is
documented rather than silent — which was the explicit ask in R3.

**Cross-adapter consistency.** `SchedulerAdapter.stop()`'s contract (`scheduler/types.ts:8-14`) and
both implementations agree: Node drains under a bound, Cloudflare is a stated no-op with rationale.
ADR-024 records the decision and the rejected alternative. No silent divergence remains.

**Residual risk:** none material. `stop()`'s signature is unchanged and the no-tick path is
unaffected; the only observable difference is timing, which `Application`'s documented
reverse-fan-out shutdown already assumed it had.

**Final disposition: APPROVED** — verdict PASS, 5/5 requirements MET, 6/6 AC MET. All P3 findings
are fixed or resolved; the sole P4 is accepted as documented behaviour.
### References

<!-- Links to failing logs, related issues, tasks, docs, or external references. -->

### History
