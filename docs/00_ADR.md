---
name: Architecture Decision Records
doc: 00_ADR
owns: WHY — which cross-cutting decision was made, and the one-line reason
authority: authoritative
version: 1.3.0
owner: Robin Min
updated_at: 2026-09-20
read_before: any structural change
edit_rules: 99 §6.1
sync: [T1, T2]
---

# 00 ADR — ts-libs

Architecture and release decisions for this monorepo. New cross-cutting decisions are appended as
`ADR-NNN`; maintenance follows `docs/99_PROJECT_CONSTITUTION.md` §6.1.

---

## ADR-001: Bun-Workspace Monorepo of Independently Published Packages

**Status:** Accepted · **Date:** 2026-05-31

One Bun workspace (`"workspaces": ["packages/*"]`); each `@gobing-ai/ts-*` package publishes
independently to npm but is **versioned in lockstep** (every release bumps all manifests to the same
version). Bun is runtime/package-manager/test-runner, Biome is lint/format, per-package `tsc` is the type gate.

---

## ADR-002: Internal Dependencies Use the `workspace:*` Protocol

**Status:** Accepted · **Date:** 2026-05-31

Every internal `@gobing-ai/ts-*` dependency declares `"workspace:*"` — **never a hand-written version
range** — so dependency ranges can't drift; `bump-ver` only touches the `version` field.

---

## ADR-003: Resolve `workspace:*` to a Caret Range at Publish Time

**Status:** Accepted · **Date:** 2026-05-31

The publish step (`scripts/lib/release-commands.ts` + `scripts/lib/workspace-deps.ts`) rewrites each
`workspace:*` to `^<sibling-version>` in the on-disk manifest before `npm publish`, then restores it —
**fail-closed**: any surviving `workspace:` range refuses the publish. Preserve substitution + the
fail-closed guard in any release-flow change.

---

## ADR-004: TypeScript Path Aliases Resolve Cross-Package Imports to Source

**Status:** Accepted · **Date:** 2026-05-31

Every package importing a sibling declares a `compilerOptions.paths` entry mapping `@gobing-ai/ts-<pkg>` →
`../<pkg>/src/index`, so `tsc` typechecks against live source — **complementary to**, not a replacement
for, the `workspace:*` dependency (refined by **ADR-012**: `dependencies` = direct imports, `paths` =
transitive source closure).

---

## ADR-005: `@gobing-ai/ts-db` Is a Drizzle-Free Facade

**Status:** Accepted · **Date:** 2026-05-31

`ts-db` is a complete facade — public surface is `createDbAdapter` + `BaseDao` + `EntityDao` (schema
helpers behind `@gobing-ai/ts-db/schema`, ADR-007); **no package other than `ts-db` may import
`drizzle-orm`**, enforced by the `db-boundaries` spur rule. `drizzle-zod`/`zod` are optional peers.

### ADR-005 Addendum — Main Barrel Does Not Statically Export Adapter Classes (2026-08-12, task 0060 C1)

**Status:** Accepted

The main barrel `@gobing-ai/ts-db` must not statically value-export adapter implementation classes.
`D1Adapter` pulls in `drizzle-orm/d1` at import time, so `import { D1Adapter } from '@gobing-ai/ts-db'`
loaded the Cloudflare D1 dialect in every consumer even when they never touched D1. Adapter classes live
on their dedicated subpaths only: `D1Adapter` is exported from `@gobing-ai/ts-db/d1`. Consumers use
`createDbAdapter({ driver: 'd1', binding })` (which dynamic-imports the adapter) or the subpath.
`InternalDb` stays a type-only / `@internal` re-export.

---

## ADR-006: Quality Gates Are Enforced, Not Advisory

**Status:** Accepted · **Date:** 2026-05-31

`bun run spur-check` is the canonical gate (Biome + per-package `tsc` + `spur` pre-check + `bun test`
coverage + `spur` post-check, all `--fail-on warning`); architectural invariants live as spur rules under
`.spur/rules/` and must stay green. New cross-cutting invariants are added as rules, not review habits.

---

## ADR-007: `defineTable` Is the Single Source of Truth — One Table → DDL + Zod

**Status:** Accepted · **Date:** 2026-06-01 · **Targets:** `@gobing-ai/ts-db/schema`

A Drizzle table object is the single source of truth: `defineTable(name, columns)` →
`{ table, insertSchema, selectSchema, createTableSql }` (DDL generated at runtime via `getTableConfig`,
zod via `drizzle-zod`), no hand-written `CREATE TABLE` beside a Drizzle table (enforced by
`no-hand-written-ddl-for-drizzle-tables`). The surface moves to the `@gobing-ai/ts-db/schema` subpath so
`drizzle-zod`/`zod` optionality is structural (main barrel imports neither).

