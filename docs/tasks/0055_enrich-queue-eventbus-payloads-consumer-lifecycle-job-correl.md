---
template: feature-impl
schema_version: 1
name: "Enrich queue.* EventBus payloads (consumer lifecycle + job correlators) for System Events observability"
description: ""
status: todo
type: task
profile: standard
feature_id: B
parent_wbs: null
priority: P1
tags: []
dependencies: []
created_at: "2026-07-30T05:14:49.527Z"
updated_at: "2026-07-30T05:18:12.537Z"
---

## 0055. Enrich queue.* EventBus payloads (consumer lifecycle + job correlators) for System Events observability

### Background
Spur's Observability **System Events** tab (consumer monorepo `spur-new`) persists and
renders every cataloged EventBus event via the system-event tap. For `queue.*` rows the
operator currently sees:

| Symptom in System Events UI | Root cause in `@gobing-ai/ts-infra` (this repo) |
| --------------------------- | ---------------------------------------------- |
| `queue.consumer.started` / `queue.consumer.stopped` rows have **empty / null payload** | Emit calls pass **no detail argument** |
| Actor column always `unavailable` for queue rows | Queue producers never set `actor` / `agentId` / `memberId` (acceptable — infra events are not person-attributed; out of scope unless we introduce an optional correlator later) |
| `queue.job.enqueued` / `completed` only show bare `{ jobId, type }` | Contract is intentionally minimal; **missing fields** that are already in scope at emit sites (attempts, durationMs, maxRetries) force the consumer UI to stack `unavailable` for duration / attempt / richer identity |
| Jobs tab works better than System Events for the same events | JobsTab special-cases `payload.jobId` / `type`; System Events is a generic ledger and cannot invent fields the producer omitted |

This is **not** a Spur load/UI bug. The system-event tap serializes whatever the bus
handler receives (`safeStringify(normalizeSystemEventPayload(...))`). Empty upstream
details become empty ledger rows.

**Producer inventory (verified 2026-07-29 against this tree)**

| Event name | Emit site | Current detail shape | Problem |
| ---------- | --------- | -------------------- | ------- |
| `queue.job.enqueued` | `packages/infra/src/job-queue/db-job-queue.ts:30` (single), `:39` (batch) | `{ jobId, type }` | No `maxRetries`, `delay`, `ttlMs`, `enqueuedAt` even though `EnqueueOptions` is in scope |
| `queue.consumer.started` | `db-job-queue.ts:87` | **none** (`emit('queue.consumer.started')`) | `payload_json` null → System Events tooltip/detail empty |
| `queue.consumer.stopped` | `db-job-queue.ts:102` | **none** | Same; also no drain outcome (`inFlight` remaining, `drainTimeoutMs`) |
| `queue.job.completed` | `db-job-queue.ts:189` | `{ jobId, type }` | `durationMs` is computed immediately above (`startMs` / `performance.now()`) but **not forwarded**; `attempts` on the job is available but omitted |
| `queue.job.failed` | `db-job-queue.ts:206-211` | `{ jobId, type, error, attempt }` | Relatively complete; still lacks `maxRetries`, `durationMs` |
| `queue.job.retrying` | `db-job-queue.ts:218-223` | `{ jobId, type, attempt, nextRetryAt }` | Relatively complete; lacks `maxRetries`, `error` (error is known in `failOrRetry`) |
| `queue.stats` | `packages/infra/src/scheduler/action.ts:113` | `QueueStats` `{ pending, processing, completed, failed }` | OK for depth snapshot; optional: add `emittedAt` for wall-clock |

**Typed contract today** (`packages/infra/src/events.ts:77-92`):

```ts
export type QueueEvents = {
  'queue.job.enqueued': (detail: { jobId: string; type: string }) => void;
  'queue.consumer.started': () => void;          // ← zero-arg
  'queue.consumer.stopped': () => void;          // ← zero-arg
  'queue.job.completed': (detail: { jobId: string; type: string }) => void;
  'queue.job.failed': (detail: QueueJobFailedDetail) => void;
  'queue.job.retrying': (detail: QueueJobRetryingDetail) => void;
  'queue.stats': (detail: QueueStats) => void;
};
```

