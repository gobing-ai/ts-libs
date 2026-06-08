---
name: "Complete infra plugin migration: stop-reason in onStop, caller-owned DB, user-stop + node-telemetry as plugins"
description: "Complete infra plugin migration: stop-reason in onStop, caller-owned DB, user-stop + node-telemetry as plugins"
status: Done
created_at: 2026-06-08T23:43:34.289Z
updated_at: 2026-06-08T23:56:53.691Z
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

## 0028. "Complete infra plugin migration: stop-reason in onStop, caller-owned DB, user-stop + node-telemetry as plugins"

### Background

Follow-up to task 0027 (partial migration, status WIP). 0027 left R4/R5 PARTIAL because PluginHost.stopAll()/onStop(host) cannot carry the ApplicationStopReason that the user stop callback needs, so user-stop + DB-close stay inline in performShutdown. This task removes that blocker and completes the collapse. Decisions (Robin, 2026-06-08): (1) thread an OPTIONAL stop reason through teardown as a plain string on the host (stopAll(reason?: string), onStop(host, reason?: string)) so the portable plugin core stays decoupled from app-level ApplicationStopReason (which is a string union and thus assignable); (2) portable runApplication STOPS closing caller-injected DB adapters (caller-owned, consistent with task 0026) -- a deliberate behavior change; bootstrap-CREATED adapters get a dbPlugin whose onStop closes them.


### Requirements

- [x] **R1 — reason through teardown** → **MET** | `types.ts:46,52`; `host.ts:107,128`. Plain-string reason keeps plugin core runtime-neutral.
- [x] **R2 — user-stop as plugin** → **MET** | `builtins.ts:103-123` onStop(reason); wired `index.ts:206`.
- [x] **R3 — caller-owned DB** → **MET** | inline `db.close` removed; injected `services.db` never closed by portable layer. **Behavior change — see release note.**
- [x] **R4 — dbPlugin owned-only, wired** → **MET** | `builtins.ts:163`; registered `application-node.ts:290` (no dead code).
- [x] **R5 — node-telemetry plugin** → **MET** | `application-node.ts:263-278`; task-0026 manual rollback removed.
- [x] **R6 — orchestrator collapsed** → **MET** | `performShutdown` = `stopAll(reason)→unloadAll(reason)`.
- [x] **R7 — zero order change except DB** → **MET** | 0026 leak regression green via plugin path; only injected-DB-close removed (intended).
- [x] **R8 — tests + gates** → **MET** | 1265 pass / 0 fail; spur-check + build green.
- [x] **R9 — docs/ADR** → **MET** | ADR `docs/00_ADR.md:798`; README shutdown section updated this pass.

**Verdict: PASS** — 9/9 MET. Completes task 0027's PARTIAL R4/R5. Only doc-drift findings, all fixed. ⚠ R3 caller-owned-DB is a behavior change for the release note.


### Q&A



### Design

**Root cause being fixed:** `PluginHost.stopAll()` and `onStop(host)` carry no stop reason, so the user
`stop(app, reason)` callback (and any reason-aware teardown) cannot be a plugin. This single gap is why
task 0027 left R4/R5 PARTIAL with user-stop + DB-close stranded inline. Phase 1 closes it; the rest
follows mechanically.

**Decoupling constraint (task 0025):** `application/plugins/*` must stay runtime-neutral. So the host's
reason param is typed as plain `string`, NOT the app-level `ApplicationStopReason`
(`'manual'|'signal'|'error'|'shutdown'`). Since that type is a string union, `runApplication` passes its
value with no cast and no import leaking into the plugin core. The plugin core gains a generic
"teardown reason" capability without knowing the app's vocabulary.

**DB ownership — caller-owned (Robin, 2026-06-08):** the portable `runApplication` stops closing
injected `services.db`. Rule, applied uniformly across both layers: *close what you create; never close
what you were handed*. Today the portable layer creates no DB, so it closes nothing. The Node subpath
creates an adapter when `database.enabled` → that one is owned and closed via `dbPlugin.onStop`. This
removes the latent double-close (a caller who created + closes their own adapter would otherwise see the
bootstrap close it too) and unifies with task 0026's Node-path rule. It IS a behavior change and is
called out for the release.

