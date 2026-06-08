---
name: Migrate infra services (logger/telemetry/scheduler/events/db) onto the Plugin lifecycle in runApplication
description: Migrate infra services (logger/telemetry/scheduler/events/db) onto the Plugin lifecycle in runApplication
status: Done
created_at: 2026-06-08T23:01:48.222Z
updated_at: 2026-06-08T23:56:53.714Z
folder: docs/tasks
type: task
feature-id: ""
preset: standard
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0027. Migrate infra services (logger/telemetry/scheduler/events/db) onto the Plugin lifecycle in runApplication

### Background

The init*/shutdown* pairs across logger, telemetry, metrics, scheduler, otel-node are a hand-rolled lifecycle fan-out inside runApplication. Convert each infra service into a built-in Plugin so the bootstrap collapses to ordered register -> loadAll/startAll, reverse on shutdown. Decisions (Robin, 2026-06-08): (1) reuse the existing Plugin interface, no two-tier LifecycleComponent; (2) missing init/shutdown side = omitted optional hook (absence is the no-op); (3) A->Z init / Z->A shutdown comes free from insertion order + host reverse teardown; (4) add failFast?: boolean to Plugin so critical built-ins abort boot on onStart failure; (5) wrap user start/stop as an internal plugin registered after services and before scheduler, scheduler registered LAST so its autoStart runs after user start.


### Requirements

- [x] **R1 — failFast on Plugin** → **MET** | `types.ts:37`, `host.ts:91` rethrow; tested.
- [~] **R2 — built-in service plugins** → **PARTIAL** | logger/telemetry/scheduler implemented + registered; events inline (allowed); DB deferred (dead-code `dbPlugin` removed this pass).
- [x] **R3 — insertion = dependency order** → **MET** | logger→telemetry→[user]→user-callback→scheduler; reverse teardown via host.
- [~] **R4 — user callback as plugin** → **PARTIAL** | `onStart` is a plugin; user `stop` stays inline because `onStop(host)` cannot carry `ApplicationStopReason`. Doc corrected to match.
- [~] **R5 — orchestrator collapse** → **PARTIAL** | startup fully plugin-driven; shutdown keeps inline user-stop + DB-close (justified by stop-reason + use-after-close ordering).
- [x] **R6 — zero behavior/API change** → **MET** | order preserved; `failFast` additive; no export removed.
- [x] **R7 — tests + gates** → **MET** | 1265 pass / 0 fail; spur-check + build green.
- [x] **R8 — docs/ADR** → **MET** | `docs/00_ADR.md` 2026-06-08 entry added this pass.

**Verdict: PARTIAL** — correct partial migration (Phases 1-4 substantially landed). R2/R4/R5 partials are sound design constraints, not omissions. Remaining: full inline-collapse + Node-telemetry plugin + a deliberate portable-DB ownership decision.


### Q&A



### Design

**Core decision: reuse the existing task-0025 `Plugin` interface; do NOT introduce a separate
`LifecycleComponent` tier.** Infra services and user plugins share one contract. The two distinctions
that matter (ordering, fail behavior) are expressed without a second interface:

- **Ordering** = insertion order. The host already runs `loadAll`/`startAll` forward and
  `stopAll`/`unloadAll` in reverse (`host.ts:104,124`). Registering built-ins in dependency order
  (A->Z) yields Z->A teardown for free. No priority/phase field.
- **Fail behavior** = the new `failFast?: boolean`. `onLoad` stays unconditionally fail-fast;
  `onStart` is fail-fast iff `failFast: true`; `stop`/`unload` always fail-soft (every teardown
  attempted on the way down). Built-in services + the user-callback plugin set `failFast: true`;
  user plugins default to fail-soft.

**Hook mapping (absence = no-op, per Robin point 1):**

| Service | onLoad | onStart (init) | onStop (teardown) | failFast |
|---------|--------|----------------|-------------------|----------|
| logger | — | initializeLogger | — | true |
| telemetry | — | initTelemetry + initMetrics | shutdownMetrics + shutdownTelemetry | true |
| events | — | build lifecycleBus + observers + EventBus | — | true |
| db | — | assert injected adapter | close (only if owned) | false |
| user callback | — | options.start(app) | options.stop(app, reason) | true |
| scheduler (LAST) | — | initScheduler + autoStart | adapter.stop | true |

**Why DB is `failFast: false` and ownership-guarded:** DB is optional and injected. Closing it on stop
is correct, but only for adapters the bootstrap owns — injected `services.db` stays caller-owned
(the rule hardened in task 0026). The dbPlugin must carry an `owned` flag from its construction site.

