---
template: feature-impl
schema_version: 1
name: Enrich queue.* EventBus payloads (consumer lifecycle + job correlators) for System Events observability
description: ""
status: done
type: task
profile: standard
feature_id: B
parent_wbs: null
priority: P1
tags: []
dependencies: []
created_at: 2026-07-30T05:14:49.527Z
updated_at: "2026-07-31T16:32:53.051Z"
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


Additive enrichment of existing `queue.*` event names — no new event names, no dual
emission. Expanded detail interfaces in `packages/infra/src/events.ts`; updated emit sites
in `packages/infra/src/job-queue/db-job-queue.ts` to populate fields already in lexical
scope. The job business payload `T` is never attached to bus details (metadata-only
invariant).


| File | Change |
| ---- | ------ |
| `packages/infra/src/events.ts:33-109` | Added named detail interfaces (`QueueJobRef` `:33`, `QueueJobEnqueuedDetail` `:41`, `QueueConsumerStartedDetail` `:53`, `QueueConsumerStoppedDetail` `:67`, `QueueJobCompletedDetail` `:79`); extended `QueueJobFailedDetail` `:87` (+`maxRetries`, +`durationMs?`) and `QueueJobRetryingDetail` `:99` (+`maxRetries`, +`error`); rewrote `QueueEvents` map `:140-156` so consumer lifecycle events carry detail objects; fixed stale module header docstring `:1-19`; documented metadata-only invariant. |
| `packages/infra/src/job-queue/db-job-queue.ts:34-68` | `DBJobQueue.enqueue` `:34` / `enqueueBatch` `:41` emit enriched enqueued detail via shared `enqueuedDetail` helper `:62` (lockstep shape, single + batch). `DBQueueConsumer.start` `:108` emits config snapshot; `stop` `:121` emits drain outcome (`inFlightAtStop`, `drained`). `processJob` `:199` threads `durationMs` into `completed` detail `:229` and into `failOrRetry` on error `:239`. `failOrRetry` `:244` signature gained `durationMs`; `failed` detail `:254` adds `maxRetries`+`durationMs`, `retrying` detail `:269` adds `maxRetries`+`error`. `Number.isFinite` guard normalizes non-finite durations to `0`. |
| `packages/infra/src/job-queue/types.ts:60-66` | Updated `events?` config JSDoc to describe the richer detail payloads and metadata-only contract. |
| `packages/infra/src/index.ts:27-44` | Re-exported the new detail types (`QueueJobRef`, `QueueJobEnqueuedDetail`, `QueueConsumerStartedDetail`, `QueueConsumerStoppedDetail`, `QueueJobCompletedDetail`). |
| `packages/infra/tests/job-queue/db-job-queue.test.ts:285-468` | Added R1, R1b, R2, R2b, R3, R4, R4b dedicated tests asserting the new required/optional fields and the metadata-only invariant (no payload `T` on the wire). |
| `packages/infra/tests/events.test.ts:38-67` | Updated `queue.job.failed` fixture to include `maxRetries` `:20`; added consumer-lifecycle shape smoke (R5) `:38`. |
| `CHANGELOG.md:11-17` | Unreleased Added + Breaking Changes entries. |