---

## ADR-008: Runtime Selection Is the `getFs()` Global Swap, Not a `RuntimeFactory` — **SUPERSEDED by ADR-011**

**Status:** Superseded · **Date:** 2026-06-02 · **Superseded by:** ADR-011 · **Targets:** `@gobing-ai/ts-runtime`

Originally kept the `setFileSystem`/`getFs()` global swap and removed the unused `RuntimeFactory`.
**Superseded by ADR-011**, which reintroduced the factory pattern with real implementations and deprecated
the global swap.

---

## ADR-009: `ts-infra` Telemetry Instruments Against the Global Provider; Export Is an Opt-In Subpath

**Status:** Accepted · **Date:** 2026-06-02 · **Targets:** `@gobing-ai/ts-infra`

`@gobing-ai/ts-infra` core **only instruments** against the globally-registered OTel provider (no-op when
none); `initTelemetry` registers no provider. Export is opt-in via `@gobing-ai/ts-infra/otel-node`, and the
OTLP SDK/exporter packages are optional peers the main barrel never imports.

### ADR-009 Addendum — Global Provider Default, Injectable Telemetry Ports Allowed (2026-06-05)

Refined, not reversed: the global provider stays the default, but core instrumentation helpers may also
accept **optional structural telemetry ports** (`TracerPort`/`MeterPort`) for isolated/embedded use —
exporter ownership still stays outside the core (behind `/otel-*` subpaths, ADR-014).

---

## ADR-010: Shared Plugin Mechanism Lives in `ts-runtime`; Engine Concepts Stay Separate

**Status:** Accepted · **Date:** 2026-06-03 · **Targets:** `@gobing-ai/ts-runtime`, `@gobing-ai/ts-rule-engine`, `@gobing-ai/ts-dual-workflow-engine`

Share the **mechanism, not the concepts**: a domain-agnostic capability registry + trust-gated extension
loader lives in `@gobing-ai/ts-runtime`, exported from `@gobing-ai/ts-runtime/extension` *(originally
`/plugin`; renamed 2026-06-08 — see ADR-016)*; each engine keeps its own kinds, schemas, error
types, and override semantics. Key invariants: the core never imports an engine; the trust gate is
fail-closed (throws before any `import()` when `allowExtensions !== true`); `assertRelativeExtensionPath`
guards path traversal at load time. A driver registry, shell-action trust model, and shared template engine
are explicitly deferred.

---

## ADR-011: Runtime Factory Pattern + Path Utility Consolidation + Runtime Boundary Rules

**Status:** Accepted · **Date:** 2026-06-04 · **Targets:** `@gobing-ai/ts-runtime`, `.spur/rules/`

Reintroduce `loadRuntimeFactory()` (auto-detecting `nodeBunFactory`/`cloudflareWorkersFactory`); collapse
the split file-system/process interfaces into a single union-return `FileSystem` + one `ProcessExecutor`
(old surfaces `@deprecated`); add runtime-portable path utilities; and enforce platform-API containment via
`.spur/rules/typescript/runtime-boundaries.yaml` (`no-direct-node-path`/`-url`/`-os`/`-bun-platform`/`-process-exit`).

### ADR-011 Addendum — Canonical Runtime Surface and Standard Context Services (2026-06-05)

The canonical root-exported `FileSystem` is the union-return interface from `file-system.ts` (`fs.ts` is
compatibility-only); `RuntimeContext` standard services are `config`, `fileSystem`, and `processExecutor`
when `capabilities.hasProcessExecution === true`. New code prefers `createRuntimeContextFromFactory()` over `getFs()`.

### ADR-011 Addendum — Runtime Boundary Is Default Ownership, Not an Adapter Ban (2026-06-05)

`ts-runtime` is the **default** owner of raw platform primitives; `ts-infra` core stays platform-neutral,
but platform-specific infra adapters are allowed as **opt-in subpaths** (e.g. `/otel-node`,
`/scheduler-node`) that the main barrel never statically imports. `.spur/rules/` distinguishes core from
sanctioned subpaths rather than banning adapters.

---

## ADR-012: `dependencies` Track Direct Imports; `paths` Track the Transitive Source Closure

**Status:** Accepted · **Date:** 2026-06-04 · **Targets:** every `@gobing-ai/ts-*` package · **Refines:** ADR-002, ADR-004