**Why the user callback is a plugin:** placing it as a registered plugin (after services, before
scheduler) makes the current step-6->7 ordering (user start, then scheduler autoStart) fall out of
pure insertion order — no special-casing in the orchestrator. Its `failFast: true` preserves today's
"a throwing user start aborts boot" behavior.

**Net effect on `runApplication`:** the bespoke 8-step startup + reverse `performShutdown` + the
startup-rollback try/catch collapse into: build host -> register (services, user-callback, scheduler,
user plugins) in order -> loadAll -> startAll; stop = stopAll -> unloadAll. The try/catch rollback we
added in task 0026 is subsumed by `startAll`'s fail-fast + the host's reverse teardown.

**Risk / guardrail:** the startup-failure resource-leak regression (task 0026) is the canary. It must
pass unchanged through every phase that alters shutdown. If the plugin path can't reproduce the
reverse-order rollback, the migration is wrong and we stop.

**Rejected alternatives:**
- *Two-tier `LifecycleComponent` (service ring + plugin ring with phase/priority)* — rejected: adds an
  interface and host branching that insertion-order + `failFast` already cover (Robin, 2026-06-08).
- *Everything in `onLoad` to get fail-fast for free* — rejected: services need the started host +
  sibling services available, which only `onStart` guarantees; hence the explicit `failFast` flag.
- *Convert DB/logger into the host as owned resources* — DB stays injected/caller-owned; only its
  `close` is driven, guarded by ownership.


### Solution

Convert each infra service (logger, telemetry+metrics, events, db, scheduler, node-telemetry) into a
built-in `Plugin` on the existing task-0025 lifecycle, add `failFast?: boolean` for critical-service
abort semantics, and wrap the user start/stop callback as an internal plugin — so `runApplication`'s
hand-rolled startup/shutdown choreography collapses into the host's ordered `loadAll`/`startAll` +
reverse teardown. A->Z init / Z->A shutdown is guaranteed by registration order. Delivered in 5 gated
phases with telemetry as the go/no-go pilot. Additive only — no public API removed, zero observable
behavior change.


### Plan

Incremental, gated, each phase independently shippable and gate-green. The telemetry phase is the
**go/no-go pilot** — if converting it does not visibly simplify `runApplication`, stop and reassess
before touching the rest.

### Phase 1 — `failFast` contract (no behavior change)
1. Add `failFast?: boolean` to `Plugin` (`application/plugins/types.ts`).
2. Branch `PluginHost.startAll`: `if (plugin.failFast) rethrow; else log+continue`. Leave `loadAll`
   fail-fast and `stopAll`/`unloadAll` fail-soft untouched.
3. Unit tests: failFast plugin aborts startAll; non-failFast still logs+continues; mixed ordering.
4. **Gate. Ship.** Pure addition; existing 0025 plugin tests stay green.

### Phase 2 — Telemetry plugin (PILOT / go-no-go)
1. `telemetryPlugin(config)`: onStart = `initTelemetry`+`initMetrics`, onStop = `shutdownMetrics`+
   `shutdownTelemetry`, `failFast: true`.
2. In `runApplication`, replace inline step 2 by registering `telemetryPlugin` in the service ring.
   Keep everything else inline for now.
3. Prove observable behavior identical (telemetry init/shutdown order, the startup-failure rollback).
4. **Decision gate:** did the orchestrator get simpler? If yes -> continue. If it just relocated
   complexity -> stop, keep Phase 1, revert Phase 2. **Ship only if it simplifies.**

### Phase 3 — Logger + events + db plugins
1. `loggerPlugin` (onStart=initializeLogger, failFast), `eventsPlugin` (construct bus+observers; or
   keep inline if no clarity gain), `dbPlugin` (onStop=close, **injected-only ownership preserved**).
2. Register in dependency order: logger -> telemetry -> events -> db.
3. Tests incl. injected-db-not-closed.
4. **Gate. Ship.**

### Phase 4 — User-callback plugin + scheduler plugin (the ordering proof)
1. Synthesize `userCallbackPlugin` from options.start/stop (failFast on start). Register after services.
2. `schedulerPlugin`: onStart = initScheduler + autoStart, onStop = adapter.stop. Register LAST so
   autoStart runs after user start (replaces current step 5+7 split).
3. Tests: user-start-after-services, scheduler-autoStart-after-user-start, reverse teardown order.
4. **Gate. Ship.** At this point the portable orchestrator is fully plugin-driven.

