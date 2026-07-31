---
schema_version: 1
name: review on ts-infra after the migration
status: done
type: task
created_at: 2026-06-05T06:52:19.033Z
updated_at: 2026-06-05T16:28:16Z
---

## 0021. review on ts-infra after the migration

### Background
As we did before for `packages/rule-engine`, `packages/dual-workflow-engine`, `packages/runtime` and  `packages/ai-runner`, we already had a good understanding of the migration from old project `/Users/robin/xprojects/spur-old` into several different packages under folder `packages/`. Now we need to deal with `packages/infra`.

By designing, this package will be use to provide some shared infrastructure components for any projects. It relies on some utility libraries and frameworks, but provides solid and well-designed infrastructure components.

My key concerns on current package are:
- Migration drifts cause to lose features or architecture alignments and system designings;
- Any uncomplianced implementations
- Any inconsistencies in the implementation
- Any valuable components forgot to be extracted

#### Review Findings

Comparative review of `spur-old/packages/core/src` (old) vs `packages/infra/src` (new), scoped to the
core infra set (logger, event-bus, telemetry, scheduler, job-queue, api-client) plus a hunt for valuable
components not extracted.

**Root cause (unifying theme):** the migration cleanly extracted the *infrastructure primitives* but
stripped most of the **observability wiring layer** that connected them. The instrumentation primitives
themselves survived (`telemetry/tracing.ts` — `traceAsync`, `addSpanAttributes`, span helpers are intact),
but several **call-sites and the default observer set were dropped**, partly due to coupling with the
un-migrated `events/app-events.ts` event catalog.

Operator decisions on the open questions are folded into each finding's **Resolution** below.

---

**F1 — [HIGH] EventBus ships dead lifecycle-emission code with no observers to consume it.**
The new `EventBus` core still emits all four lifecycle events (`bus.emit.done`, `bus.emit.noop`,
`bus.handler.error`, `bus.handler.async.enqueued`) and keeps the full `BusLifecycleEvents` type surface
(`infra/src/event-bus/event-bus.ts:200-234`, `types.ts:41`). But the consumers were dropped:
`default-observers.ts` (149 lines: `attachDefaultObservers`, `attachLogObserver`, `attachTelemetryObserver`,
`attachMetricsObserver`, `createLifecycleBus`) and `file-observer.ts` (`attachFileObserver`) are absent, and
`event-bus/index.ts` no longer exports them. Lifecycle emission is wired but unobservable — the
production-recommended self-observability path (`attachDefaultObservers`) is gone.
**Resolution:** restore `default-observers.ts` and `file-observer.ts`. `file-observer` must route file I/O
through `@gobing-ai/ts-runtime` FileSystem (old used inline `../io`; ADR-011 forbids direct `node:fs` in
infra).

**F2 — [HIGH] Job-queue consumer lost OTel tracing + expired-job reset.**
Old `db-consumer.ts` (356 lines) instrumented `queue.poll` and `queue.job.process` spans via `traceAsync`,
and distinguished `resetExpiredJobs` from `resetStuckJobs`. The merged `db-job-queue.ts` (178 lines) keeps
`resetStuckJobs`, `stats`, `failOrRetry`, `processOnce` but has **no `traceAsync` instrumentation** and **no
expired-job reset**. `traceAsync` is now called nowhere in infra except api-client.
**Resolution:** re-instrument `poll`/`processJob` with `queue.poll` / `queue.job.process` spans; reconcile
the expired-vs-stuck reset semantics (confirm whether the merge intentionally collapsed them).

**F3 — [MED] Scheduler lost the observability wrapper (`wrap-handler.ts`).**
`wrapScheduledHandler` (51 lines: `scheduler.job` span + duration + `scheduler.job.executed` event) was
dropped entirely; new `scheduler/index.ts` no longer exports it. It is generic, cross-runtime infra used by
both Node and Cloudflare adapters. Its drop is coupled to F5 — it imported `AppInternalEvents` from the
un-migrated `events/`.
**Resolution:** restore `wrap-handler.ts`, retyped against the new infra-local `events.ts` (F5) instead of
the old `EventBus<AppInternalEvents>`.