`dependencies` = a package's **direct** `@gobing-ai/ts-*` imports only (a declared dep no `src/**` line
imports is removed); `tsconfig` `paths` = the **full transitive source closure** `tsc` needs. The two
overlap but are not equal — ADR-004's "stay in sync" means only "never drop a direct dependency for a path
alias."

### ADR-012 Addendum — Optional peerDependency for Cycle-Forced Sibling Imports (2026-07-10)

The rule "`dependencies` = direct imports" gains one carve-out: **a literal dynamic `import()` of a sibling
package that would create a manifest cycle as a regular `dependencies` entry is declared as an optional
`peerDependencies` entry (with `peerDependenciesMeta.<pkg>.optional: true`), and the `tsconfig` `paths`
entry still tracks it for the source closure.** A regular `dependencies` entry would ship the cycle to npm
and force-install the sibling (plus its peer set) on every consumer, including those who never call the
code path; an optional peer is metadata-only, cycle-tolerant, and auto-installs for nobody.

Canonical instance: `@gobing-ai/ts-runtime` → `@gobing-ai/ts-db` via the literal
`await import('@gobing-ai/ts-db')` in `nodeBunFactory.createDbAdapter` (`packages/runtime/src/runtime-node-bun.ts`).
`ts-db` depends on `ts-runtime`, so a regular dep cycles; the literal specifier (required so Bun `--compile`
can bundle it) makes the import bundler-visible and thus "direct" under ADR-012's plain reading — this
addendum sanctions the optional-peer form as the cycle-safe equivalent. The `devDependencies` entry is
retained so in-repo tests/typecheck resolve the package; both fields carry `workspace:*` (publish-time
resolution under ADR-003 covers `peerDependencies` — `scripts/lib/workspace-deps.ts` `DEP_FIELDS`).

---

## ADR-013: Workflow Run Lifecycle Is a Deep Module Built on `ts-infra` Observability

**Status:** Accepted · **Date:** 2026-06-04 · **Targets:** `@gobing-ai/ts-dual-workflow-engine`

Run identity, the persistence sequence, and observability are consolidated into one deep module
(`RunLifecycle`, `src/run-lifecycle.ts`) that both drivers call into while keeping their distinct dialect
control loops; the engine consumes `ts-infra` for logs + OTel traces (global provider, ADR-009). ADR-006 §7's
still-deferred item is narrowed to *driver-dispatch abstraction* only — lifecycle sharing is permitted.

### ADR-013 Addendum — Error Policy Alignment (2026-06-04)

Shared severity vocabulary + config-default→runtime-override pattern, but distinct policy verbs:
rule-engine uses `stopOnFirst` (traversal control, default exhaustive); workflow-engine uses `onError`
(`'fail'` default / `'continue'`). No shared code between the engines.

### ADR-013 Addendum — Engine EventBus Observability Layer (2026-06-04)

Three distinct, additive observability layers: **logs** (`getLogger`), **traces** (`traceAsync`), and
**events** (`EventBus`, injected via `options.events?`). Each engine owns its event map with a prefixed
namespace (`rule.` / `workflow.`); omitting `events` leaves the default path unchanged.

### ADR-013 Addendum — Observability Layering: Injected EventBus vs Structural Port (2026-06-04)

Selection rule: a package that can import `EventBus` from `ts-infra` without a cycle **injects it
directly** (above `ts-infra`); a package at or below `ts-infra` emits through a zero-dependency
**structural port** (`ProcessEventSink`, `TracerPort`) that a higher layer adapts. Ports default to no-ops.

---

## ADR-014: `ts-infra` Core/Adapter Boundary

**Status:** Accepted · **Date:** 2026-06-05 · **Targets:** `@gobing-ai/ts-infra`

The `@gobing-ai/ts-infra` core barrel stays portable and dependency-light (contracts + runtime-neutral
primitives); storage-/runtime-/exporter-backed implementations live behind opt-in subpaths
(`/job-queue-db`, `/otel-node`, `/scheduler-node`, …) that the main barrel **never statically imports as
values**. Adapter-only dependencies are optional peers; event maps are owned by the package that owns the behavior.

---

## ADR-015: Bare `PluginHost` + `Plugin` Lifecycle Core in `ts-infra`

**Status:** Accepted · **Date:** 2026-06-08 · **Targets:** `@gobing-ai/ts-infra`

Add a bare `PluginHost` + `Plugin` lifecycle core (`name`/`version` + `onLoad`/`onUnload`/`onStart`/`onStop`,
insertion-ordered, fail-fast `loadAll`, fail-soft reverse-order `stopAll`/`unloadAll`) to the portable
`application` subpath and integrate it into `runApplication`; zero-cost when no plugins are provided.
Capability registries, trust ladder, and manifest schema are deferred.