**Consumer impact (spur-new, for context — not this repo's code change surface)**

- Catalog: `queue.consumer.*` and `queue.job.*` registered in Spur `SYSTEM_EVENT_CATALOG`.
- `normalizeSystemEventPayload` does **not** strip `jobId`/`type` under `metadata-only`; null
  only appears when the emit detail itself is null/undefined.
- `extractEventRowIdentity` already maps `jobId` → Run and `type` → Action and derives
  outcome from event name; it cannot surface duration/attempt when producers omit them.
- `formatEntityLabel` returns `unavailable` for queue rows (no `entity` object) — fine;
  job identity belongs in payload correlators, not planning-entity columns.

**Why this task lives in ts-libs (not spur-new)**

Payload emptiness is a **library contract** issue. Fixing only the Spur UI would paper over
empty rows; every consumer of `EventBus<QueueEvents>` (Spur serve, tests, future hosts)
benefits from richer, stable details. Semver: additive optional fields on detail objects +
changing zero-arg consumer events to carry a detail object is a **minor** break for
TypeScript handlers typed as `() => void` — document as minor/BREAKING for typed
subscribers that re-export the exact signature (see Design).

**Related prior work in this monorepo**

- Feature **B** — *Restore System Events observability coverage* (wiring / lifecycle bus).
- Task **0049** — diagnosis of missing prefixes (done).
- Task **0050** — lifecycleBus + attachFileObserver (done).
- This task is the **payload-depth** follow-up: events already reach the ledger; their
  detail envelopes are too thin for operator debugging.

**Goal**

Make every `queue.*` emit carry a **stable, non-empty, typed detail object** with the
correlators and timing fields already available at the emit site, without leaking job
business payloads (handler input `T`) into the bus (security / size invariant).
### Requirements
R1. Consumer lifecycle details (started / stopped) — Change `queue.consumer.started` and `queue.consumer.stopped` from zero-arg emits to required detail objects (named types exported from `events.ts`). Minimum fields: `startedAt`/`stoppedAt` (epoch ms), consumer config snapshot on started (`pollInterval`, `batchSize`, `maxConcurrency`, `visibilityTimeout`), and on stopped (`drainTimeoutMs`, `inFlightAtStop`, `drained`). Done when unit tests capture non-null detail for both names.

R2. Enrich `queue.job.enqueued` — Extend detail beyond `{ jobId, type }` with `enqueuedAt` (required epoch ms) and optional-but-filled-when-known `maxRetries`, `delayMs` (from EnqueueOptions.delay), `ttlMs`. Single-enqueue and batch path must emit the same shape. Never include business payload `T`.

R3. Enrich `queue.job.completed` — At emit site forward `durationMs` (already computed via performance.now() - startMs), `attempt` (document semantics), plus existing `jobId`/`type`.

R4. Align `queue.job.failed` / `queue.job.retrying` — Add `maxRetries` to both; add optional `durationMs` on failed when available from processJob; add `error` string on retrying (same message as markForRetry). Do not rename existing keys.

R5. Typed exports + docs — Export named detail interfaces for every QueueEvents key (mirror QueueJobFailedDetail). Fix stale `events.ts` module docstring. JSDoc metadata-only invariant: job business payload T never on bus events.

R6. Tests — Extend packages/infra/tests/job-queue/db-job-queue.test.ts (and events.test.ts if needed) asserting new required fields for start/stop, enqueue single+batch, completed durationMs, failed maxRetries+error, retrying error+nextRetryAt+maxRetries. No .skip.

R7. Compatibility / versioning — Additive fields preferred. Changing () => void to (detail) => void is a TypeScript minor break; CHANGELOG Unreleased note; do not rename jobId/type/attempt/nextRetryAt/error.

R8. Out of scope — No job payload T on bus; no actor/agentId invention; no Spur catalog/UI changes in this repo; no new event names unless fields cannot express the gap.
### Acceptance Criteria
```gherkin
Feature: Rich queue.* EventBus payloads for observability consumers

  Scenario: R1 — Consumer started carries config snapshot
    Given a DBQueueConsumer constructed with pollInterval=1000, batchSize=10, maxConcurrency=5
    And an EventBus subscribed to queue.consumer.started
    When consumer.start() is called
    Then the bus receives exactly one event with a non-null detail object
    And detail includes pollInterval, batchSize, maxConcurrency, visibilityTimeout
    And detail includes a finite startedAt timestamp

  Scenario: R1b — Consumer stopped carries drain outcome
    Given a running DBQueueConsumer with an EventBus
    When consumer.stop() is called after start()
    Then queue.consumer.stopped detail includes stoppedAt, drainTimeoutMs, inFlightAtStop, drained
    And detail is never undefined/null

  Scenario: R2 — Enqueue emits correlators beyond jobId/type
    Given a DBJobQueue with an EventBus
    When enqueue("FEATURE_ACTION", { x: 1 }, { maxRetries: 3, delay: 500 }) succeeds
    Then queue.job.enqueued detail has jobId, type="FEATURE_ACTION", maxRetries=3, delayMs=500
    And detail does not contain the business payload key x / the full payload object

  Scenario: R2b — Batch enqueue matches single-enqueue shape
    Given a DBJobQueue with an EventBus
    When enqueueBatch enqueues two jobs of different types
    Then two queue.job.enqueued events fire
    And each detail has jobId, type, enqueuedAt

  Scenario: R3 — Completed job includes durationMs
    Given a registered handler that resolves successfully
    When the consumer processes the job to completion
    Then queue.job.completed detail includes jobId, type, durationMs >= 0, attempt

  Scenario: R4 — Failed job includes maxRetries and error
    Given a handler that always throws and maxRetries exhausted
    When the job permanently fails
    Then queue.job.failed detail includes jobId, type, error (non-empty), attempt, maxRetries

  Scenario: R4b — Retrying job includes error reason
    Given a handler that throws with attempts remaining
    When the job is marked for retry
    Then queue.job.retrying detail includes jobId, type, attempt, nextRetryAt, maxRetries, error

  Scenario: R5 — QueueEvents map is fully named-typed
    Given packages/infra/src/events.ts
    When a consumer imports QueueEvents detail types
    Then every queue.* key has a named exported detail interface (or shared base)
    And zero-arg consumer handlers no longer appear in the public map

  Scenario: R6 — Regression suite green
    Given the package test suite
    When bun test packages/infra is run
    Then db-job-queue and events tests pass without .skip
    And new assertions cover R1–R4b

  Scenario: R7 — Metadata-only invariant
    Given any queue.* emit path
    When the detail object is inspected
    Then it never embeds the job's business payload T
    And string fields that could hold secrets are limited to error messages already
      persisted on the job row today
```
### Q&A
**Q1. Is empty payload a Spur UI bug or an upstream library gap?**  
**A.** Upstream library gap. `DBQueueConsumer.start/stop` emit zero-arg events
(`db-job-queue.ts:87,102`). Spur's tap correctly stores `null` for undefined detail.
Fix here; Spur only needs to re-pin / consume new fields later.

**Q2. Should we add `actor` to queue events?**  
**A.** No for v1 of this task. Queue work is system-initiated (scheduler, serve boot,
API enqueue). Attribution belongs on the *caller* event (e.g. workflow.action) if needed.
Optional later: `source?: string` correlator (`'scheduler' | 'api' | 'cli'`) if producers
pass it through enqueue options — **not required** for closing empty-payload issues.

**Q3. Epoch ms vs ISO strings?**  
**A.** Prefer **epoch ms** for new numeric timestamps (`startedAt`, `stoppedAt`,
`enqueuedAt`) to match existing `nextRetryAt`. Document units in JSDoc. Do not mix
ISO and epoch on the same event map without strong reason.

**Q4. Is changing `() => void` to `(detail) => void` a major semver break?**  
**A.** Runtime: EventBus still invokes handlers; extra arg is ignored by JS listeners that
take zero params. TypeScript: handlers typed against `QueueEvents` must accept the
detail — **minor version** bump with CHANGELOG note is the project default unless an
ADR says event maps are major-locked. Record the bump in Plan when releasing.

**Q5. Why not put `payload: T` on enqueued/completed for debugging?**  
**A.** Job payloads often contain prompts, tokens, PII, or large blobs. Spur's system
events policy is metadata-only / redacted for similar reasons. Keep bus events
correlator-grade only; inspect job rows via Jobs DAO / Jobs tab when body is needed.

**Q6. Relationship to feature B / tasks 0049–0050?**  
**A.** 0049/0050 restored *delivery* of events to the observability pipeline. This task
restores *useful depth* of queue payloads that already flow through that pipeline.
Link `feature_id: B` for traceability; no dependency edge on 0050 (already done).

**Q7. attempt indexing consistency?**  
**A.** Today `queue.job.failed` / `retrying` use `attempts = job.attempts + 1` after a
failure. `completed` should document whether `attempt` is pre-increment attempts count
on the job record at success. Prefer **the same field name `attempt`** and JSDoc:
"1-based attempt number that produced this outcome" OR "0-based attempts counter on the
job row" — pick one in Design and test it.

**Q8. Consumer follow-up in spur-new?**  
**A.** After this ships and Spur re-pins `@gobing-ai/ts-infra`, optional UI polish:
show `durationMs` on Outcome for completed jobs; show consumer config in detail panel.
Not a gate for this task's PASS.
### Design
#### Approach

**Additive enrichment of existing event names** — no new `queue.*` names, no dual
emission. Expand detail interfaces; update `DBJobQueue` / `DBQueueConsumer` emit sites
to populate fields already in lexical scope.

#### Target detail contracts (proposed)

```ts
/** Shared correlators on every queue.job.* event. */
export interface QueueJobRef {
  jobId: string;
  type: string;
}

export interface QueueConsumerStartedDetail {
  startedAt: number; // epoch ms
  pollInterval: number;
  batchSize: number;
  maxConcurrency: number;
  visibilityTimeout: number;
}

export interface QueueConsumerStoppedDetail {
  stoppedAt: number; // epoch ms
  drainTimeoutMs: number;
  inFlightAtStop: number;
  drained: boolean;
}

export interface QueueJobEnqueuedDetail extends QueueJobRef {
  enqueuedAt: number;
  maxRetries?: number;
  delayMs?: number;
  ttlMs?: number;
}

export interface QueueJobCompletedDetail extends QueueJobRef {
  durationMs: number;
  /** Attempts counter on the job row at success (document exact semantics in JSDoc). */
  attempt: number;
}

// QueueJobFailedDetail — extend existing:
//   + maxRetries: number
//   + durationMs?: number

// QueueJobRetryingDetail — extend existing:
//   + maxRetries: number
//   + error: string
```

Update `QueueEvents` map accordingly; replace `() => void` consumer entries with
`(detail: QueueConsumerStartedDetail) => void` etc.

#### Emit-site change map (implementation targets)

| File | Change |
| ---- | ------ |
| `packages/infra/src/events.ts` | Named interfaces; `QueueEvents` map; fix stale file header |
| `packages/infra/src/job-queue/db-job-queue.ts` | All emit call sites (enqueue ×2, start, stop, completed, failed, retrying) |
| `packages/infra/src/job-queue/types.ts` | JSDoc on `events?` config listing new detail richness |
| `packages/infra/src/index.ts` | Re-export new detail types if not already covered by events barrel |
| `packages/infra/tests/job-queue/db-job-queue.test.ts` | Assert new fields |
| `packages/infra/tests/events.test.ts` | Type-level / emit smoke for new shapes |
| `CHANGELOG` (package or root) | Unreleased: enriched queue event payloads |

#### Invariants

1. **Metadata-only:** never attach job `payload: T` to bus details.
2. **No silent empty:** every cataloged `queue.*` emit passes a plain object detail
   (stats already does; consumer lifecycle must too).
3. **Stable keys:** do not rename `jobId`, `type`, `attempt`, `nextRetryAt`, `error`.
4. **Finite numbers only:** refuse to emit `NaN`/`Infinity` for durationMs (use
   `Number.isFinite` guard; fall back to `0` or omit optional — prefer `0` with test).
5. **Package boundary:** changes stay in `ts-infra` (+ tests). No `ts-db` schema change
   required (DAO already has the job fields).

#### Compatibility strategy

- Runtime listeners with `(d) => …` keep working; extra fields ignored.
- TS consumers that type-narrow `QueueEvents['queue.consumer.started']` must update —
  minor bump.
- Spur-new: no code change required for correctness; empty payload symptom clears once
  the new published version is linked / catalog-pinned.

#### Alternatives considered

| Option | Verdict |
| ------ | ------- |
| A. Enrich existing events (chosen) | Minimal surface; Jobs tab + System Events both improve |
| B. New events e.g. `queue.consumer.started.v2` | Rejected — doubles catalog noise |
| C. Fix only in Spur by joining Jobs DAO | Rejected — wrong layer; every consumer needs the bus detail |
| D. Put full job row on the event | Rejected — size/PII; breaks metadata-only policy |

#### attempt semantics (lock in implementation)

Use **`attempt` = `job.attempts` after the DAO mutation for this outcome**, matching
failed/retrying which already pass `attempts = job.attempts + 1`. For completed, pass
`job.attempts` as stored on the successful process path (typically 0 if first try).
Document in JSDoc on `QueueJobCompletedDetail.attempt`.
### Plan
1. **Freeze contracts** — add named detail interfaces to `packages/infra/src/events.ts`;
   update `QueueEvents`; fix the stale module docstring (lines 1–15).
2. **Export surface** — ensure new types export from package public API (`index.ts` /
   events re-exports) without deep relative imports for consumers.
3. **Consumer lifecycle** — implement R1 in `DBQueueConsumer.start` / `stop`
   (`db-job-queue.ts` ~83–103): build detail from `this.pollInterval` etc. and
   `Date.now()` / drain bookkeeping.
4. **Enqueue paths** — implement R2 for `enqueue` and `enqueueBatch` (~27–43): map
   `EnqueueOptions.delay` → `delayMs` on the wire; set `enqueuedAt`.
5. **Completed path** — implement R3 (~183–189): pass `durationMs` and `attempt`.
6. **failOrRetry** — implement R4 (~197–223): thread optional `durationMs`; always set
   `maxRetries` and `error` on retrying.
7. **Tests** — extend `db-job-queue.test.ts` capture-array assertions for each event;
   add/adjust `events.test.ts` if map compile checks need it.
8. **Docs** — JSDoc on types; brief Unreleased CHANGELOG bullet; optional README note
   under job-queue section.
9. **Gate** — `bun run lint` + `bun test packages/infra` (or repo `bun run check`) green.
10. **Release handoff** — note required `bump-ver` / Spur catalog pin as operator follow-up
    (not automated in this task unless release is requested).
11. **Consumer note** — file a short spur-new follow-up (optional) only if UI should
    *display* new fields beyond raw payload JSON (ledger already shows payload).
### Solution
_Pending implementation._ Baseline emit sites and contracts to change (pre-implementation anchors):

- `packages/infra/src/events.ts:77` — `QueueEvents` map (zero-arg consumer entries + inline job shapes)
- `packages/infra/src/events.ts:29` — `QueueJobFailedDetail` / `QueueJobRetryingDetail` extension points
- `packages/infra/src/job-queue/db-job-queue.ts:30` — `queue.job.enqueued` single
- `packages/infra/src/job-queue/db-job-queue.ts:39` — `queue.job.enqueued` batch
- `packages/infra/src/job-queue/db-job-queue.ts:87` — `queue.consumer.started` (no detail today)
- `packages/infra/src/job-queue/db-job-queue.ts:102` — `queue.consumer.stopped` (no detail today)
- `packages/infra/src/job-queue/db-job-queue.ts:189` — `queue.job.completed` (missing durationMs)
- `packages/infra/src/job-queue/db-job-queue.ts:206` — `queue.job.failed`
- `packages/infra/src/job-queue/db-job-queue.ts:218` — `queue.job.retrying`
- `packages/infra/tests/job-queue/db-job-queue.test.ts:247` — existing capture-array event tests to extend

Post-implementation: replace this section with the actual change map and rationale.
### Testing
_Pending verification (implementation not started)._

Planned commands:

```bash
bun test packages/infra/tests/job-queue/db-job-queue.test.ts
bun test packages/infra/tests/events.test.ts
bun run check
```

Coverage claim: N/A until implementation — target is package-level suite green with new assertions for R1–R4b (no coverage regression vs current infra package gate).
### Review
_Pending review after implementation._
### References
- Feature **B** — `docs/features/B_restore-system-events-observability-coverage.md`
- Task **0049** — diagnosis of missing System Events prefixes (done)
- Task **0050** — lifecycleBus + attachFileObserver wiring (done)
- Producer code:
  - `packages/infra/src/job-queue/db-job-queue.ts` (emit sites)
  - `packages/infra/src/events.ts` (`QueueEvents`, detail interfaces)
  - `packages/infra/src/job-queue/types.ts` (`Job`, `EnqueueOptions`, `QueueConsumerConfig`)
  - `packages/infra/src/scheduler/action.ts` (`queue.stats` — already adequate)
- Tests:
  - `packages/infra/tests/job-queue/db-job-queue.test.ts`
  - `packages/infra/tests/events.test.ts`
- Consumer evidence (spur-new, external):
  - `packages/app/src/services/system-event-tap.ts` — `safeStringify` / `extractSystemEventActor`
  - `packages/app/src/services/event-names.ts` — catalog entries for `queue.*`
  - `apps/web/src/modules/observability/SystemEventsTab.tsx` — empty payload tooltip behavior
  - `apps/web/src/modules/observability/JobsTab.tsx` — jobId/type narrowers
- Discovery date: 2026-07-29 (Spur System Events operator review: Actor=unavailable,
  empty queue.consumer payloads)
### History