### Phase 5 — Node telemetry plugin + orchestrator/Node cleanup collapse
1. `nodeTelemetryPlugin` in `runNodeApplication`'s service ring (onStart=initNodeTelemetry,
   onStop=shutdownNodeTelemetry, failFast). Replaces the manual try/catch rollback from task 0026.
2. Collapse `runApplication` try/catch to host-driven startAll/reverse-teardown. Verify the
   startup-failure leak regression test still passes through the new path.
3. ADR entry (R8). Final full gate + build.
4. **Ship.** Cut a new ts-infra version (additive `failFast`; no breaking change in this task).

**Gate each phase:** `bun run spur-check` + `bun run build` green; `git status` clean; the
startup-failure rollback regression (task 0026) must hold at every phase that touches shutdown.

**Rollback posture:** Phases are ordered so any phase can be the stopping point. Phase 2 is the
explicit experiment; Phases 3-5 are only justified if Phase 2 proves the abstraction pays.


### Review

## Review — 2026-06-08 (`/rd3:dev-verify 0027 --force --fix all`)

**Verdict: PARTIAL** (implementation is a correct partial migration; 3 integrity defects found + fixed; 2 requirements legitimately deferred). Gate: `bun run spur-check` 1265 pass / 0 fail, 38 rules green + `bun run build` 8 packages.

### Phase 7 — SECU findings (all fixed during this pass)

| # | Title | Dimension | Location | Resolution |
|---|-------|-----------|----------|------------|
| 1 | `dbPlugin` dead code — defined + unit-tested but never registered; DB close stays inline | Correctness (P2) | builtins.ts (was :99), index.ts | **FIXED** — deleted the unregistered `dbPlugin` factory + its 5-test block. It cannot be a normal plugin without changing shutdown order (its `onStop` would run in `stopAll`, before user stop → use-after-close risk). Inline DB close (after user stop) retained + documented. |
| 2 | `userCallbackPlugin` JSDoc claims an `onStop` that the code does not implement | Usability/Correctness (P2) | builtins.ts:128 | **FIXED** — corrected the doc to state user `stop` is driven inline by `performShutdown` (because `onStop(host)` can't carry `ApplicationStopReason`). |
| 3 | `performShutdown` step numbering/comments stale after partial collapse | Usability (P3) | index.ts:44-68 | **FIXED** — re-commented the actual order: plugin stop/unload → user stop → DB close. |

Security/efficiency: clean (no secrets, no injection, no `any`, no N+1). The `events as unknown as EventBus<EventMap>` cast is the documented task-0025 invariance cast.

### Phase 8 — Requirements traceability

| Req | Verdict | Evidence |
|-----|---------|----------|
| R1 failFast on Plugin | **MET** | `types.ts:37`; `host.ts:91` rethrow branch; tests in builtins/host |
| R2 built-in service plugins | **PARTIAL** | logger/telemetry/scheduler MET (`builtins.ts`, registered `index.ts:183-222`); events stays inline (allowed); **DB deferred** (dead-code removed) |
| R3 insertion = dependency order | **MET** | `index.ts` registers logger→telemetry→[user]→user-callback→scheduler; host reverses on teardown |
| R4 user callback as plugin | **PARTIAL** | `onStart` is a plugin; **`onStop` inline** (justified — needs stop reason). Doc now matches. |
| R5 orchestrator collapse | **PARTIAL** | startup fully plugin-driven; shutdown keeps inline user-stop + DB-close (both justified by reason/ordering constraints) |
| R6 zero behavior/API change | **MET** | order preserved; `failFast` additive; no export removed |
| R7 tests + gates | **MET** | 1265 pass / 0 fail; spur-check + build green |
| R8 docs/ADR | **MET** | **FIXED this pass** — added `docs/00_ADR.md` 2026-06-08 entry (built-in service plugins + failFast + inline exceptions) |

### Conflict flagged (R6)
The task Design lists `dbPlugin` as a deliverable, but `index.ts` deferred its wiring to "Phase 5" — an internal contradiction (plugin shipped, never used). Resolved by removing the premature plugin; DB lands when a bootstrap-created adapter + ownership decision exists. **Open decision for you:** the portable `performShutdown` closes the *injected* (caller-owned) DB unconditionally — this contradicts the caller-owned rule hardened for the Node path in task 0026. Whether the portable layer should close injected DBs at all is a deliberate call, deferred.

**Fix-pass result:** 3 defects fixed (dead code, doc lie, stale comments) + R8 ADR added. 2 requirements (R4/R5 onStop+collapse) are PARTIAL by sound design constraint, not omission. No behavior change.


### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