---

## ADR-016: Rename `ts-runtime/plugin` Subpath → `ts-runtime/extension`

**Status:** Accepted · **Date:** 2026-06-08 · **Targets:** `@gobing-ai/ts-runtime` · **Amends:** ADR-010

Rename the ADR-010 shared-core subpath `@gobing-ai/ts-runtime/plugin` → `@gobing-ai/ts-runtime/extension`
(dirs `src/plugin/`+`src/plugin.ts` → `src/extension/`+`src/extension.ts`; public symbols unchanged) to
disambiguate from the unrelated `ts-infra` application-lifecycle `PluginHost` (ADR-015). In-repo only —
spur-new consumes no such subpath.

---

## ADR-017: Infra Services as Built-In Plugins on the `runApplication` Lifecycle

**Status:** Superseded by ADR-018 (which completed the migration) · **Date:** 2026-06-08 · **Targets:** `@gobing-ai/ts-infra`

Migrate `runApplication`'s service init/shutdown onto the ADR-015 `Plugin` lifecycle (logger, telemetry,
scheduler, and the user `start` callback become built-in plugins; A→Z init / Z→A shutdown from registration
order), and add additive `failFast?: boolean` to `Plugin` (`startAll` rethrows for `failFast` plugins;
`loadAll` always fail-fast, `stopAll`/`unloadAll` always fail-soft). Left user-stop + DB-close inline
pending a stop-reason mechanism — completed in ADR-018.

---

## ADR-018: Plugin Migration Completion — Reason-Carrying Teardown + Caller-Owned DB

**Status:** Accepted · **Date:** 2026-06-08 · **Targets:** `@gobing-ai/ts-infra` · **Completes:** ADR-017

Thread an optional runtime-neutral `reason?: string` through teardown (`onStop`/`onUnload`/`stopAll`/`unloadAll`),
making user-stop and the Node-owned services (telemetry, DB) plugins and collapsing `performShutdown` to
`stopAll(reason) → unloadAll(reason)`. **Behavior change:** the portable layer no longer closes a
caller-injected `services.db` (caller-owned rule — *close what you create, never what you were handed*);
only bootstrap-created adapters (Node subpath) are closed via a `dbPlugin`.

---

## ADR-019: Deprecated FileSystem Surface Removal — Single Canonical `FileSystem` Interface

**Status:** Accepted · **Date:** 2026-06-20 · **Targets:** `@gobing-ai/ts-runtime` · **Amends:** ADR-011

Deleted the deprecated `FileSystem`/`SyncFileSystem` interfaces, `NodeFileSystem`/`NodeSyncFileSystem`/
`CloudflareFileSystem` classes, `getFs()`/`setFileSystem()` singletons, and `ensureDirForFileSync()` from
`packages/runtime/src/fs.ts`. The canonical `FileSystem` interface (union-return, from `file-system.ts`)
and `createNodeFileSystem()`/`createCfFileSystem()` factories are the only filesystem surface.
Utility functions (`walkDir`, `readJsonFile`, `atomicWriteFile`, etc.) now accept the canonical
`FileSystem` and default to `createNodeFileSystem()`. `RuleEngineOptions.fileSystem?: FileSystem` (and
`RuleContext.fileSystem`) provides a testable DI seam for the rule engine. **Breaking change:**
deprecated runtime exports removed; consumers must migrate to `createNodeFileSystem()`.

## ADR-020: Atomic Workflow Transition Persistence

**Status:** Accepted · **Date:** 2026-07-10 · **Targets:** `@gobing-ai/ts-db`, `@gobing-ai/ts-dual-workflow-engine`

Added `DbAdapter.batch()` (BunSqlite via `db.transaction`, D1 via `batch()`) and
`WorkflowPersistenceAdapter.commitTransition()` so the transition record, state snapshot, and phase write
commit in a single atomic DB batch — eliminating partial-state windows when the process fails between
`saveTransition()` and `saveWorkflowState()`. `RunLifecycle.commitHop` wraps all three writes; the three
commit sites (`service.ts`, `state-machine.ts`, `transition-flow.ts`) use it for every persisted transition.

---

## ADR-021: Streaming JSONL Importer

**Status:** Accepted · **Date:** 2026-07-10 · **Targets:** `@gobing-ai/ts-runtime`, `@gobing-ai/ts-llm-jsonl-importer`