**F4 — [MED] Scheduler action layer gutted (`action.ts` 193 → 4 lines).**
Dropped: `ActionRegistry`, `LogAction`, `QueueStatsAction`, `HealthPingAction`, `createDefaultRegistry`.
**Resolution (operator):** implement these default actions, and provide a way for downstream developers to
opt in/out — they are useful infra defaults, not mandatory. Restore `ActionRegistry` + the three built-in
actions; expose `createDefaultRegistry(options)` so consumers explicitly choose which actions to register
(empty/selective by default, never auto-wired).

**F5 — [MED / missed-extraction] `events/app-events.ts` not migrated; infra has no event catalog.**
Old `events/app-events.ts` (972-line module) is a **centralized** catalog mixing application-level and
infrastructure-level events — but **most are infrastructure-level**. It is not referenced by any new package.
**Resolution (operator):** do NOT copy the old centralized file. Define a new infra-local
`packages/infra/src/events.ts` following the same pattern as `packages/ai-runner/src/events.ts` — containing
only the infrastructure-level event definitions infra actually needs (queue, scheduler, api-request,
process, db-connection lifecycle). F3's `wrap-handler` and F1's observers type against this new `events.ts`.

**F6 — [LOW→MED] Logger rewritten away from LogTape.**
Old `logger.ts` (47 lines) re-exported LogTape's `getLogger`; new (128 lines) is a hand-rolled `Logger`
interface with `LogLevel`, `setLoggerMuted`, custom `initializeLogger` — LogTape dependency removed.
**Resolution (operator):** re-implement the custom logger **on top of LogTape** to leverage its power.
Follow the original LogTape-backed approach, and design for the spur-new todo: **file log + console log,
selectable/controlled by the config file**. The pre-existing concern with the original logger should be
fixed with a *better* solution rather than reverted verbatim. Keep the `getLogger(category)` signature so
existing observer call-sites keep working.

---

**Cleared (no action):**
- **api-client** — signatures intact (`APIClientConfig`, `RequestOptions`, `APIError`, `APIClient`);
  `traceAsync` request-level instrumentation **preserved**. 249→175 drop is comment/helper trimming.
  *(Corrected an initial hypothesis that telemetry was stripped here — it was not.)*
- **telemetry** — `tracing.ts`, `metrics.ts`, `config.ts`, `db-sanitize.ts`, `sdk.ts` all preserved; new
  `otel-node.ts` is a clean net addition with a proper `./otel-node` subpath export. Improvement, not drift.
- **process-executor / base-dao tracing** — belong to `ts-runtime` / `ts-db`, out of infra scope.

**Fix order:** F6 (LogTape logger + config) → F5 (infra-local `events.ts`) → F1 (event-bus observers +
file-observer) → F3 (scheduler wrap-handler) → F4 (scheduler default actions, opt-in) → F2 (job-queue
tracing + expired-reset). F5/F6 are foundational — observers and wrap-handler depend on both.


### Requirements
- Have a comprehensive code review on both folders to find any issues.
- Figure out the proper designings and solutions for these findings.
- Fix all these findings.


### Q&A



### Design

Design decisions for the fixes (resolving the open questions from Review Findings).

#### F6 — LogTape-backed logger (adapter, not verbatim re-export)

**Constraint discovered:** LogTape 2.0.6's native `Logger` API is *incompatible* with the current infra
`Logger` contract, so a verbatim revert to the old 47-line re-export would break existing call-sites:

| Concern | LogTape native | Current infra `Logger` (must preserve) |
|---|---|---|
| Log call | `info("msg {foo}", { foo })` — interpolates into message | `info(msg, data?)` — `data` appended as structured JSON fields |
| Context | `.with(props)` | `.child(context)` |
| Levels | trace…fatal (`warning` not `warn`) | trace/debug/info/warn/error/fatal |
| Mute | none | `setLoggerMuted(boolean)` |

**Decision:** keep the infra `Logger` interface exactly as-is and implement an **adapter** over a LogTape
logger. `getLogger(category)` returns an adapter whose `info(msg,data)` calls the underlying LogTape logger
with `data` as the property bag (no message interpolation — pass `msg` verbatim); `.child()` maps to
LogTape `.with()`; `warn`→`warning` level mapping; `setLoggerMuted` short-circuits before delegating.
Preserves the one existing caller (`event-bus.ts: getLogger('event-bus').info(msg, {...detail})`) unchanged.