**Why dbPlugin is safe now (was removed in 0027):** in 0027 a DB plugin couldn't preserve order — its
`onStop` ran inside `stopAll`, before user-stop, risking use-after-close. With Phase 1 (reason-carrying
stopAll) AND Phase 2 (user-stop itself a plugin, registered before scheduler), the relative order of
user-stop vs DB-close is now expressible purely through registration order — so an owned dbPlugin slots
in correctly. dbPlugin returns ONLY for owned adapters and MUST be registered (the 0027 dead-code defect
must not recur).

**Resulting performShutdown:** `stopAll(reason) → unloadAll(reason)`. Nothing inline. The orchestrator's
shutdown is fully host-driven; the 0026 startup-failure rollback is the catch-block's
`stopAll/unloadAll`, also reason-carrying.

**Guardrail:** the 0026 resource-leak regression is the canary at every shutdown-touching phase. If the
plugin path can't reproduce reverse-order rollback with teardown reason, the change is wrong — stop.

**Rejected:** (a) hardcoding a reason in onStop to force user-stop into a plugin without Phase 1 — drops
the manual/signal/error/shutdown distinction (observable in logs/telemetry); (b) a `services.dbOwned`
flag to keep closing injected DBs — encodes the ownership ambiguity permanently; one clean rule is
better (Robin chose caller-owned).


### Solution

Thread an optional, runtime-neutral stop reason through `PluginHost.stopAll`/`onStop` (keystone), then
convert user-stop into a reason-aware plugin and stop the portable layer from closing caller-injected
DBs (caller-owned rule, a deliberate behavior change) — collapsing `performShutdown` to
`stopAll(reason) → unloadAll(reason)`. Finally move Node telemetry (and the Node-created, owned DB
adapter) onto the plugin lifecycle, retiring the manual task-0026 rollback. Completes task 0027's
PARTIAL R4/R5. Delivered in 4 gated phases; the 0026 startup-leak regression is the canary throughout.
Additive API (optional `reason`); the only behavior change is the intentional caller-owned-DB shift.


### Plan

Four phases, each gate-green and shippable. The reason-threading (Phase 1) is the keystone — it unblocks
everything else. Ordered strictly by dependency: nothing else can be done correctly before Phase 1.

### Phase 1 — Stop reason through teardown (KEYSTONE, no behavior change)
1. `Plugin.onStop?(host, reason?: string)`, `onUnload?(host, reason?: string)` (types.ts).
2. `PluginHost.stopAll(reason?: string)` / `unloadAll(reason?: string)` pass the reason to each hook
   (host.ts). Reason typed as plain `string` — core stays runtime-neutral.
3. `runApplication`/`performShutdown` call `stopAll(reason)`/`unloadAll(reason)`.
4. Unit tests: reason reaches onStop; absent reason still works; existing plugins unaffected.
5. **Gate. Ship.** Pure additive; no observable change.

### Phase 2 — User-stop as a plugin (completes 0027 R4) + caller-owned DB (0027 R5 / this R3)
1. `userCallbackPlugin` gains `onStop(host, reason)` → `options.stop(app, reason)`. Wire `options.stop`
   into the factory.
2. Remove inline user-stop AND inline `app.db.close()` from `performShutdown`. performShutdown becomes
   `stopAll(reason) → unloadAll(reason)`.
3. **Behavior change:** injected DBs are no longer closed by the bootstrap. Document + test
   (assert injected db.close NOT called).
4. Tests: user-stop fires with correct reason in reverse order; injected-db-not-closed.
5. **Gate. Ship.** This is the breaking-behavior phase — call it out for the release.

### Phase 3 — Node telemetry + owned DB plugins (Node subpath)
1. `nodeTelemetryPlugin` (failFast, onStart=initNodeTelemetry, onStop=shutdownNodeTelemetry) registered
   in runNodeApplication's service ring; remove the manual try/catch rollback (task 0026).
2. Re-add `dbPlugin` (reason-aware onStop=close); register it in runNodeApplication ONLY when the subpath
   CREATES the adapter (owned). Wired + tested (no dead code).