Added `FileSystem.readFileStream()` to the canonical interface (`createReadStream` from `node:fs` on Node/Bun,
`undefined` on Cloudflare). `ts-llm-jsonl-importer` switches to a streaming async-generator line reader that
yields one line at a time, falling back to `readFile().split()` when `readFileStream` is unavailable — avoiding
full-file buffering for multi-GB LLM history files while preserving checkpoint semantics.

---

## ADR-022: Symlink-Safe Extension Confinement

**Status:** Accepted · **Date:** 2026-07-10 · **Targets:** `@gobing-ai/ts-runtime` · **Amends:** ADR-010

Added `realPath` option to `LoadExtensionsOptions` so the extension loader canonicalizes both the resolved
`baseDir + path` and `baseDir` after the string-level `assertRelativeExtensionPath` guard, closing a
symlink-traversal vector where a relative path passing the string check could resolve through a symlink to
an arbitrary absolute location. The option defaults to `undefined` (off) for stubs without a real filesystem;
composition sites in `ts-rule-engine` and `ts-dual-workflow-engine` forward it from their callers.

**Addendum (2026-07-10, task 0041 verify):** real import policy gets real confinement by default —
`ts-rule-engine`'s `loadExtensionsIntoHost` defaults `realPath` to the node canonicalizer whenever the
default (real dynamic-import) `moduleLoader` is in effect; pass `realPath: undefined` explicitly to opt out
(pnpm/Nix symlinked layouts). A custom `moduleLoader` owns its confinement policy — no default applies.
`ts-dual-workflow-engine` requires an explicit `moduleLoader`, so confinement there stays caller-owned.

---

## ADR-023: Advisory Verdicts — Runtime Root Portability (A1), ProcessExecutor Interface (A2), Open Importer Source Registry (A3), InboxMessageDao Port (A4)

**Status:** Accepted (follow-up) · **Date:** 2026-07-10 · **Targets:** `@gobing-ai/ts-runtime`, `@gobing-ai/ts-ai-runner`, `@gobing-ai/ts-llm-jsonl-importer`, `@gobing-ai/ts-db`

All four advisory candidates from the 2026-07-10 codex review are **accepted as follow-up tasks** (no
implementation in task 0041): (A1) injectable `RuntimePaths` seam for cwd/home portability; (A2) publish
`ProcessExecutor` interface as the canonical type with concrete classes as default wiring behind a factory;
(A3) `runJsonlImport(source | SourceDefinition, …)` overload to open the importer source registry; (A4)
ai-runner-owned `MessageStore` interface that `InboxMessageDao` satisfies structurally, loosening ts-db
coupling consistent with the ts-db-as-optional-peer direction (task 0040).

**Addendum (2026-08-12, task 0061).** The A2 leftover — `getGitContext` in `@gobing-ai/ts-ai-runner`
still default-constructing the deprecated `BunSyncProcessExecutor` — is **closed**. `getGitContext` is
now async (`Promise<string | null>`) and defaults to `nodeBunFactory.createProcessExecutor()`. A
deprecated `getGitContextSync` keeps the old sync semantics for one release. `BunSyncProcessExecutor`
remains a published (deprecated) `@gobing-ai/ts-runtime` export for other out-of-repo sync callers; only
this package stopped default-constructing it. R16 (importer ETL table/DDL locality) also landed in the
same task: `HISTORY_IMPORT_SCHEMA_SQL` no longer hard-codes any `history_etl_*` CREATE; every built-in
ETL table is created solely by `ETL_TABLE_DDL` / `ensureTargetTables` looping `SOURCE_DEFINITIONS`, so
adding a built-in source no longer requires editing the static SQL.

**Amendment (2026-09-16, task 0068 C02).** The R16 eager-materialization guarantee above is
**superseded**: `applyHistoryImportSchema` installs the static contract and bookkeeping tables only,
and each generic `history_etl_*` table is materialized lazily by `ETL_TABLE_DDL` on the first accepted
write. Reason: schema application and empty scans must not leave unused empty tables behind.
**Detail:** `packages/llm-jsonl-importer/README.md` (Stored Tables),
`packages/llm-jsonl-importer/src/jsonl-importer-dao.ts`.

---

## ADR-024: SchedulerAdapter.stop() Drains In-Flight Ticks

**Status:** Accepted · **Date:** 2026-07-31 · **Targets:** `@gobing-ai/ts-infra` · **Amends:** ADR-014

**Decision:** `SchedulerAdapter.stop()` drains in-flight ticks, bounded by a configurable
`drainTimeoutMs`, rather than abandoning them.