**File sink (ADR-011):** ts-infra must not touch `node:fs`/`process.stderr`. So:
- `initializeLogger(options)` accepts **injected sinks** — a console toggle plus an optional caller-provided
  file-writer callback `(line: string) => void`. ts-infra builds the LogTape `configure({ sinks, loggers })`
  from a `LoggingConfig` (`level`, `console`, `file`, `json`).
- ts-infra owns the **console sink** (LogTape `getConsoleSink` — no raw fs) and formatter selection
  (`getJsonLinesFormatter` / `getTextFormatter`).
- The **file sink writer** is supplied by the consumer/`ts-runtime` (which owns FileSystem + write streams),
  matching the old `logger.ts` (facade) vs runtime-factory (`configureLogger`) separation.
- `LoggingConfig` shape mirrors old `config.logging`: `{ level?, console?, file?, filePath?, json? }`. `filePath`
  resolution + stream creation stays on the runtime/app side.

**Dependency:** add `@logtape/logtape ^2.0.0` to `packages/infra` `dependencies` (operator-approved).

#### F5 — infra-local `events.ts` (ai-runner pattern)

Do NOT port old `events/app-events.ts` (centralized app+infra mix). Create `packages/infra/src/events.ts`
exporting only **infrastructure-level** typed event maps, mirroring `packages/ai-runner/src/events.ts`:
scheduler (`scheduler.job.executed`), queue (`queue.job.failed`, `queue.job.retrying`), api-request,
process, db-connection lifecycle. `wrap-handler` (F3) and `default-observers` (F1) type against this.

#### F4 — scheduler default actions, opt-in

Restore `ActionRegistry`, `LogAction`, `QueueStatsAction`, `HealthPingAction` and
`createDefaultRegistry(options)`. Default registry registers **nothing automatically**; downstream
developers explicitly choose which built-ins to enable via options. No auto-wiring at construction.

#### F1/F2/F3 — observability restoration

- F1: restore `default-observers.ts` (log/telemetry/metrics observers + `createLifecycleBus`) and
  `file-observer.ts` (file I/O via `@gobing-ai/ts-runtime` FileSystem, not `node:fs`); re-export from
  `event-bus/index.ts`.
- F2: re-instrument job-queue `poll`/`processJob` with `queue.poll`/`queue.job.process` `traceAsync` spans;
  reconcile expired-vs-stuck reset.
- F3: restore `wrap-handler.ts` typed against the new infra `events.ts` (F5).


### Solution

All six findings resolved. Verification: `bun run spur-check` (full canonical gate — Biome, per-package
typecheck, 1159 tests across 138 files, both spur rule presets incl. coverage-gate, every-export-has-tsdoc,
and all ADR boundary rules) passes clean; `bun run build` succeeds for all 8 packages; `git status` shows
only intentional changes.

#### ✅ F6 — LogTape-backed logger
- `@logtape/logtape ^2.0.0` added to `packages/infra` dependencies.
- `src/logger.ts` rewritten as a LogTape adapter preserving the ts-infra `Logger` contract
  (`method(msg, data?)` + `child(context)`); LogTape owns level filtering, sink routing, formatting.
- `initializeLogger(options)` now async + config-driven (`level`, `console`, `fileSink`, `json`).
  **ADR-011:** console sink is LogTape's `getConsoleSink`; file logging is an **injected** writer
  (`fileSink: (line) => void`) supplied by the caller (ts-runtime owns FileSystem). Delivers the
  config-controlled file+console logging without an fs dependency in infra.
- `tests/logger.test.ts` rewritten to assert via injected sink (routing, level filtering, child context,
  mute, reconfiguration).

#### ✅ F5 — infra-local events.ts
- New `src/events.ts` (ai-runner pattern): infrastructure-level event maps only — `DbEvents`,
  `QueueEvents`, `SchedulerEvents`, `ApiClientEvents`, aggregated as `InfraEvents`. App-domain events
  (`history.import.*`, `http.*`) intentionally excluded. Process events left to ts-runtime (it owns
  `ProcessExecutor`/`ProcessEvents`) — not duplicated, so no new ts-runtime dependency.

#### ✅ F1 — event-bus observers + file-observer
- Restored `default-observers.ts` (`attachLogObserver`, `attachTelemetryObserver`, `attachDefaultObservers`,
  `createLifecycleBus`) and `file-observer.ts` (`attachFileObserver` + `FileObserverWriter`, file I/O via an
  injected writer — ADR-011).