3. Tests: node-telemetry teardown; the task-0026 startup-failure leak regression passes through the
   plugin path; owned-db closed, injected-db not.
4. **Gate. Ship.**

### Phase 4 — Docs/ADR + release
1. ADR follow-up entry: reason-carrying teardown, caller-owned-DB break, completed collapse.
2. README shutdown section. Mark task 0027 R4/R5 as MET (resolved here).
3. **Release note: caller-owned-DB is a behavior change → minor/major bump per semver judgment.**
4. Final full gate + build.

**Guardrail (every phase touching shutdown):** the task-0026 startup-failure resource-leak regression
must stay green. It is the canary for reverse-order rollback correctness.


### Review

## Review — 2026-06-08 (`/rd3:dev-verify 0028 --force --fix all`)

**Verdict: PASS** — all R1–R9 MET. Implementation faithful to the agreed design; only doc-drift findings, all fixed this pass. Gate: `bun run spur-check` 1265 pass / 0 fail, 38 rules green + `bun run build` 8 packages.

### Phase 7 — SECU (doc-drift fixed; no correctness/security issues)

| # | Title | Dimension | Location | Resolution |
|---|-------|-----------|----------|------------|
| 1 | Stale comment claims "DB close stays inline" after R3 removed it | Usability (P3) | index.ts:172 | **FIXED** — replaced with the caller-owned-DB rule. |
| 2 | `runApplication` JSDoc lists obsolete 8-step startup + old shutdown order | Usability (P3) | index.ts:78-83 | **FIXED** — rewritten to the plugin-driven register→loadAll/startAll + reverse-teardown model. |
| 3 | Garbled/dangling catch-block comment (obsolete scheduler reasoning) | Usability (P3) | index.ts:219-222 | **FIXED** — rewritten to describe reverse-order best-effort teardown. |
| 4 | README shutdown section stale (R9 gap — no caller-owned-DB note, old order) | Usability (P3) | packages/infra/README.md:455 | **FIXED** — documented plugin-driven lifecycle + the caller-owned-DB behavior change. |

Security/efficiency/correctness: clean. No secrets, no injection, no `any`. The `events as unknown as EventBus<EventMap>` cast is the documented task-0025 invariance cast. Node-owned plugins (`builtin:node-telemetry`, `dbPlugin`) are `failFast`/fail-soft as designed; no double-close (injected DB not closed by portable layer, owned DB closed by its plugin).

### Phase 8 — Requirements traceability (9/9 MET)

| Req | Verdict | Evidence |
|-----|---------|----------|
| R1 reason through teardown | MET | `types.ts:46,52` (`onStop/onUnload(host, reason?)`); `host.ts:107,128` (`stopAll/unloadAll(reason?)`) |
| R2 user-stop as plugin | MET | `builtins.ts:103-123` `onStop(reason)`; wired `index.ts:206-212` |
| R3 caller-owned DB | MET | no inline `db.close` in `index.ts`; injected `services.db` untouched |
| R4 dbPlugin owned-only, wired | MET | `builtins.ts:163`; **registered** `application-node.ts:290` (no dead code — 0027 defect not recurred) |
| R5 node-telemetry plugin | MET | `application-node.ts:263-278`; manual task-0026 try/catch rollback removed |
| R6 orchestrator collapsed | MET | `performShutdown` = `stopAll(reason)→unloadAll(reason)`, no inline steps |
| R7 zero order change except DB | MET | task-0026 startup-leak regression passes through plugin path; only injected-DB-close removed (intended) |
| R8 tests + gates | MET | 1265 pass / 0 fail; spur-check + build green |
| R9 docs/ADR | MET | ADR entry `docs/00_ADR.md:798`; README updated this pass |

**This completes task 0027's PARTIAL R4/R5** — user-stop and the orchestrator collapse are now fully plugin-driven.

**⚠ Release note:** R3 is a **behavior change** — the portable `runApplication` no longer closes caller-injected `services.db`. Callers who relied on auto-close must close their own adapter. Flag for the next version bump (minor or major per semver judgment; the safe call is **major** since existing callers' shutdown behavior changes).

**Fix-pass result:** 4 doc-drift findings fixed (3 code comments + README R9 gap). 0 correctness/security findings. All requirements MET.


### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