**Context.** `NodeSchedulerAdapter` launched each tick as a floating promise with no retained handle, so
`stop()` could clear future timers but had no way to observe — let alone await — a tick already executing.
`Application` documents shutdown (`application/index.ts`) as a deterministic reverse fan-out, so
`await app.stop()` followed by process exit could tear down an action mid-execution: a torn DB write or a
half-flushed batch. The defect is identical in shape to the `DBQueueConsumer` drain race fixed alongside
this decision, differing only in blast radius (the consumer additionally asserted a clean drain it did not
perform; the scheduler made no claim at all).

**Alternatives considered.** Abandoning in-flight ticks was rejected because it contradicts the documented
deterministic shutdown and leaves no path to observe completion. Mirroring the proven
`drainTimeoutMs` + `settleWithin` shape from `DBQueueConsumer` (rather than inventing a second mechanism)
keeps the two adapters from drifting; `settleWithin` is therefore extracted to
`packages/infra/src/internals/drain.ts` and shared by both.

**Node adapter.** Retains tick promises in a `Set<Promise<void>>` (unlike the consumer's single
`pollPromise` + `inFlight` counter — `setInterval` can stack ticks when action duration exceeds the
interval). `_onScheduledTick` never rejects (try/catch records `scheduler.job.failed.total`), so
`p.then(cleanup, cleanup)` removes the entry on both paths with no unhandled-rejection risk. `stop()` shares
a single absolute deadline across all awaited ticks so the bound is not compounded per tick.

**Cloudflare adapter.** `stop()` is a deliberate no-op: Workers fire Cron Triggers externally (no timer to
cancel here) and `handleScheduledEvent` already bounds each action via `ctx.waitUntil()`, the runtime's own
drain. The contract — "future ticks cancelled, in-flight work bounded" — holds without an explicit wait.

**Compatibility.** Classified as a **fix**, not a breaking change: the `stop()` signature is unchanged
(`Promise<void>`) and callers that already `await stop()` continue to work. The only observable difference
is timing — `stop()` may block up to `drainTimeoutMs` (default 30000) when a tick is in flight — which is
the behaviour `Application`'s deterministic shutdown already assumed it had. Prior behaviour was a bug.

## ADR-025: Run Interruption Contract — Ownership Claim, Rerun-Enter Resume, Interrupted Status

**Status:** Accepted · **Date:** 2026-09-19 · **Targets:** `@gobing-ai/ts-dual-workflow-engine` · **Breaking:** 0.5.0

**Decision:** Durable runs gain a first-class interruption lifecycle. `WorkflowStatus` widens with
`'interrupted'`; `WorkflowPersistenceAdapter` gains two required methods — `claimRunOwnership(runId, owner,
expectedStatuses)` (CAS paused/interrupted → running, recording `owner_attempt`/`owner_pid` at the mutation)
and `interruptRun(runId, reason)` (CAS running → interrupted). `resumeRun` accepts interrupted runs via two
modes: `skip-enter` (default for paused; pause-point actions are treated as complete) and `rerun-enter`
(default for interrupted; re-executes on-enter actions, permitted only into states/nodes explicitly marked
`resumeRerun: true`, refused loudly with `FSMError` otherwise). A lost claim race raises typed
`WorkflowResumeError` carrying the winning owner.

**Context.** Resume previously executed an unconditional `finalizeRun(runId, 'running', '')` — status flip
without ownership. Two operators resuming the same durable run after a crash both proceeded: actions ran
twice, the second writer's phase snapshots clobbered the first's, and nothing recorded which process owned
the run. Separately, resume only accepted paused runs, so a crashed process left the run stuck in `running`
forever (no crash marker, no recovery path), and the resume-skip semantics silently swallowed enter actions
on state-machine runs that resumed from a persisted snapshot — correct for pauses, wrong for interruptions
whose actions may never have executed.

**Alternatives considered.** Lease/heartbeat ownership (expiring locks) was rejected: no runtime in this
monorepo has a shared clock guarantee, and the failure mode (silent lease steal) is worse than the loud one
(explicit interrupt + fresh claim). Resume-without-claim (status check only) was rejected as it preserves
the original TOCTOU. Silent rerun of unmarked states was rejected — re-executing non-idempotent actions
(onEnter that increments counters, emits messages) must be opt-in at the workflow author's level.

**Schema.** The `runs` table gains `owner_attempt TEXT`, `owner_pid INTEGER`, `interrupt_reason TEXT`.
Fresh databases get the columns in `CREATE TABLE`; existing databases via guarded `ALTER TABLE` statements
in `WORKFLOW_ENGINE_MIGRATIONS_SQL` (duplicate-column errors swallowed). `claimRunOwnership` clears
`completed_at` (the legacy resume wrote `''`; NULL is the real empty value).