- **Reconciliation (R6):** `attachMetricsObserver` deliberately NOT restored — the new `EventBus` core
  already increments `eventbus.emits.total`/`eventbus.errors.total` inline (`event-bus.ts`). Re-adding the
  metrics observer would double-count. Restored set is log + telemetry-trace only; documented in-code.

#### ✅ F3 — scheduler wrap-handler
- Restored `wrap-handler.ts` (`wrapScheduledHandler`) adapted to the new no-arg `ScheduledAction` signature
  and typed against the new `SchedulerEvents` (F5). Adds an OTel `scheduler.job` span + duration +
  `scheduler.job.executed` emission; composes on top of the adapters' inline metrics (no double-count).

#### ✅ F4 — scheduler default actions (opt-in)
- Restored `ActionRegistry`, `LogAction`, `QueueStatsAction`, `HealthPingAction`, `createDefaultRegistry`
  + a `toScheduledAction` bridge. **Opt-in per operator directive:** `createDefaultRegistry` auto-registers
  only the side-effect-free `LogAction`; `QueueStatsAction` (needs a DAO provider) and `HealthPingAction`
  (needs an injected `HealthPingWriter` — ADR-011, no fs in infra) are included only when their dependency
  is supplied. Downstream decides what to enable.

#### ✅ F2 — job-queue tracing (scope corrected)
- Added `queue.poll` and `queue.job.process` `traceAsync` spans (job_id/type/attempt + claimed/processed
  attributes) to `db-job-queue.ts`.
- **Correction to the original finding:** "expired-job reset missing" was **wrong** — `processOnce` already
  calls `dao.resetStuckJobs()` AND `dao.failExpiredJobs()`; the reset semantics survived, relocated into the
  ts-db DAO. The only genuine residual gap was the OTel tracing, now restored.

#### Corrections to the original Review Findings (honesty)
- **F2:** expired/stuck reset was NOT lost (handled by ts-db DAO); only tracing was missing.
- **api-client (cleared):** confirmed its request-level `traceAsync` instrumentation was preserved — an early
  hypothesis that telemetry was stripped there was wrong.

#### Note for downstream / ts-runtime
The logger file-sink writer, the file-observer writer, and the HealthPingAction writer are all injected:
ts-runtime (FileSystem owner) supplies them. ts-infra intentionally owns no file I/O.


### Plan



### Review

#### Verification — 2026-06-05

**Verdict:** PASS

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Async file observer can append before directory preparation completes | Correctness | `packages/infra/src/event-bus/file-observer.ts:42` | Fixed by serializing writes behind async `ensureDir` and covering async failure paths. |

**SECU result:** no remaining P1/P2/P3/P4 findings after fix.

**Requirements traceability:**

| Requirement | Verdict | Evidence |
|---|---|---|
| Comprehensive review of old/new infra folders | MET | Review findings F1-F6 captured above, including corrected false positives for api-client and expired/stuck queue reset. |
| Proper designs and solutions for findings | MET | Design section defines LogTape adapter, infra-local event catalog, observer restoration, scheduler actions, wrapper, and queue tracing scope. |
| Fix all findings | MET | Implementation covers logger, events, EventBus observers, file observer, scheduler wrapper/actions, and DB queue tracing with tests. |

**Auto-fix applied during verification:** hardened `attachFileObserver` for async injected writers:
- waits for async directory preparation before appending lifecycle JSONL records;
- serializes async append operations to preserve event order;
- logs and absorbs async setup/append failures so observer I/O does not destabilize the primary bus.



### Testing

Verification gates run on 2026-06-05:

- `bun run check` — PASS: Biome, per-package `tsc --noEmit`, 1162 tests across 138 files, coverage clean.
- `bun run spur-check` — PASS: lint, pre-check spur rules, tests + coverage, post-check spur rules (`coverage-gate`, `every-export-has-tsdoc`).
- `bun run build` — PASS: all 8 packages built successfully.

Focused regression coverage added:
- `packages/infra/tests/event-bus/file-observer.test.ts` now covers async `ensureDir`, async append failure handling, and setup failure handling.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


### History

- Migrated from legacy format (2026-07-31)