`QueueJobCompletedDetail.attempt` is the **attempts counter on the job row at success**
(0-based; first successful run = 0). `queue.job.failed` / `retrying` use `attempt =
job.attempts + 1` (1-based failure number), matching the pre-existing convention.
Documented in JSDoc on each interface.
### Testing
**Pipeline verify results** — re-audit via `/sp:dev-verify 0055 --force --focus all --fix all` on 2026-07-31 (task already `done`; independent re-run of all evidence, not the implementer's self-report).

- Verdict: PASS
- Confidence: **HIGH** — every cited line re-read and every gate re-run this turn.
- Suites this run: `bun test packages/infra` → **304 pass / 0 fail** (32 files); `bunx tsc --noEmit` exit 0 for `packages/infra`; `bunx biome check` clean on all changed files.
- Coverage: runtime change; suite ran under `bun test` coverage instrumentation. Implementer-measured `db-job-queue.ts` 100% lines / 100% branches; `events.ts` is type-only.

**Per-Requirement Traceability**

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 consumer lifecycle details | MET | Interfaces `packages/infra/src/events.ts:53-77`; emit sites `db-job-queue.ts:107-113` (started config snapshot) and `:129-135` (stopped drain outcome); tests `db-job-queue.test.ts:285` (R1) and `:318` (R1b) — passed this run |
| R2 enriched enqueued | MET | `events.ts:41-51`; shared `enqueuedDetail` helper `db-job-queue.ts:62-68` used by both `enqueue` `:37` and `enqueueBatch` `:47` (single/batch shape lockstep); never copies payload; tests `:341` (R2, asserts `not.toHaveProperty('payload')` + no `"v"` in stringified detail) and `:370` (R2b batch parity) — passed this run |
| R3 completed durationMs + attempt | MET | `db-job-queue.ts:217-230`: `durationMs` computed `:221`, `Number.isFinite` guard → 0 `:227`, `attempt: job.attempts` `:228`; test `:391` asserts `durationMs >= 0` finite and `attempt === 0` on first success — passed this run |
| R4 failed/retrying alignment | MET | `failOrRetry` `:239-273`: failed detail `:249-256` (+`maxRetries`, +`durationMs`), retrying detail `:264-271` (+`maxRetries`, +`error`, `nextRetryAt` preserved); `attempts = job.attempts + 1` `:244` unchanged; no renames; tests `:411` (R4) and `:437` (R4b) — passed this run |
| R5 typed exports + docs | MET | Named interfaces for every `queue.*` key `events.ts:33-109`; `QueueEvents` map `:141-156` has zero zero-arg entries; barrel re-exports `packages/infra/src/index.ts:27-44`; module header rewritten `:1-19` with metadata-only invariant `:12-15`; type smoke `events.test.ts:38` + `maxRetries` fixture `:20`; `tsc --noEmit` exit 0 this run |
| R6 tests | MET | 7 dedicated R-tests `db-job-queue.test.ts:285-468` + `events.test.ts` updates; real `bun-sqlite` in-memory adapter, no DAO/bus mocks; skip scan clean (the `xit(` rg hits are `captureExit` false positives); 304 pass / 0 fail this run |
| R7 compatibility / versioning | MET | Additive fields only; `CHANGELOG.md` Unreleased Added `:11-13` + Breaking Changes `:15-17` (minor: zero-arg → detail handlers; required `maxRetries`/`error` gains); keys `jobId`/`type`/`attempt`/`nextRetryAt`/`error` unchanged in the interfaces |
| R8 out of scope | MET | Event-name set unchanged (`enqueued`/`started`/`stopped`/`completed`/`failed`/`retrying`/`stats` — `events.ts:141-156`); no payload `T` on any emit path; `git show 85f45fe --stat` confines the diff to ts-infra + CHANGELOG + task file; no Spur/catalog changes in repo |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| R1 — started carries config snapshot | MET | test | `db-job-queue.test.ts:285` — passed this run |
| R1b — stopped carries drain outcome | MET | test | `db-job-queue.test.ts:318` — passed this run |
| R2 — enqueue emits correlators beyond jobId/type | MET | test | `db-job-queue.test.ts:341` (payload-omission asserted) — passed this run |
| R2b — batch matches single shape | MET | test | `db-job-queue.test.ts:370` — passed this run |
| R3 — completed includes durationMs | MET | test | `db-job-queue.test.ts:391` — passed this run |
| R4 — failed includes maxRetries and error | MET | test | `db-job-queue.test.ts:411` — passed this run |
| R4b — retrying includes error reason | MET | test | `db-job-queue.test.ts:437` — passed this run |
| R5 — QueueEvents map fully named-typed | MET | command + static | `tsc --noEmit` exit 0; map read at `events.ts:141-156` (no zero-arg entries); `events.test.ts:38` |
| R6 — regression suite green | MET | command | `bun test packages/infra` → 304 pass / 0 fail this run; no `.skip` |
| R7 — metadata-only invariant | MET | test + static | R2 test payload assertions; all emit sites re-read — only correlator fields copied; error strings are the same message persisted on the job row (`markFailed`/`markForRetry` `:247`/`:263`) |

**Design Conformance**

| Check | Status | Evidence |
|-------|--------|----------|
| design-conformance | pass | All claims DONE: additive enrichment with no new names/dual emission; contracts match the design sketch including optional markers; 7-file change map landed as written (events.ts, db-job-queue.ts, types.ts `:60-66` JSDoc, index.ts, both test files, CHANGELOG); all 5 invariants hold (metadata-only, no-silent-empty, stable keys, finite-only `:227`/`:234`, package boundary); attempt semantics locked as designed (`job.attempts` on completed, `+1` on fail/retry). One doc defect found and **fixed this run**: `events.ts:83` JSDoc said "1-based attempt" while code/tests pin `job.attempts` (0 on first success) — corrected to "Attempts counter on the job row at success (0 on the first successful run)"; biome + tsc + both test files re-run green after the edit |

**SECUA Review** — focus: all. No blocker/major findings. Security: metadata-only invariant is structural (the shared helper copies only named option fields; payload is never referenced at any emit site) and test-pinned; error strings are the same message already persisted on the job row. Efficiency: one small object literal per emit; no added I/O. Correctness: finite-guards match design invariant 4; `stop()` emits only after `start()` (matches AC R1b's precondition). Usability: public contract fully TSDoc'd; the one defective adjective (P3) fixed this run. Architecture: change confined to the contract + emit seams; shared `enqueuedDetail` helper eliminates single/batch drift; barrel exports complete; ADR-014 subpath structure untouched.

**Fix pass (`--fix all`)**: (1) `events.ts:83` JSDoc corrected (see design-conformance row). (2) Verdict-id repair for the Shippable gate: `spur feature check B` flagged R1b/R2b/R4b as "linked but unverified" — the prior artifact's AC rows didn't cover those titles. Rewrote `.spur/run/0055-verdict.json`; first pass used short ids (`R1b`) which regressed matching to 0/10 (the checker normalize-matches **full scenario titles**, stripping the `R\d+` tag from both sides — a bare `R1` normalizes to empty); corrected to full-title AC rows for all 10 scenarios → `spur feature check B` re-run: **0 findings** (verified this run). Gitignored artifact touched: `.spur/run/0055-verdict.json` (`acceptanceCriteria[]` rewritten; `checks[].shippable` synced).

**Shippable gate** (feature B, active under `--fix all`): after repair, `spur feature check B --json` → pass, 0 findings; `spur task list --feature B` → all 5 tasks `done`. Shippable: **PASS**.
### Review


Reviewed the diff against R1–R8 and the metadata-only / stable-keys invariants.

| Priority | Finding | Status |
| -------- | ------- | ------ |
| P1 | (none) | — |
| P2 | `failOrRetry` signature widened with required `durationMs`; all three call sites (corrupt-payload, no-handler, handler-throw) updated to pass a finite number | Resolved — verified by tsc + tests |
| P3 | `Number.isFinite` guard normalizes `NaN`/`Infinity` duration to `0` (R4 invariant #4) | Resolved — applied on both completed and failed paths |
| P3 | `enqueuedDetail` shared helper keeps single + batch enqueue shape-identical (R2/R2b) | Resolved — single test path covers both |
| P4 | No business payload `T` on any emit; R2 test asserts payload key absence | Resolved |


1. **Metadata-only:** no `payload: T` on any detail — confirmed by grep + R2 assertion.
2. **No silent empty:** every `queue.*` emit now passes a plain object.
3. **Stable keys:** `jobId`, `type`, `attempt`, `nextRetryAt`, `error` unchanged.
4. **Finite numbers:** `durationMs` guarded; timestamps are `Date.now()` (finite).
5. **Package boundary:** changes confined to `ts-infra` (+ tests + root CHANGELOG).


Changing `queue.consumer.started` / `queue.consumer.stopped` from `() => void` to
`(detail) => void` is a TypeScript minor break for typed subscribers; runtime JS listeners
that ignore arguments keep working. Recorded in CHANGELOG Breaking Changes.
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
- 2026-07-31T07:19:34.406Z todo → wip (system)
- 2026-07-31T07:24:56.315Z wip → testing (system)
- 2026-07-31T15:54:14.413Z testing → done (system)