**Compatibility.** Breaking by design (0.5.0): the status union widened, two required adapter methods were
added, `workflow.run.resumed` gained required payload fields (`resumeMode`, `ownerAttemptId`), and one event
was added (`workflow.run.interrupted`). Known implementors (`ObservableWorkflowAdapter`,
`WorkflowActionTraceWriter` in gobing.ai/spur-new) are updated in the same change window. Callers that never
touch resume/interrupt semantics are source-compatible apart from the adapter interface.

**Addendum (2026-09-23, task 0086 R8): owner-fenced finalization.** The claim race above still had an
unfenced tail: `finalizeRun` wrote status unconditionally, so a stale owner could still flip a run that a
fresh owner had claimed. `finalizeRun` therefore takes an optional fence
`{ readonly ownerAttempt: string }`: when present, the DB adapter finalizes with a conditional
`UPDATE … WHERE status = 'running' AND owner_attempt = ?` plus a read-back, and the memory adapter
predicates its write on the same fields — both return `false` when ownership was lost. `RunLifecycle`
passes the claim's `owner_attempt` through; a fenced finalize that loses emits `workflow.run.stale_owner`
(severity `warning`) and throws `WorkflowResumeError`. Callers that omit the fence keep the legacy
unconditional write. Deliberately out of scope (per task Q&A): step/state/transition writes remain
unfenced — a stale owner can still clobber a single action-phase row before its next finalize is refused;
the finalize fence bounds the damage to that window without widening the adapter contract to every write.
Callers wanting end-to-end coverage should re-claim before long action phases.

---

## ADR-026: Application-Owned HITL Decision Policy

**Status:** Accepted · **Date:** 2026-09-20 · **Targets:** `ts-ai-runner`, `ts-dual-workflow-engine`, downstream applications

`ts-ai-runner` owns the provider-neutral DecisionMaker contract, input/response validation, and
provider error translation. `ts-dual-workflow-engine` owns action execution, durable state, resume,
and the neutral `HitlResponder` contract. The workflow package does not import ai-runner or expose
AI-specific action extensions. A boundary rule enforces this separation.

Consuming applications own HITL action implementations, evidence gathering, automatic-mode policy,
and the switch between DecisionMaker and existing response behavior. In Spur, the existing
`hitl.*` actions remain authoritative; an optional responder integration composes A2 with the
existing responder fallback. Its activation flag and evidence policy belong to Spur configuration,
not to the shared engine. A2 supplies structured choices, not arbitrary free-text input.

**Alternatives:** An upstream action-override extension duplicates Spur's request construction,
events, cancellation semantics and answer-variable handling. A built-in engine AI dependency
couples unrelated workflow consumers to application policy. Both are rejected in favor of the
existing responder seam. A reusable responder adapter can be extracted if another application
needs the same behavior; it must not reimplement application actions.

**Recovery contract:** Action audit finalization is awaited before routing; a failed write is not
silently discarded. Paused snapshots retain only the last action's `ok` bit plus effective variables
and transition counts. Existing-key run attachment returns the persisted position without replay;
`owner_attempt` identifies the creator as well as subsequent resume owners. Custom persistence
adapters must preserve it at creation/attachment. Wrappers that deliberately swallow errors retain
their own weaker durability guarantee.

**Limits:** A responder cannot assess a HITL state skipped by an automatic workflow route. Changing
that route is an application-owned policy choice. Existing pauses remain intact; model probabilities
alone do not establish decision quality, and the host owns uncertainty/unavailability fallback.

---

## ADR-027: Local Laya Decision Backend Ships as `ts-laya-mlx` and Executes the Vendored MLX Runtime over a Process Bridge

**Status:** Accepted (design) · **Date:** 2026-09-20 · **Targets:** `ts-laya-mlx` (new), `ts-ai-runner`

**Decision.** A second `DecisionDriver` for the neutral decision surface ships as its own
lockstep-versioned workspace package, `@gobing-ai/ts-laya-mlx` (source `packages/laya-mlx`). It
executes genuine MLX by driving the checkpoint's own Python runtime as a long-lived JSON-lines
worker over `ProcessExecutor.runStreaming()`, not by reimplementing the forward pass. The host
requirement — macOS on Apple Silicon plus a Python interpreter carrying the `laya-mlx` package — is
declared and validated at construction, never hidden. Weights are resolved and cached by the
worker, never redistributed in the tarball.

**Why.** The checkpoint ships a batch `predict` entry point whose question map is one-to-one with
`DecisionDriver.ask`, so this package writes and maintains zero numeric code and inherits the
upstream 63-question parity instead of re-earning it. A subprocess bridge is also the mechanism
every other CLI-backed backend needs — Apple's `fm` among them — so one seam serves all of them
rather than one per engine.

**Consequences.** Python is a runtime prerequisite and the package is platform-locked; a portable
engine (an ONNX export executed by `onnxruntime-node`) is recorded as a follow-on feature, not a
competing design. This supersedes the ONNX-first reading of this ADR dated the same day, whose
stated premise — that MLX exposes no JavaScript array/`nn` binding — was false: `@mlx-node/core`
exposes one. A native port was reconsidered on that correction and still rejected: it is the
costliest path, its `nn` surface is undocumented for external composition, and its published
binary carries a macOS 26 deployment floor.

**Detail:** `docs/03_ARCHITECTURE.md` § laya-mlx; shapes in `docs/design/laya-local-decision-backend.md`.

---

## ADR-028: Backend Selection Is One-Way — `ts-ai-runner` Never Depends on a Driver Package

**Status:** Accepted (design) · **Date:** 2026-09-20 · **Targets:** `ts-ai-runner`, `ts-laya-mlx`

**Decision.** `ts-ai-runner` may name a backend (`"typesafe"` | `"laya-local"`) and resolve it when a
decision is first asked, but it declares no dependency on `@gobing-ai/ts-laya-mlx` and imports no
symbol from it at module scope. The dependency edge points only from driver package to
`ts-ai-runner`, which owns the neutral types. `createDecisionMaker({ driver })` stays the primitive;
the named selector is additive sugar over it.

**Why.** A driver package must import the neutral contract, so any reverse edge would close a cycle
across the workspace graph.

**Detail:** `docs/03_ARCHITECTURE.md` § laya-mlx; boundary rule under `.spur/rules/typescript/`.

---

## ADR-029: Apple `fm` Decision Backend Ships as `ts-decision-fm` over a One-Shot Process Bridge

**Status:** Accepted · **Date:** 2026-09-23 · **Built:** 2026-09-23 · **Targets:** `ts-decision-fm` (new), `ts-ai-runner`

**Decision.** A third `DecisionDriver` ships as its own lockstep-versioned workspace package,
`@gobing-ai/ts-decision-fm` (source `packages/decision-fm`), selected in `ts-ai-runner` as backend
`"fm-local"` under ADR-028's one-way rule. It answers a whole question map per sample with one
`fm respond --schema` call over `ProcessExecutor`; it does not run `fm serve`. New driver packages
are named `ts-decision-<engine>`; `ts-laya-mlx` keeps its published name.

**Why.** `fm` is a macOS 27 system binary with guided generation built in, so a one-shot subprocess
needs no Python, weights, or server lifecycle — and `fm serve` was verified to add no capability
(no logprobs, no `n>1`).

**Detail:** `docs/03_ARCHITECTURE.md` § decision-fm; shapes in `docs/design/decision-fm-backend.md`.

---

## ADR-030: `fm` Answer Probabilities Are Empirical Sample Frequencies

**Status:** Accepted · **Date:** 2026-09-23 · **Built:** 2026-09-23 · **Targets:** `ts-decision-fm`

**Decision.** The `fm-local` driver derives every probability from k independent non-greedy samples
(label frequency), and `confidence` from that empirical distribution with the same normalized-entropy
formula the Laya reference uses. A deterministic mode draws one greedy sample. The estimator and k
are declared on the driver. The model is never asked to state its own confidence.

**Why.** `fm` exposes no token log-probabilities on either the CLI or `fm serve` (verified
2026-09-23), and self-reported confidence would fabricate calibration the neutral contract forbids.

**Detail:** `docs/design/decision-fm-backend.md` § Probability estimation.

---

## ADR-031: `fm` Joins `ts-ai-runner` as a Text-Only Agent, Excluded from Auto-Selection

**Status:** Accepted · **Date:** 2026-09-23 · **Built:** 2026-09-23 · **Targets:** `ts-ai-runner`

**Decision.** `fm` becomes an `AgentName` with a shim covering detection, availability, prompt
execution, structured output, and transcript sessions, and it is marked text-only: it has no file or
shell tools. It is absent from `TIER1_PRIORITY`, so automatic selection never resolves to it; an
explicit `fm` request still does.

**Why.** Downstream callers get Apple's on-device model through the same runner, and auto-selection
cannot route tool-using work to a model that would only narrate the edits.

**Detail:** `docs/design/decision-fm-backend.md` § `fm` agent in `ts-ai-runner`.
