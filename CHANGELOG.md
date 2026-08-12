# Changelog

All notable changes to the `@gobing-ai/ts-*` packages are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All packages are
versioned in **lockstep** — a single version number covers every package in the monorepo.

## [Unreleased]

### Added

- None.

### Changed

- None.

### Fixed

- **`ProcessExecutor.runStreaming` no longer replaces the parent environment:** a partial `env` now merges with the parent (matching `run()`, execa `extendEnv: true` semantics). The old replace behaviour is opt-in via `envMode: 'replace'` on `ProcessOptions` / `PipeProcessOptions` (task 0060 F5).
- **Unsupported cron expressions now fail loud instead of misfiring every 60s:** `NodeSchedulerAdapter.register`/`parseInterval` throws a `RangeError` for anything other than a positive millisecond number, `* * * * *`, or `*/N * * * *` — a real 5-field expression like `0 3 * * *` can no longer silently run at the wrong cadence (task 0060 F7).
- **Remote `$schema` fetch is dual-gated:** `readSchema` refuses unless BOTH `allowRemote: true` and an explicit `fetch` are supplied — `allowRemote` alone no longer implies a (nonexistent) built-in fetch, and `fetch` alone is not an opt-in (task 0060 F2).
- **`deFlattenKeys` no longer pollutes `Object.prototype`:** `__proto__` / `constructor` / `prototype` key segments are skipped (task 0060 F1).

### Security

- **Shell action results are redacted before persistence:** `workflow.run` action rows scrub `stdout`/`stderr` by default via a new `WorkflowRunOptions.redactor` hook (task 0060 F4).
- **`walkDir` is cycle-safe and root-confined:** directory symlink cycles and symlinks escaping the start root are skipped; in-root directory symlinks are still traversed (task 0060 F3).

### Breaking Changes

- **`@gobing-ai/ts-db` main barrel no longer value-exports `D1Adapter`** — import it from `@gobing-ai/ts-db/d1` or use `createDbAdapter({ driver: 'd1' })` (ADR-005 addendum, task 0060 C1).
- **Rule-engine and workflow `ExtensionRef` shapes changed** from an absolute `absPath` to the authored relative `path` + declaring `baseDir`; the shared loader now validates the authored path directly (task 0060 C2).

## [0.4.29] — 2026-08-12

### Added

- **Observability — Event Severity:** introduced `EventSeverity` (`'info' | 'warning' | 'error'`) and the `WithEventSeverity` mixin in `@gobing-ai/ts-utils`, then stamped a producer-owned severity on every observability event across the workspace: `@gobing-ai/ts-infra` (event-bus lifecycle `bus.emit.done`/`bus.emit.noop`/`bus.handler.error`/`bus.handler.async.enqueued`, api-client request errors, db job-queue lifecycle, scheduler `queue.stats`), `@gobing-ai/ts-ai-runner` (agent started/stopped/message.sent), `@gobing-ai/ts-dual-workflow-engine` (run/node/action/hitl/resume/deny events) and `@gobing-ai/ts-rule-engine` (rule run/eval events) — so consumers can filter or route events by importance.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this section.

### Breaking Changes

- **Event payloads now require `severity`:** event detail interfaces across the affected packages (e.g. `ApiRequestErrorDetail`, `EmitDoneDetail`, `QueueJobFailedDetail`, and the workflow/agent/rule event payloads) gain a required `severity: EventSeverity` field; code constructing these payloads must supply it.

## [0.4.28] — 2026-08-12

### Added

- None.

### Changed

- **Documentation & Architecture — Monorepo Constitution & Export Surfaces:** integrated project constitution (`docs/99_PROJECT_CONSTITUTION.md`), frontmatter metadata contracts across `docs/00_ADR.md` through `docs/05_FEATURES.md`, package export surfaces index (`docs/design/package-exports.md`), and updated subpath documentation for `@gobing-ai/ts-db/schema` and `@gobing-ai/ts-runtime`.

### Fixed

- **Release toolchain — Test mock isolation & output leaks:** eliminated top-level `mock.module()` pollution in `release-commands.test.ts` by adding injectable parameter seams (`deps`/`options`) on release commands, and added customizable `log` parameter seam to suppress stdout leaks during `bun test`. Encapsulated raw `history_import_checkpoint` SQL deletion under `jsonl-importer-dao.ts`.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

## [0.4.27] — 2026-08-11

### Added

- **Release toolchain — `bump-ver --push` GitHub Actions Publish verification:** `bump-ver --push` now verifies that pushing the aggregate release tag triggered a corresponding `publish.yml` workflow run before completing. Performs bounded lookups (`gh run list`) for a matching run; if a push event is missed, it recovers by dispatching a single `workflow_dispatch` run at the same immutable tag ref. Reports the run ID and URL or fails loudly on error.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

## [0.4.26] — 2026-08-11

### Added

- **`@gobing-ai/ts-llm-jsonl-importer` — OMP envelope normalization:** normalized current OpenCode/OMP message envelopes, flat `toolCall` blocks, and filename-based session keys into canonical contract records.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

## [0.4.25] — 2026-08-10

### Added

- **`@gobing-ai/ts-llm-jsonl-importer` — Full-mode reconciliation & atomic validation:** added `reconcileFullImport` for single-batch source-scoped stale row sweeps, OpenCode full mode reconciliation, and line-atomic validation so schema-invalid splits reject the whole line without leaving orphaned rows behind.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

## [0.4.24] — 2026-08-10

### Added

- **`@gobing-ai/ts-llm-jsonl-importer` — OpenCode SQLite history importer (`runOpenCodeImport`):** added `runOpenCodeImport` and `OpenCodeImportOptions` in `opencode-importer.ts` to import OpenCode session history directly from OpenCode's SQLite database (`~/.local/share/opencode/opencode.db`) into `history_message` and `history_tool_call` forensic contract tables. Includes support for incremental resume, SHA-256 record checksum deduplication, redaction rule application, and batch database operations.
- **`@gobing-ai/ts-llm-jsonl-importer` — OpenCode source definition & mappers:** widened `LlmJsonlSource` to include `'opencode'` and added OpenCode record mappers in `mappers.ts` and DDL/DML DAO helpers in `jsonl-importer-dao.ts`.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

## [0.4.23] — 2026-08-08

### Added

- **`@gobing-ai/ts-llm-jsonl-importer` — `normalizeSourceFilePaths()` migration export:** idempotent rewrite of `source_file` to its realpath identity across `history_import_checkpoint`, `history_import_ledger`, typed contract tables (`history_message`, `history_tool_call`), and any present `history_etl_*` tables. Checkpoint rows that describe the same physical file under both a symlink path and a real path collapse per `(source, realpath)`, keeping the highest `last_imported_line` so incremental resume does not re-import already-seen content. `record_hash` is intentionally left alone — it is path-representation dependent by construction, and pre-migration rows are grandfathered. The resolver is injected as `(sourceFile) => string | null | undefined` so the DAO stays decoupled from the runtime `FileSystem` seam. Exported from the package barrel alongside `applyHistoryImportSchema`.

### Changed

- None.

### Fixed

- **`@gobing-ai/ts-llm-jsonl-importer` — `source_file` realpath normalization at discovery:** discovered and explicit file paths are canonicalized via optional `FileSystem.realPath` before they become checkpoint keys, ledger rows, or `record_hash` inputs. Without this, the same physical session file reachable via a symlink (e.g. `$HOME/.claude/projects` → a dotfiles tree) and via its real path produced divergent checkpoint/ledger keys, duplicate checkpoint rows, and silent full-corpus re-imports. When `realPath` is absent (injected/in-memory doubles) or throws (e.g. ENOENT), the original path is kept — discovery never fails because of normalization.

### Security

- No security fixes in this section.

### Breaking Changes

- `@gobing-ai/ts-llm-jsonl-importer` (patch behavior): when `FileSystem.realPath` is available, stored `source_file` values and new `record_hash` inputs use the realpath. Consumers that compare `source_file` to a non-realpath string, or that assumed symlink-form paths, must realpath (or call `normalizeSourceFilePaths`) for identity checks. Pre-migration `record_hash` values are unchanged and still dedupe correctly against their original path representation until those rows are re-imported under the new form.

## [0.4.20] — 2026-08-07

### Added

- **`@gobing-ai/ts-llm-jsonl-importer` — typed `history_message` / `history_tool_call` contract tables:** the static import schema now declares two typed contract tables in addition to the per-source `history_etl_*` tables. `history_message` holds canonical message rows (`session_id`, `seq`, `turn_index`, `role`, `record_type`, `disposition`, `ts`, `duration_ms`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `content_text`, `cwd`, `provenance`, `run_id`, `task_wbs`); `history_tool_call` holds the matching tool-call rows (`tool_name`, `args_digest`, `status`, `started_at`, `completed_at`, `duration_ms`, `result_bytes`, `error_text`) plus a `message_hash` foreign key back to the parent message. Both tables get supporting indexes (`(source, session_id, seq)`, `ts`, `tool_name`, `message_hash`). The single-source `GROUP BY tool_name` query path no longer needs `JSON_EXTRACT`.
- **`@gobing-ai/ts-llm-jsonl-importer` — per-source `*Split()` mappers wired into the built-in registry:** `pi`, `claude`, `codex`, `omp`, `grok`, and `agy` now route their raw JSONL through the `customSourceDefinition(..., split, fieldMap, schema)` factory in `sources.ts`. Each mapper classifies records into the `history_message` / `history_tool_call` contract tables (e.g. Claude `tool_use` blocks emit one `history_tool_call` row referencing the parent message via `message_hash`; Grok `phase_changed` / `turn_started` / `hook_execution` etc. land as `meta`; AGY `USER_INPUT` / `PLANNER_RESPONSE` / `ERROR_MESSAGE` / `RUN_COMMAND` / `CONVERSATION_HISTORY` / `CHECKPOINT` / `GENERIC` route by role + disposition per task 0463). Built-in sources: `pi` → `.pi/agent/sessions`, `claude` → `.claude/projects`, `codex` → `.codex/sessions`, `omp` → `.omp/agent/sessions`, `grok` → `.grok/sessions`, `agy` → `.gemini/antigravity-cli/brain`. `LlmJsonlSource` widens to include `omp` / `grok` / `agy`.
- **`@gobing-ai/ts-llm-jsonl-importer` — `unknownRecords` counter on `ImportResult`:** `runJsonlImport()` now reports `unknownRecords: number` on the result, populated from any split entry whose normalized `disposition === 'unknown'` (e.g. Grok records with no type discriminator or an unlisted empty type). The previously-empty bookkeeping field is now a first-class counter; existing consumers ignore it.
- **`@gobing-ai/ts-llm-jsonl-importer` — `SplitEntry` export + `one-to-many` split wiring:** the `SplitEntry` interface (`{ targetTable?: string; record: JsonObject }`) is now exported from the package barrel alongside `SplitConfig`. The `SplitConfig` `custom` mode accepts `readonly (JsonObject | SplitEntry)[]` and honours per-entry `targetTable` with the resolution order `entry → splitConfig → definition`, so a single split call can fan out to multiple tables.
- **`@gobing-ai/ts-llm-jsonl-importer` — typed INSERT path on the contract tables:** `insertRecord` selects between the generic `payload_json` insert (for `history_etl_*` tables) and a typed insert (for the contract tables) using an internal `TYPED_TABLE_COLUMNS` allowlist. The typed path refuses to persist unknown column names — it throws `HistoryImportError` with the offending keys + the expected set — so a mapper that drifts from the contract cannot silently land in SQLite. Generic tables keep the existing `payload_json` path unchanged.

### Changed

- None.

### Fixed

- **`@gobing-ai/ts-llm-jsonl-importer` — `_messageSplitIndex → message_hash` linkage is now stable across the insert pass:** `runJsonlImport()` now does a two-pass insert — first pass prepares (normalize, validate, redact, hash) every split entry, second pass resolves `normalized._messageSplitIndex` against the prepared `recordHashBySplitIndex` map and assigns `normalized.message_hash` before the INSERT. Previously the per-entry loop deleted `_messageSplitIndex` before any message row had been hashed, so tool-call rows never saw their parent `message_hash` and the `(source, session_id, seq)` join worked but `history_tool_call.message_hash` was always NULL for fan-out sources.
- **`@gobing-ai/ts-llm-jsonl-importer` — `VALID_TABLE_NAME` widens to `/^history_[a-z_]+$/`:** the validator used to reject `history_message` / `history_tool_call` (note: `history_` not `history_etl_`), which was a hard-coded assumption from the generic-table-only era. Custom source definitions can now reference any `history_<snake>` table — including the new contract tables — without tripping the validator or the split-table override.

### Security

- No security fixes in this section.

### Breaking Changes

- `@gobing-ai/ts-llm-jsonl-importer` (minor): `LlmJsonlSource` widens to include `omp` / `grok` / `agy`. Consumers narrowing on the closed union (e.g. an exhaustive `switch` over built-in source names) must widen to `string` or add the new branches. `ImportResult` gains a required `unknownRecords: number` field; existing consumers that destructure it as a fixed-shape object must accept the extra key.

## [0.4.18] — 2026-08-04

### Added

- `@gobing-ai/ts-dual-workflow-engine`: declarative `failureStates` — a subset of
  `terminalStates`. A run reaching a failure terminal now finalizes via `lifecycle.fail`
  (status `failed`, reason `terminal:<state>`) instead of `lifecycle.done`. When absent,
  every terminal is a success (unchanged behavior). Validation rejects failure states that
  are not declared or not present in `terminalStates`.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

## [0.4.16] — 2026-08-03

### Added

- None.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

## [0.4.15] — 2026-07-31

### Added

- Enriched `queue.*` EventBus detail payloads in `@gobing-ai/ts-infra` for System Events observability. `queue.consumer.started` / `queue.consumer.stopped` now carry config snapshots and drain outcomes (previously zero-arg, empty-payload). `queue.job.enqueued` adds `enqueuedAt`, `maxRetries`, `delayMs`, `ttlMs`. `queue.job.completed` adds `durationMs` and `attempt`. `queue.job.failed` adds `maxRetries` and `durationMs`; `queue.job.retrying` adds `maxRetries` and `error`. Details remain correlator-grade — the business payload `T` is never emitted on the bus. New named detail interfaces (`QueueJobRef`, `QueueJobEnqueuedDetail`, `QueueConsumerStartedDetail`, `QueueConsumerStoppedDetail`, `QueueJobCompletedDetail`) are exported from `@gobing-ai/ts-infra`.
- Injectable `RuntimePaths` seam in `@gobing-ai/ts-runtime` (ADR-023 A1): new `RuntimePaths` value type (`{ readonly cwd: string; readonly home: string }`) and `ambientRuntimePaths()` factory exported from the barrel. `createNodeFileSystem(root?, paths?)` and `ProcessExecutorConfig.paths` accept an optional anchor — injected `paths.cwd` seeds the project-root walk / applies to runs with no explicit per-call `cwd` (precedence: explicit > injected > ambient). `@gobing-ai/ts-llm-jsonl-importer` gains `ImportOptions.paths`; with no injection every call site behaves exactly as before.
- Open source registry in `@gobing-ai/ts-llm-jsonl-importer` (ADR-023 A3): `runJsonlImport()` now accepts `source: string | SourceDefinition` — strings resolve from the built-in registry (unknown strings throw `HistoryImportError`), and a custom `SourceDefinition` object is validated and used directly. The `source` fields on `SourceDefinition`, `TransformContext`, and `ImportResult` widen from the closed `LlmJsonlSource` union to `string` so a custom source name flows through checkpoints, the ledger, and the result. New exports: `resolveSourceDefinition()`, `validateSourceDefinition()`, and `VALID_TABLE_NAME` (the `/^history_etl_[a-z_]+$/` gate). Custom target tables are created on demand (`CREATE TABLE IF NOT EXISTS`, idempotent for built-ins). `LlmJsonlSou…
- `@gobing-ai/ts-infra`: `NodeSchedulerAdapter` accepts a `NodeSchedulerAdapterConfig` (`{ drainTimeoutMs?: number }`) and exports it from the `scheduler-node` subpath, so the shutdown drain bound (ADR-024) is configurable without injecting a whole adapter. The auto-wired path in `createNodeApplication` keeps the 30000 ms default.

### Changed

- None.

### Fixed

- `@gobing-ai/ts-infra`: `DBQueueConsumer.stop()` no longer reports a false clean drain. The poll cycle was launched as a floating promise, and `inFlight` is only incremented after `claimReady()` resolves — so a `stop()` landing in that window observed `inFlight === 0`, exited the drain loop immediately, and emitted `queue.consumer.stopped` with `drained: true` while the cycle went on to claim and run handlers after `stop()` had resolved. On shutdown those jobs stayed `processing` until the visibility timeout reclaimed them. `stop()` now awaits the in-flight cycle, still bounded by `drainTimeoutMs`.
- `@gobing-ai/ts-infra`: `NodeSchedulerAdapter.stop()` now drains in-flight scheduled ticks, bounded by a configurable `drainTimeoutMs` (default 30000), instead of resolving while an action is mid-execution. Previously each tick was launched as a floating promise with no retained handle, so `stop()` could clear future timers but not await a tick already running — `await app.stop()` followed by process exit could tear down an action partway (torn DB write, half-flushed batch). The shared `settleWithin` bound is extracted to a new internal `internals/drain` module used by both the queue consumer and the scheduler. `SchedulerAdapter.stop()` signature is unchanged; `stop()` may now block up to `drainTimeoutMs` when a tick is in flight, which is the behaviour `Application`'s deterministic reverse-fan-out shutdown already assumed. See ADR-024.
- `@gobing-ai/ts-infra`: `runNodeApplication` no longer silently overwrites a caller-supplied `SchedulerOptions.adapter`. The Node bootstrap path unconditionally constructed a fresh `NodeSchedulerAdapter` when `scheduler.enabled === true`, discarding any injected adapter — a documented DI point (`application/types.ts`) and the only bootstrap route to set `drainTimeoutMs` (ADR-024) on the auto-wired adapter. It now uses `schedulerOpts.adapter ?? new NodeSchedulerAdapter()` and forwards `entries`. Callers passing both `enabled: true` and an adapter previously got the built-in; they now get their own. Callers not passing an adapter are unaffected. Behavioural change (not signature): classified as Fixed because the prior behaviour contradicted the documented contract.
- `@gobing-ai/ts-utils`: `deepMerge()` now skips a `__proto__` key in `source`. Plain assignment invoked the inherited `__proto__` setter, giving the returned object an attacker-controlled prototype, so `deepMerge(defaults, JSON.parse(userInput))` could resolve absent keys through it. `Object.prototype` was never affected (each level is a fresh spread) and stays clean.
- `@gobing-ai/ts-llm-jsonl-importer`: registry `defaultRoots` (`.claude/projects`, `.codex/sessions`, …) now resolve against the user home directory instead of the ambient working directory. Previously, invoking `runJsonlImport` from any cwd ≠ `$HOME` resolved the home-relative roots to nonexistent paths and silently discovered zero files for every built-in source. Explicit `ImportOptions.roots` keep invocation-directory (cwd) semantics.

### Security

- No security fixes in this section.

### Breaking Changes

- `@gobing-ai/ts-infra` (minor): `queue.consumer.started` and `queue.consumer.stopped` EventBus handlers typed against `QueueEvents` must now accept a detail object instead of being zero-arg. `QueueJobFailedDetail` and `QueueJobRetryingDetail` gained required `maxRetries` (and `error` on retrying) fields. Runtime JS listeners that ignore arguments keep working.
- `@gobing-ai/ts-llm-jsonl-importer` (type-level only, no runtime change): `SourceDefinition.source`, `TransformContext.source`, and `ImportResult.source` widen from the closed `LlmJsonlSource` union to `string` (ADR-023 A3). Only consumers narrowing on the union (e.g. an exhaustive `switch` over built-in source names) need to widen their types.

---

## [0.4.14] — 2026-07-28

### Added

- None.

### Changed

- None.

### Fixed

- **`ts-runtime` — descendant-safe one-shot cancellation (spur#0365):** buffered commands that receive an
  abort signal now run in an isolated Unix process group and terminate the whole group, preventing shell
  descendants from retaining stdout/stderr pipes after the observed process is cancelled. Windows keeps
  the existing direct-child cancellation fallback.

### Security

- No security fixes in this section.

### Breaking Changes

- None.

---

## [0.4.13] — 2026-07-28

### Added

- **`ts-runtime` — tee-capable buffered process observation (spur#0365):**
  `ProcessOptions.onOutput` receives timestamped stdout/stderr chunks while `run()` continues to return
  the complete buffered `ProcessResult`. Observer failures are isolated from child I/O.
- **`ts-ai-runner` — correlated agent execution (spur#0365):** `AgentRunOptions` forwards the output
  observer and an application-owned `{ runId, executionId, actionId? }` correlation object; the same
  correlation is present on `agent.invoke.start` and `agent.invoke.exit`.
- **`ts-dual-workflow-engine` — action identity in runner context (spur#0365):** the engine passes its
  persisted action-row id as optional `ActionRunContext.actionId`, allowing downstream streaming and
  control events to target the exact action without changing persistence.

### Changed

- None.

### Fixed

- None.

### Security

- Raw process output remains application-owned; consumers must redact before forwarding it to logs,
  event buses, or durable traces.

### Breaking Changes

- None.

---

## [0.4.12] — 2026-07-27

### Added

- **`ts-dual-workflow-engine` — pause/resume variable persistence (spur#0366 R1/R2/R3/R11):**
  `WorkflowPersistenceAdapter` gains `loadLatestStateSnapshot(runId): Promise<{ state: string; data:
  Record<string, unknown> } | undefined>`, returning the most recent `workflow_states` row (DB adapter
  orders by `created_at DESC, rowid DESC`) plus its parsed `data_json`. `RunLifecycle.enter`,
  `commitHop`, and `pause` each accept an optional trailing `vars?: Vars` and, when supplied, embed it
  as `effectiveVars` inside the persisted snapshot's `data`. `pause()` additionally writes a **fresh**
  state snapshot before `savePhase` + `finalizeRun`, capturing `onEnter setVars` (e.g. `__hitlAnswer`)
  that previously never reached disk. Both driver loops (state-machine, transition-flow) thread the
  run-local `vars` through every lifecycle touchpoint. `WorkflowService.resumeRun` loads the latest
  snapshot, extracts `effectiveVars`, and merges them with caller-supplied `options.vars` (caller
  wins), so resumed runs keep their HITL answers and other runtime vars. Backward compatible: old
  snapshots without `effectiveVars` yield `{}`; non-string entries are dropped defensively.

---

## [0.4.11] — 2026-07-21

### Added

- **`ts-dual-workflow-engine` — `saveActionStart` forwards resolved step options to the observability seam (spur#0310 / task 0054):**
  `WorkflowPersistenceAdapter.saveActionStart(runId, node, kind, options?)` accepts an optional 4th
  param `options?: Record<string, unknown>`. The sole call site (`runActionStep` in `action-step.ts`)
  forwards the **resolved** options map (post-`resolveTemplates`), so a mirroring/observability
  wrapper (e.g. Spur’s `ObservableWorkflowAdapter`) sees what will actually run — agent argv, prompt
  summary, etc. — instead of raw templates. Additive and optional: existing 3-arg implementors and
  callers compile unchanged. Both adapter implementations (SQLite + in-memory) accept and ignore
  the 4th arg — **mirror, never persist**: the action-row INSERT is byte-identical with or without
  `options` (no new column, no altered row, no schema change). The engine does **not** redact
  (it cannot know which Spur option keys hold secrets); redaction stays with the consumer’s
  observability layer. Covered by unit tests on the call site and both adapters (including a SQL
  path that asserts secret-bearing tokens never land in `action_runs`). Spur-side adoption and
  `workspaces.catalog` re-pin remain out of repo.

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this release. Options may carry secrets in memory when a consumer wraps the
  adapter; they are never written to the persistence layer (see Added above).

### Breaking Changes

- None. The new `options` parameter is optional; all existing 3-arg callers and implementors remain
  valid.

---

## [0.4.10] — 2026-07-15

### Added

- **`ts-runtime` — `ProcessRegistry` for full process watch lists (spur#0264 / Spur M1):** new
  `ProcessRegistry` interface + `InMemoryProcessRegistry` / `createInMemoryProcessRegistry()` track
  every `ProcessExecutor` invocation with minimum metadata (`id`, `label`, `command`, `args`, `pid?`,
  `startedAt` / `exitedAt`, `exitCode`, `source`, optional `teamId` / `agentId`, `status`).
  `NodeProcessExecutor` accepts optional `ProcessExecutorConfig.registry` and records `run` /
  `runStreaming` (defaults: buffered runs → `source: 'one-shot'`, streaming → `source: 'other'`).
  Options accept `source` / `teamId` / `agentId`. API: `listExecutions(filter?)`, `getExecution(id)`,
  `subscribe`, `begin` / `update` / `complete` / `clear`. In-memory only (not durable across restarts);
  ring-buffer retention (default max 1000). Without a registry, executor behavior is unchanged
  (additive / non-breaking).

### Changed

- None.

### Fixed

- None.

### Security

- No security fixes in this release.

### Breaking Changes

- None. All changes are additive optional APIs.

---

## [0.4.9] — 2026-07-13

### Added

- **`ts-infra` — platform lifecycle-bus propagation wired through the application layer:** `EventBus` accepts an optional `lifecycleBus` and forwards pre-emit / post-emit / error breadcrumbs for every `bus.emit.*` event. The file observer, `ApplicationNode`, and `APIClient` now propagate the bus end-to-end so downstream consumers (telemetry, rule-engine, ai-runner) observe a single canonical event stream instead of package-local notifications.

- **`ts-db` — durable `message.*` events emitted through a structural sink on `InboxMessageDao`:** `InboxMessageDao` now accepts an optional `events` sink (`EventBus<InboxMessageEvents>`) and emits `message.enqueued`, `message.delivered`, and `message.failed` breadcrumbs through it. The sink is structural (typed by interface, not by class), so any compatible `EventBus` works without an adapter. Lifecycle-bus integration test exercises the real adapter.

- **`ts-rule-engine` — `RuleEngineOptions` accepts a `lifecycleBus`:** Rule evaluation, fixer runs, and evaluator dispatch (`ripgrep`, `sg`, `exit-code`) publish breadcrumbs on the shared bus, enabling cross-package rule-event correlation.

- **`ts-dual-workflow-engine` — `WorkflowService` propagates `lifecycleBus`:** `WorkflowService`, `Host`, and the run-lifecycle layer thread the bus through transition-request and edge-case paths, so workflow state changes become observable system events.

- **`ts-ai-runner` — `TeamOrchestrator` and `TeamAgentProcess` accept a `lifecycleBus`:** Agent and process events (spawn, exit, reply) now publish to the shared bus. `messages.formatMessage` and the orchestrator's flush-inbox loop are bus-aware.

### Changed

- **`ts-runtime` — `ProcessExecutor` published as the canonical interface behind the factory:** `ProcessExecutor` is now a first-class exported type (not just a concrete class). The factory returns the interface, so consumers depend on the seam rather than the Bun/Node adapter. Deprecation guard `no-deprecated-process-executor-construct` enforced via spur rule.

- **`ts-ai-runner` — owned `MessageStore` port; decoupled from `ts-db` in production:** `TeamOrchestrator` now imports `MessageStore` + `DrainedMessage` from the local `./message-store` module instead of `InboxMessageDao`. `InboxMessageDao` satisfies the port structurally — no adapter class — and `@gobing-ai/ts-db` moves to `devDependencies`. In-memory test doubles `implements MessageStore` directly; the unsafe `as never` casts are gone. A compile-time `InboxMessageDao → MessageStore` assignability assertion guards the boundary.

### Fixed

- **`ts-dual-workflow-engine` — transition-request and edge-case paths no longer drop the lifecycle bus** during host delegation.

### Security

- No security fixes in this release.

### Breaking Changes

- None. All changes are additive (new optional `lifecycleBus` / `events` parameters) or refactor-only (`MessageStore` port preserves behavior). Consumers who construct `InboxMessageDao`, `RuleEngineOptions`, `WorkflowService`, or `TeamOrchestrator` without the new options continue to compile and run unchanged.

---

## [0.4.8] — 2026-07-12

### Added

- **`ts-ai-runner` — Grok (`grok`) registered as a tier-1 coding agent:** New canonical `AgentName` `"grok"` (binary `grok`, tier 1) joins `AGENT_SHIMS`, `DISPLAY_ORDER`, and `TIER1_PRIORITY` next to `hermes` and `omp`. The `AgentShim` builds headless argv as `grok -p <input>` (or `-c` for continue, `-m <model>`), maps ai-runner `OutputMode` `text → plain` and `json → json` via `--output-format`, and exposes `getAuthCommand = null` because Grok has no CLI auth-status verb. `AgentDetector` parses the real `grok --version` shape (`grok 0.2.93 (<sha>) [stable]`); `DoctorRunner` emits a `grok` row. README §"Supported agent identifiers" and the agent-behavior table are updated.
- **`ts-ai-runner` — Grok auth probe via `XAI_API_KEY` or `~/.grok/auth.json`:** New `checkGrokAuth` branch in `agents/auth-shims.ts` resolves the tri-state `AuthState` without false-negatives to `'unauthenticated'` when only credentials are present but no CLI verb exists: a non-empty `XAI_API_KEY` env or a non-empty `~/.grok/auth.json` returns `'authenticated'`; absence returns `'unknown'`. Keeps `DoctorResult.usable` driven by liveness (per the 0.4.0 contract) and never feeds run-readiness.
- **Docs — Feature `A` and tasks `0046`–`0048` for Grok support:** Feature file `docs/features/A_add-grok-coding-agent-to-ts-ai-runner.md` (status `active`, P1) with nine gherkin acceptance criteria covering registry membership, argv mapping, help/version, detector parse, auth tri-state, doctor row, README listing, output-mode mapping, and the null-auth-command invariant. Linked tasks `0046` (shim + registry membership, `done`), `0047` (auth probe + detector/doctor coverage), and `0048` (Grok documented as a supported coding agent).

### Changed

- **`ts-ai-runner` — `DISPLAY_ORDER` and `TIER1_PRIORITY` extended for Grok:** `AgentShim` registry now covers ten agents; `grok` is appended to both priority lists after `hermes` and `omp` to keep auto-select deterministic for the existing preferred agents. No behaviour change for other agents.

## [0.4.7] — 2026-07-11

### Added

- **`ts-db` — `DbAdapter.batch()` for atomic multi-statement writes:**

- **`ts-dual-workflow-engine` — `commitTransition` and `commitHop` for crash-safe workflow persistence:** `WorkflowPersistenceAdapter.commitTransition()` atomically commits a transition record + state snapshot + optional phase write in one batch. `RunLifecycle.commitHop()` wraps all per-step persistence into the same atomic call, replacing the prior `recordTransition` + `saveWorkflowState` pair that left a partial-state window on crash. All three commit sites (`service.ts`, `state-machine.ts`, `transition-flow.ts`) now use `commitHop`. `RunLifecycle.enter(persist=false)` skips persistence after a `commitHop` to avoid duplicate writes.

- **`ts-runtime` — Optional streaming and symlink-safe extension confinement:** Two new optional `FileSystem` methods: `readFileStream(path)` returns an `AsyncIterable<string>` for O(line) memory file processing, and `realPath(path)` resolves the canonical symlink-free path. `LoadExtensionsOptions.realPath` opts into the symlink-safe confinement check that follows symlinks after the string-level guard and rejects escapes. Node/Bun implementations use `createReadStream` and `realpathSync`; CF stubs omit both. Composition sites in `ts-rule-engine` and `ts-dual-workflow-engine` forward the option from caller options.

- **`ts-llm-jsonl-importer` — Streaming JSONL reader:** The importer's line reader now uses `FileSystem.readFileStream` when available (falling back to `readFile` + split), enabling O(line) memory imports of multi-GB LLM history files. Behavior is identical to the previous `readFile` path — same `source_line` values and same `ImportResult`.

### Changed

- **`ts-dual-workflow-engine` — Atomic persistence by default for all workflows:** Workflow state machines no longer write transitions and state independently; every persisted transition now commits as one batch. The change is internal but eliminates a class of crash-recovery bugs that could leave the transition log ahead of (or behind) the state snapshot.

### Security

- **`ts-infra` — Strip credentials from URLs in API client traces:** The API client now sanitizes URLs before emitting OpenTelemetry span attributes — query string, hash, username, and password are stripped. `APIError` instances are mapped to `HTTP <status>` (or `Request timeout` for status 0); other errors get `error.name`. Prevents secrets from leaking into traces and log aggregators when an API URL embeds auth credentials.

- **`ts-infra` — Validate queue consumer config at construction:** `DBQueueConsumer` now rejects negative, non-finite, or non-integer values for `pollInterval`, `batchSize`, `maxConcurrency`, `visibilityTimeout`, `baseDelay`, `maxDelay`, and `drainTimeoutMs` with clear `RangeError` messages. Replaces silent misconfiguration that could cause infinite loops, hung consumers, or zero-throughput queues.

- **`ts-utils` — Validate cursor payloads:** `createCursor` and `parseCursor` now reject non-finite `createdAt` and negative / non-integer `offset` values with explicit `Error` messages. Previously, bad cursor data was silently dropped, which could cause pagination to loop or skip rows.

- **`ts-runtime` — Symlink-safe extension confinement:** The plugin extension loader now optionally canonicalizes paths before allowing imports. When the caller provides `realPath`, a symlink inside `baseDir` that resolves outside it (e.g. `baseDir/plugins -> /outside`) is rejected with a descriptive error. Closes the symlink-escape vector that the prior string-level `..` guard could not detect.

## [0.4.6] — 2026-07-10

### Added

- **`ts-runtime` — `DbModuleNotInstalledError` for the createDbAdapter seam:** New typed error in `packages/runtime/src/db-errors.ts` (exported from the package barrel), thrown by `nodeBunFactory.createDbAdapter` when the dynamic `import('@gobing-ai/ts-db')` fails to resolve (missing module) or resolves to an incompatible version (no `createDbAdapter` export). The original resolution error is chained via `cause`. Replaces the prior raw `MODULE_NOT_FOUND` with an actionable message that names the optional peer and the fix (`bun add @gobing-ai/ts-db` / mark `@gobing-ai/ts-db` `external` when bundling).

- **`scripts` — Pin `peerDependencies` publish-time `workspace:*` resolution:** New fixture case in `scripts/tests/workspace-deps.test.ts` asserts that a `peerDependencies` entry of `workspace:*` resolves to `^<version>` at publish time (mirroring `dependencies` / `devDependencies` / `optionalDependencies`). Pins the `DEP_FIELDS` contract — `scripts/lib/workspace-deps.ts:24` already included `peerDependencies`; the test prevents a silent drop during a future refactor.

### Changed

- **`ts-runtime` — `@gobing-ai/ts-db` is now an optional `peerDependency`:** `packages/runtime/package.json` declares `"@gobing-ai/ts-db": "workspace:*"` under `peerDependencies` with `peerDependenciesMeta.optional: true`. Consumers that call `nodeBunFactory.createDbAdapter` on Node/Bun must `bun add @gobing-ai/ts-db` themselves; the manifest no longer relies on the prior `devDependencies`-only signal that left the runtime contract undeclared (and produced a raw `MODULE_NOT_FOUND` for npm consumers). Cloudflare Workers consumers are unaffected (`hasSqlDatabase` is `false`; `D1NotConfiguredError` is still thrown). The literal specifier in `runtime-node-bun.ts` is unchanged — Bun `--compile` bundling keeps working. README §8 documents who-installs-it, bundler `external` guidance, and the typed-error failure mode.

### Documentation

- **ADR-012 addendum — optional peerDependency for cycle-forced sibling imports:** Dated addendum to ADR-012 sanctions the pattern: a literal dynamic `import()` of a sibling package that would create a manifest cycle as a regular `dependencies` entry is declared as an optional `peerDependencies` entry, with the `tsconfig` `paths` entry still tracking it for the source closure. Canonical instance: `ts-runtime` → `ts-db` via `nodeBunFactory.createDbAdapter`. Closes the ADR-012 drift surfaced by the 2026-07-10 `/sp:dev-review packages` pass (finding #4, advisory).

## [0.4.5] — 2026-07-10

### Added

- **`ts-ai-runner` — Model health probe for omp providers:** New `OmpModelProbe` issues a minimal 1-token completion request against the provider's `/v1/messages` or `/chat/completions` endpoint, returning a `ModelHealthResult` with one of `available`, `quota_exhausted`, `rate_limited`, `unavailable`, or `unknown`. Supports both Anthropic-Messages (`x-api-key` + `anthropic-version`) and OpenAI-Completions (`Bearer`) auth schemes; provider → base-url + API-style mapping is built in for `zai`, `volc`, `minimax`, and `deepseek`. Registered with the doctor for each omp provider so health checks reach the model layer.

### Changed

- **`ts-ai-runner` — Health probe routes through `ts-infra` `APIClient`:** HTTP is no longer emitted from the probe directly — `OmpModelProbe.issueRequest` constructs an `APIClient` per request and uses `rawRequest` for the HTTP call. Timeout is owned by `APIClient` (via `RequestOptions.timeout`) and surfaces as `APIError(status=0)`, which the probe maps to `"probe timed out"`. This is the first non-infra consumer of `APIClient`; tests inject `apiClientConfig` (or rely on the lazy `globalThis.fetch` resolution) rather than mutating `globalThis.fetch` directly.
- **`ts-runtime` — Remote schema fetching requires an explicit `fetch`:** `StructuredConfigLoadOptions.allowRemote` no longer implies a built-in fetch implementation. The `boundedFetch` default (which wrapped `globalThis.fetch` with an `AbortSignal.timeout`) and its `REMOTE_SCHEMA_FETCH_TIMEOUT_MS` constant have been removed. Callers that want remote `$schema` resolution must now pass `{ fetch: impl }` — typically an `APIClient.rawRequest`-backed function with their own timeouts, although the layering keeps `ts-runtime` independent of `ts-infra`. This closes the last non-`api-client.ts` `globalThis.fetch` seam in the codebase.

### Security

- **`ts-runtime` — `allowRemote` no longer auto-enables network I/O:** Removing the default fetch means config loading never reaches the network unless the caller opts in by supplying both `allowRemote: true` (or by supplying `fetch` directly) AND a fetch implementation. The previous behaviour effectively granted an unstated SSRF/DoS surface to any caller that toggled `allowRemote`. Explicit-injection is now the only path.

### Maintenance

- **`.spur/rules` — `no-globalthis-fetch` tightened to one exemption:** The rule now excludes only `packages/infra/src/api-client.ts`. The previous exemption for `packages/runtime/src/schema-validation.ts` has been removed alongside the `boundedFetch` cleanup. Any new `globalThis.fetch(` call site anywhere else under `packages/**/*.ts` will now fail `recommended-pre-check`.

## [0.4.4] — 2026-07-08

### Changed

- **`ts-rule-engine` — `tsdoc-export` accepts line comments:** The `tsdoc-export` evaluator now treats a preceding `//` line comment as valid documentation for an exported declaration, not just JSDoc `/** */` blocks. The rule description and finding message were updated to reflect the broader accepted-comment vocabulary. This loosens a previously over-strict check that flagged exports documented only with line comments.

### Fixed

- **Project rules — DDL rules align on rule-engine persistence seam:** `no-inline-ddl-outside-migrations` and `no-hand-written-ddl-for-drizzle-tables` now exclude `packages/rule-engine/src/persistence/schema.ts`, matching the existing `raw-sql-confined-to-persistence-seams` exclusion. The rule-engine's `schema.ts` is an engine-owned DDL seam (it exports `CREATE TABLE` strings for `rule_runs`/`rule_eval_runs`, mirroring `ts-dual-workflow-engine`'s `schema-sql.ts`), not a Drizzle table module — the two rules were falsely flagging it.

## [0.4.0] — 2026-06-25

### Breaking Changes

- **`ts-ai-runner` — Authentication decoupled from run-readiness:** the doctor no longer conflates liveness with authentication. `DoctorResult.usable` is now **liveness-only** (`installed && version !== null`), and `DoctorResult.authenticated` is a **tri-state** `AuthState` (`'authenticated' | 'unauthenticated' | 'unknown'`) instead of a boolean.
  - **Why:** a stale or missing auth probe previously made perfectly-runnable agents (`omp`, `opencode`, `antigravity-cli`) report `usable: false`, which routed the pipeline to a flagged-unusable pinned agent and burned ~40 min in timed-out stages.
  - **Migration:** update consumers that read `result.authenticated` as a boolean to the new `AuthState` union. The new `unknown` state is first-class — agents with no reliable auth probe report `unknown`, never a silent `false`. Code that gated execution on `usable` keeps working; code that branched on `authenticated === true/false` must handle the tri-state.

### Added

- **`ts-ai-runner` — `isAuthenticated(agent, ctx)` + `AuthState`:** auth detection is relocated to a new `agents/auth-shims.ts` module (re-exported from the package barrel). It is **off the execution critical path** — operator information only, never feeds run-readiness, and never throws. A genuinely unauthenticated agent fails at runtime with its own error. Inject a fake filesystem via `AuthContext.fileSystem` for tests.

## [0.3.21] — 2026-06-20

### Breaking Changes

- **`ts-runtime` — Deprecated FileSystem surface retired:** `NodeFileSystem`, `NodeSyncFileSystem`, `CloudflareFileSystem` classes and the `getFs()`/`setFileSystem()` global singletons have been removed from the runtime barrel. Use `createNodeFileSystem()` or `createCfFileSystem()` from their named subpaths instead. The canonical union-return `FileSystem` interface (with `rename` added) is now the only filesystem type. Utility functions (`walkDir`, `readJsonFile`, `atomicWriteFile`, etc.) accept the canonical `FileSystem` and default to `createNodeFileSystem()`.

### Added

- **`ts-rule-engine` — FileSystem injection port:** `RuleEngineOptions.fileSystem?: FileSystem` and the per-evaluation `RuleContext.fileSystem` field provide a testable DI seam. All evaluators and fixer providers now read the filesystem from context (default `createNodeFileSystem()`) instead of constructing their own `new NodeFileSystem()`. Inject a fake filesystem in tests through `new RuleEngine({ fileSystem: fakeFs })`.
- **`ts-infra` — `runCliApplication` bootstrap:** A new `runCliApplication` convenience function wraps the CLI lifecycle through `exitProcess` and `echoError`, giving CLI tools a standard bootstrap with proper exit-code handling.
- **`ts-utils` — `exitProcess` seam:** New `exitProcess` function and `ExitTarget` injection port for testable process exit in CLI applications.

### Changed

- **`ts-rule-engine` — Evaluator modules reorganized:** `file-utils.ts` has been split into focused evaluator modules, clarifying module boundaries and reducing the blast radius of future changes.
- **`ts-rule-engine` — `bundledRulesRoot()` / `listBundledRuleFiles()` now async:** These functions return `Promise<string | null>` and `Promise<string[]>` respectively, reflecting the canonical `FileSystem`'s union-return contract. Callers should `await` the result.

### Fixed

- **`ts-ai-runner` — Coding agent shims refreshed:** Detection shims updated for the latest coding agent releases, improving agent compatibility checks and doctor diagnostics.
- **`ts-runtime` — V8 function-coverage phantoms eliminated:** Evaluator classes (`PathEvaluator`, `SchemaArtifactEvaluator`, `CoverageGateEvaluator`, `ForbiddenImportEvaluator`) now have explicit constructors so V8 no longer counts compiler-synthesized defaults as uncovered functions.

## [0.3.20] — 2026-06-19

### Fixed

- **`ts-dual-workflow-engine` — Guard and condition template resolution:** Guards (state-machine driver) and conditions (transition-flow driver) now resolve `${vars.*}` templates in their options before evaluation, matching the interpolation behavior actions already had. Previously, raw un-interpolated options reached guard/condition evaluators, so shell-based guards like `spur task check ${vars.wbs}` failed with a literal bad substitution. The external transition path (`WorkflowService.requestTransition`) was fixed the same way for parity.
- **`ts-db` — Custom migration journal table names:** The embedded migration fallback path rejected custom journal table names (e.g. `my_migrations`) that the entry validator accepted, because the fallback re-validated with a tighter regex (`^__[a-z_]+$`) than the entry rule (`^[A-Za-z_]\w*$`). Both paths now use the single `validateMigrationTableName` validator, and the validated name flows through to both the file-based migrator and the embedded fallback.
- **`ts-runtime` — Async YAML config loading:** `readYamlConfig` in the Node/Bun runtime factory was synchronous but the `FileSystem` contract returns a union (sync or async). Under an async backend, `fs.exists()` was always truthy and `readFile()` returned an un-awaited Promise, causing config loading to silently break. Both calls are now properly `await`ed.

## [0.3.10] — 2026-06-10

### Added

- **`ts-infra` — EventBus auto-logging:** `EventBus` constructor accepts an optional `logger?: Logger`. On every `emit`, a `debug`-level `event.emit` log line is written before dispatch, removing the need for manual per-event logging in callers. Backward compatible — absent logger retains existing behavior.
- **`ts-dual-workflow-engine` — EventBus in ActionRunContext:** `ActionRunContext` now carries an optional `events?: EventBus<WorkflowEngineEvents>`, threaded from `WorkflowRunOptions.events` through both drivers (state-machine + transition-flow). Action runners can emit typed workflow events directly.
- **`ts-dual-workflow-engine` — HITL responder contract:** New `HitlRequest`, `HitlAnswer`, `HitlResponder`, and `HitlRequestKind` types exported from the engine package. Defines the interface downstream HITL action runners consume — no implementation ships here.
- **`ts-dual-workflow-engine` — `event.emit` builtin action:** New `EventEmitActionRunner` (`kind: 'event.emit'`, origin `'builtin'`) emits typed `workflow.custom` events with templated `name` and `payload`. Registered in `createDefaultWorkflowEngineHost()`.
- **`ts-dual-workflow-engine` — `note` emits `workflow.hitl.note`:** `NoteActionRunner` now emits a `workflow.hitl.note` event via `context.events` while remaining a no-op success. Downstream subscribers (spur CLI) decide display/notification.

### Changed

- **`ts-dual-workflow-engine` — EventBus logging dedup:** `RunLifecycle.enter()` and `recordTransition()` no longer emit redundant `logger.debug('entered'…)` / `logger.debug('transition'…)` lines — these are now covered by the EventBus auto-logging in `ts-infra`. Semantic lifecycle logs (`workflow run started/done/failed`, `action failed (continuing)`) are kept.

### Added

- **`ts-runtime` — Platform factory pattern:** New `RuntimeFactory` interface and `loadRuntimeFactory()` / `createRuntimeContextFromFactory()` APIs that auto-detect the runtime (Bun/Node vs Cloudflare Workers) and provide a unified `FileSystem` + `ProcessExecutor` + platform context seam. Shipped factories: `nodeBunFactory` and `cloudflareWorkersFactory`. Replaces the previous `getFs()`/`setFileSystem()` global swap (ADR-011, supersedes ADR-008).
- **`ts-runtime` — Split filesystem implementations:** `NodeFileSystem` (Bun/Node) and `CloudflareFileSystem` (Workers) are now first-class, individually importable modules behind a shared `FileSystem` interface with full `stat`, `realpath`, `copy`, `rename`, `mkdir` support.
- **`ts-runtime` — Platform detection helpers:** `isCloudflareWorkerRuntime()` and `_resetRuntimeFactory()` for test isolation.
- **`ts-runtime` — Expanded `ProcessExecutor` surface:** `BunSyncProcessExecutor`, `BunPipeProcessSpawner`, `NodeProcessExecutor` exported directly; richer spawn options, improved sync/pipe execution, and `findProjectRoot()` utility.
- **`ts-runtime` — Path utility consolidation:** POSIX-style path helpers (`basenamePath`, `dirnamePath`, `joinPath`, `normalizePath`, `relativePath`, `resolvePath`, `SEP`) consolidated under `ts-runtime`, eliminating all direct `node:path` usage across the workspace (ADR-011).
- **`ts-infra` — Structured event maps:** New typed event maps for DB (`DbEvents`), queue (`QueueEvents`), scheduler (`SchedulerEvents`), and API client (`ApiClientEvents`) with a unified `InfraEvents` union type. Enables typed `EventBus` subscriptions across all infra subsystems.
- **`ts-infra` — Event bus observers:** `defaultObservers` (structured console logging) and `fileObserver` (JSONL file logging) for zero-config observability on any `EventBus` channel.
- **`ts-infra` — Scheduler event emission:** Scheduler actions now emit `scheduler.job.executed`, `scheduler.job.failed`, `scheduler.job.retrying` events through the typed event map, with a new `wrapHandler` utility for observer-annotated job execution.
- **`ts-infra` — DB job queue re-export:** `@gobing-ai/ts-infra/job-queue-db` subpath now available from the main barrel for convenience.
- **`ts-rule-engine` — Observability via EventBus:** `RuleEngine.evaluate()` and `evaluateWithFixes()` accept an optional `events: EventBus<RuleEngineEvents>` parameter, emitting structured `rule.run.start/done` and `rule.eval.start/done/error` events for external monitoring (ADR-013).
- **`ts-rule-engine` — Ripgrep evaluator:** New `ripgrep` evaluator (`rg`) that shells out to `rg` with include-glob forwarding, exclude filtering, and JSON output parsing for fast content-based rule checks.
- **`ts-dual-workflow-engine` — Run lifecycle module:** New `RunLifecycle` class that instruments workflow runs with typed events (`run.start`, `node.start/done/error`, `run.done/error`) via `ts-infra` `EventBus`, enabling external monitoring and structured logging (ADR-013).
- **`ts-dual-workflow-engine` — Trust-gated extension loading:** Actions and guards can be loaded from trust-gated `ExtensionRef` entries via the shared `loadExtensionModules` from `ts-runtime/plugin`, with host-level trust validation before dynamic imports.
- **`ts-dual-workflow-engine` — Extension configuration:** `WorkflowDef` gained an `extensions` field for declaring extension modules that provide custom actions, guards, and resolvers.
- **`ts-ai-runner` — Event maps:** New `AgentEvents` and `AiRunnerProcessEvents` typed event maps for agent lifecycle observability.
- **`ts-ai-runner` — Typed message helpers:** New `messages` module with structured agent message construction utilities.

### Changed

- **`ts-runtime` — Platform APIs fully owned:** All remaining direct `node:fs`, `node:path`, `node:os`, `node:child_process`, `Bun.spawn`, `Bun.which`, and `process.env` usage across the workspace now routes through `ts-runtime` abstractions (ADR-011, enforced by `runtime-boundaries` spur rule).
- **`ts-runtime` — Context refactor:** `RuntimeContext` now carries a `RuntimeFactory`-provided platform bundle instead of standalone filesystem globals.
- **`ts-infra` — Logger hardening:** Logger implementation refactored for cleaner structured output, consistent timestamp formatting, and improved testability.
- **`ts-infra` — API client events:** API client now emits typed error events for connection failures and retries.
- **`ts-infra` — DB job queue observability:** `DBJobQueue` and `DBQueueConsumer` emit structured events for job execution, failure, and retry lifecycle.
- **`ts-infra` — Scheduler action refactor:** `SchedulerAction` wraps handlers with event emission, replacing ad-hoc logging with typed observability.
- **`ts-rule-engine` — Evaluator consolidation:** Evaluator config helpers unified with shared file-scanning utilities and consistent test-resolver fallback patterns.
- **`ts-rule-engine` — Extension loading delegates to shared plugin core:** Rule engine extension loading now delegates to `loadExtensionModules` from `ts-runtime/plugin`, removing the package-local `CapabilityRegistry` in favor of the shared registry.
- **`ts-dual-workflow-engine` — Plugin-based architecture:** Action, guard, and resolver loading refactored onto the shared plugin registry from `ts-runtime/plugin`, with host-level capability declarations.
- **`ts-dual-workflow-engine` — State machine and transition flow refactored:** Run loops emit lifecycle events, use `RunLifecycle` for structured logging, and delegate extension resolution to the plugin host.
- **`ts-ai-runner` — Post-migration cleanup:** Inlined `MessageService` pass-through into `TeamOrchestrator`; dropped dead `identityPreamble` computation in `TeamAgentProcess`; expanded test coverage for doctor, agent detection, and team orchestration.
- **`ts-ai-runner` — Package dependencies:** `ts-ai-runner` now depends on `ts-runtime` for process execution and path utilities.
- **`ts-db` — Minor cleanup:** Removed unused barrel re-exports; `EntityDao` gained internal type clarifications; embedded migration version tracking improved.
- **`ts-llm-jsonl-importer` — Safer import edge cases:** Improved checkpoint handling and hash stability for incremental imports.
- **`ts-utils` — JSDoc for all exports:** Added comprehensive JSDoc documentation to every exported entity across `access`, `api-response`, `cursor`, `date`, `errors`, `origin`, and `output` modules.
- **`docs/00_ADR.md` — Five new/revised ADRs:** ADR-011 (runtime factory pattern + path consolidation), ADR-012 (`dependencies` vs `paths` scope), ADR-013 (workflow run lifecycle observability), ADR-014 (`ts-infra` core/adapter boundary), ADR-008 (superseded by ADR-011).
- **Package READMEs updated:** `ts-runtime`, `ts-rule-engine`, `ts-dual-workflow-engine`, `ts-ai-runner`, `ts-infra` READMEs rewritten to reflect new APIs, factory pattern, and observability features.

### Fixed

- **`ts-infra` — Migration parity:** Resolved multiple migration drift issues where ts-infra exports, subpath structure, and adapter boundaries diverged from the planned architecture.
- **`ts-runtime` — Migration drift:** Fixed runtime library migration drift for filesystem, context, and process executor modules.

### Removed

- **`ts-ai-runner` — `MessageService` class removed:** Inlined into `TeamOrchestrator`; the separate `MessageService` module and its tests were deleted.
- **`ts-rule-engine` — `CapabilityRegistry` removed:** Replaced by the shared `CapabilityRegistry` from `@gobing-ai/ts-runtime/plugin`.

## [0.3.1] — 2026-06-04

### Changed

- **`ts-rule-engine` — Rule re-categorization:** Moved `tsdoc-exports` rule from `typescript/` to `quality/` category so it can run alongside `coverage-gate` in post-test checks without duplicating the full `typescript` category. The `spur-dev` preset now extends the full `quality` category instead of cherry-picking individual rule files.
- **`ts-rule-engine` — `stopOnFirst` traversal control:** `RuleEngine.evaluate()` and `evaluateWithFixes()` accept an optional `stopOnFirst?: 'error' | 'warning' | 'info'` parameter. When set, the rule loop breaks after the first rule whose findings meet/exceed the severity threshold. Undefined default preserves exhaustive evaluation.
- **`ts-dual-workflow-engine` — Per-action `onError` policy:** `ActionDef`, `StateMachineWorkflowDef`, `TransitionFlowWorkflowDef`, and `WorkflowRunOptions` gained an `onError?: 'fail' | 'continue'` field. The resolved policy follows precedence `action.onError ?? workflow.defaultOnError ?? runOptions.onError ?? 'fail'`. `'continue'` logs a non-fatal warning via `RunLifecycle.warnActionFailed()` and advances to the next node/state; `'fail'` halts (unchanged default).
- **`docs/00_ADR.md` — ADR-013 addendum:** Documents the deliberate design: severity-vocabulary aligned across engines, policy verbs distinct (`stopOnFirst` vs `onError`), no shared code, verdict stays in the consumer.

## [0.3.0] — 2026-06-02

### Added

- **`ts-rule-engine` — Bundled default rule presets:** The package now ships a `rules/` asset tree with portable `recommended` and `spur-dev` presets plus TypeScript, structure, and quality rule files. Consumers can run a working baseline ruleset without authoring local rule files first.
- **`ts-rule-engine` — Bundled rule discovery helpers:** Added `bundledRulesRoot()` and `listBundledRuleFiles()` to locate packaged rule assets and enumerate copyable preset/rule files at runtime.
- **`ts-runtime` — Sync filesystem stat support:** `SyncFileSystem` and `NodeSyncFileSystem` now expose synchronous `exists()` and `stat()` methods so synchronous package-asset discovery can stay behind the runtime abstraction.

### Changed

- **`ts-rule-engine` — Published package assets:** The npm package now includes the bundled `rules/` directory in addition to `dist`, `schemas`, `src`, and docs.
- **`ts-rule-engine` — Public exports:** The bundled-rule discovery helpers are exported from the main package barrel for direct consumer use.

### Breaking Changes

- **`ts-rule-engine` version line:** `@gobing-ai/ts-rule-engine` moves to `0.3.0` while the rest of the workspace remains on `0.2.9` in this commit range. Treat this as a rule-engine package release, not a lockstep workspace bump.

## [0.2.9] — 2026-06-02

### Added

- **`ts-ai-runner` — Team-mode primitives:** Added agent spec loading/saving, identity preamble generation, durable message service integration, long-running agent subprocess management, and a `TeamOrchestrator` for starting agents and routing persisted/live messages.
- **`ts-db` — Durable inbox persistence:** Added `InboxMessageDao`, the `inbox_messages` table, embedded migration support, and the `@gobing-ai/ts-db/inbox` subpath for inter-agent and workflow messaging.
- **`ts-runtime` — Process and path primitives:** Added sync process execution, pipe-based subprocess spawning, sync filesystem support, and runtime-portable POSIX-style path helpers.
- **`ts-utils` — Shared object/API helpers:** Added `isPlainObject`, `deepMerge`, `flattenKeys`, `deFlattenKeys`, and `toApiResponse()` for consistent object handling and domain-error-to-API-envelope mapping.
- **Project planning docs:** Added task records for rule-engine review follow-ups, evaluator seam refactoring, and team-mode primitives.

### Changed

- **`ts-infra` — Telemetry export is opt-in:** Core telemetry now instruments against the globally registered OpenTelemetry provider and no longer owns exporter setup. Node OTLP export moved to the new `@gobing-ai/ts-infra/otel-node` subpath with optional exporter peers.
- **`ts-runtime` — Runtime selection simplified:** Removed the unused `RuntimeFactory` path in favor of the existing `getFs()` / `setFileSystem()` global filesystem seam.
- **`ts-rule-engine` — Rule-file extension parity:** Rule files can now declare the same trusted `extensions` block as presets, using the existing `allowExtensions` gate. Preset override handling now deduplicates by rule id and prevents overrides from raising fix authority.
- **`ts-rule-engine` — Evaluator scanning consolidation:** Regex, forbidden-import, secrets, import-boundary, and TSDoc-export evaluators now share a single file-scanning seam with explicit loose/glob match modes, reducing duplicated file discovery logic while preserving evaluator behavior.
- **`ts-dual-workflow-engine` — Stronger workflow validation:** Workflow loading now reports field-specific schema errors, aggregates semantic validation failures, validates duplicate states/nodes and edge/transition endpoints, rejects unreachable unguarded transition ordering, and checks template references against declared vars/env/runtime namespaces.
- **`ts-llm-jsonl-importer` — Safer hashing/error surface:** Stable JSON hashing now handles `undefined` consistently, and invalid target table names raise `HistoryImportError` with structured details.
- **`ts-utils` — Runtime portability hardening:** Cursor encoding now uses web-standard base64url APIs with a length guard, output streams resolve lazily for Worker-safe imports, and timestamp parsing rejects non-finite numbers.

### Fixed

- **`ts-rule-engine`:** Malformed `LF:` / `LH:` values in lcov input no longer produce `NaN` coverage findings.
- **`ts-dual-workflow-engine`:** Runtime template built-ins and config-time reference validation now align, avoiding false validation failures for supported runtime namespaces.
- **`ts-db`:** Drizzle internals are further quarantined behind shared builder helpers, and queue/inbox DAO behavior gained focused coverage.

### Breaking Changes

- **`ts-rule-engine`:** `loadRuleFile()` now returns `{ rules, extensions }` instead of a bare rule array, matching `loadPreset()`. Existing callers should destructure `rules`.
- **`ts-infra`:** `TelemetryConfig.exporterEndpoint` / `exporterProtocol` and main-barrel exporter ownership were removed. Use BYO OpenTelemetry provider setup or import `initNodeTelemetry()` from `@gobing-ai/ts-infra/otel-node`.
- **`ts-infra`:** HTTP-server and DB-specific metric getter exports were removed from the core metric surface as part of the instrumentation/export split.

## [0.2.8] — 2026-06-01

### Added

- **`ts-runtime` — Structured config loader with JSON-schema validation:** New `loadStructuredConfig()` / `parseStructuredConfig()` read JSON or YAML and, when a file declares a top-level `$schema`, validate it against that schema before returning. Ships a dependency-free JSON Schema subset validator (`validateJsonSchema`) supporting `type`, `required`, `properties`, `additionalProperties`, `items`, `enum`, `const`, `oneOf`, `anyOf`, and `$ref`/`$defs`. Violations raise a `StructuredConfigSchemaError` carrying a structured `violations` list.
- **`ts-runtime` — Bundled package-specifier schema refs:** `$schema` can reference a schema shipped inside an installed package — e.g. `"@gobing-ai/ts-rule-engine/schemas/rule-file.schema.json"` — resolved through `node_modules` with no network access. This is the recommended, default reference style.
- **`ts-rule-engine` / `ts-dual-workflow-engine` — Bundled JSON schemas:** Each package now ships editor- and loader-usable JSON schemas under `schemas/` (`rule-file`, `preset`, `state-machine-workflow`, `transition-flow-workflow`) and exposes an optional `$schema` field on rule, preset, and workflow files.
- **`ts-runtime` — Expanded `FileSystem` surface:** `NodeFileSystem` / `CloudflareFileSystem` gain `stat`, `realpath`, `copy`, `rename`, and recursive `mkdir`, with `CloudflareFileSystem` providing a consistent unsupported-filesystem facade.
- **`ts-infra` — Database-backed job queue:** New `DBJobQueue` and `DBQueueConsumer` provide a durable, DB-persisted job queue alongside the existing in-memory queue.

### Changed

- **`ts-rule-engine` / `ts-dual-workflow-engine`:** Rule, preset, and workflow file loading now routes through `ts-runtime`'s structured config loader, honoring top-level `$schema` refs by default (opt out with `validateSchema: false`).

### Security

- **`ts-runtime` — Remote schema fetching off by default:** `http(s)://` `$schema` refs are refused unless the caller opts in via `{ allowRemote: true }` or supplies a `fetch` implementation, closing an SSRF/DoS surface for third-party-authored config files. The built-in remote fetch is time-bounded (5s). Bundled package-specifier refs remain fully local.

## [0.2.7] — 2026-06-02

### Added

- **`ts-rule-engine` — Fix pipeline:** Added rule-level fix metadata, candidate `Fix` results, `RuleEngine.evaluateWithFixes()`, and `RuleEngine.applyFixes()` for dry-run or write-mode byte-range fixes. Built-in fixers now support regex replacements, forbidden-path deletion, and generated test stubs for missing-test findings.
- **`ts-rule-engine` — Pluggable preset extensions:** Presets can now declare opt-in extension modules for resolvers, evaluators, and formatters. Extension loading is explicit via `allowExtensions: true` so preset-provided code is never imported silently.
- **`ts-rule-engine` — Test-path resolvers:** Added exported resolver implementations for TypeScript, Python, Go, and Rust test-location conventions, enabling resolver-aware missing-test checks and generated test skeletons.
- **`ts-rule-engine` — New evaluators:**
  - **Import Boundary** (`import-boundary`): Enforces architectural import and usage boundaries in-process with scoped forbidden patterns and per-boundary excludes.
  - **Schema Artifact** (`schema-artifact`): Validates JSON schema artifacts for existence, JSON validity, required title, required properties, `$defs` / `definitions`, and top-level `required`.
  - **ast-grep** (`sg`): Runs `sg` patterns with include glob forwarding, exclude filtering, and JSON output parsing.

### Changed

- **`ts-rule-engine`:** Existing regex, path, forbidden-import, secrets-scanner, test-location, TSDoc, and exit-code evaluators now return richer structured findings and fixes where applicable.
- **`ts-rule-engine`:** Rule preset loading now supports preset extension discovery, override parity, and additional edge-case validation.

### Fixed

- **`ts-rule-engine`:** Moved dynamic test fixtures out of repo-local `.tmp` directories so Bun coverage no longer instruments generated fixture modules.
- **`ts-rule-engine`:** Covered Bun/V8 implicit-constructor coverage edge cases in new evaluator and resolver classes.

## [0.2.6] — 2026-06-01

### Added

- **`ts-rule-engine` — Three new evaluators:**
  - **Coverage Gate** (`coverage-gate`): Enforces per-file line-coverage thresholds from lcov tracefiles. Supports per-file exemptions with justification, `include`/`exclude` glob scoping, and graceful degradation when no lcov file is present.
  - **Test Location** (`test-location`): Enforces test-file placement via expected and forbidden globs. Optional `requireCorrespondingTest` mode flags source files missing a conventional test counterpart (e.g., `packages/x/src/a.ts` → `packages/x/tests/a.test.ts`).
  - **TSDoc Export** (`tsdoc-export`): Scans TypeScript source files and flags exported declarations (functions, classes, types, interfaces, consts, enums) missing a preceding JSDoc comment block. Configurable per-kind with single-line and multi-line JSDoc support.
- **`ts-rule-engine` — Shared evaluator utilities:** `file-utils` module providing `discoverFiles`, `matchesGlob`, and `readWorkdirFile` for evaluator file scanning.

### Changed

- **`ts-rule-engine`:** Rule preset loader and built-in rules updated to register the three new evaluators.

## [0.2.4]

### Changed

- **`ts-db`:** Extracted inline query-builder type annotations into named type aliases (`TransactionalDb`, `SelectQuery`, `InsertBuilder`, `UpdateBuilder`, `DeleteBuilder`, `CountQuery`, `ReturningRows`) across `BaseDao`, `EntityDao`, and `QueueJobDao`. No API surface change — purely internal readability improvement.

### Breaking Changes

#### `@gobing-ai/ts-db` — Drizzle-Free Facade (v0.2.3)

The ts-db package has been rewritten into a complete facade. Drizzle ORM is now an internal
implementation detail — consumers never import it.

- **New public surface:** `createDbAdapter`, `BaseDao` (raw-tier queries: `query`, `one`, `tx` over a predicate spec), `EntityDao` (typed CRUD), `defineTable` (single-source-of-truth table → derived Zod schemas).
- **Removed:** `DbClient` interface (was a lossy drizzle wrapper with `as unknown as` casts).
- **Removed:** raw SQL escaping the DAO abstraction — all queries go through the facade.
- **Optional peers:** `drizzle-zod` + `zod` (only needed for `defineTable` validation).
- **Schema construction:** use `packages/db/src/schema/` primitives or `defineTable`.
- **Enforced:** no `@gobing-ai/ts-*` package other than `ts-db` may import `drizzle-orm` (`db-boundaries` spur rule, ADR-005).

Migration guide: replace `DbClient` with `DbAdapter`, switch raw SQL to predicate-spec queries via `BaseDao.query()`/`BaseDao.one()`, and use `defineTable` for table + Zod schema co-location.

#### Internal Dependencies: `workspace:*`

All internal `@gobing-ai/ts-*` dependencies now use the `workspace:*` protocol (ADR-002). Hand-written version ranges are banned. The publish step resolves `workspace:*` → `^<version>` at publish time (ADR-003).

### New Packages

- **`@gobing-ai/ts-ai-runner`** — Coding-agent command shims, detection heuristics, doctor checks, and prompt execution for Bun/Node CLIs.
- **`@gobing-ai/ts-rule-engine`** — Constraint rule schemas, preset loading, evaluator orchestration, and result formatting. Powers the `spur` quality gate.
- **`@gobing-ai/ts-dual-workflow-engine`** — Standalone workflow runtime combining state-machine and transition-flow engines. Owns definition loading, validation, variable resolution, action execution, persistence schema, and driver loops.
- **`@gobing-ai/ts-llm-jsonl-importer`** — Generic JSONL importer for LLM agent history files. Handles schema validation, source definitions, content redaction, hash-based deduplication, and checkpointed incremental imports.

### Added

- **`ts-db`:** `defineTable` — single-source-of-truth table definition with opt-in Zod validation (DAO `validate` option).
- **`ts-db`:** Raw-tier query methods on `BaseDao` — `query()`, `one()`, `tx()` operating over a drizzle-free predicate/order query spec.
- **`ts-db`:** `upsert`, `createMany`, composite-PK support in `EntityDao`.
- **`ts-db`:** `QueueJobDao` persistence.
- **Build:** Cross-package `paths` aliases so `tsc` typechecks against live sibling source (ADR-004).
- **Quality:** `spur` rule presets (`recommended`, `spur-dev`) enforcing architecture invariants: drizzle containment, DB boundaries, runtime/output/http boundaries (ADR-006).
- **Docs:** Architecture Decision Record (`docs/00_ADR.md`) — authoritative source for workspace design, versioning, dependency protocol, and facade decisions.
- **Agent contract:** `AGENTS.md` + `CLAUDE.md` + `GEMINI.md` for AI coding agent guidance.

### Fixed

- **`ts-dual-workflow-engine`:** Updated test `DbAdapter` mock for ts-db 0.2.0 compatibility.
- **`ts-llm-jsonl-importer`:** Reset JSONL import checkpoints in full mode to prevent stale state.
- **`ts-rule-engine`:** Hardened rule evaluator edge cases.

### Changed

- **Build:** `bump-ver` now discovers publishable workspaces dynamically — new packages need only the manifest, no script edits.
- **Build:** Root `build`, `typecheck`, and Bun smoke imports automatically discover workspaces.
- **Build:** Publish triggers from a single aggregate `@gobing-ai/ts-libs-v<version>` tag (lockstep).
- **Tooling:** Build/release automation consolidated behind `scripts/builder.ts` with shared constants and helpers.

---

## [0.1.5] — 2026-05-29

- **CI** — serialize Publish runs with a `concurrency` group and treat "already published" as a clean skip.
- **CI** — pin npm to `^11.5.1` (was `@latest`) in the publish workflow.
- **Tooling** — `bump-ver` pre-checks remote tags and npm for target version, scopes release commit to manifests + changelog + lockfile.
- **Docs** — release guide and README aligned with current tag-triggered, lockstep flow.

## [0.1.4] — 2026-05-29

- **CI** — fixed tag-trigger chain: corrected tag glob to `**-v*`, push tags individually (GitHub skips runs when >3 tags pushed at once), ensure tagged commit reachable from `main`.

## [0.1.3] — 2026-05-29

- **Tooling** — added `bump-ver` and `drop-tags` scripts (dynamic workspace discovery).
- **Tooling** — `bump-ver` now prints a `chore(release):` commit.

## [0.1.2] — 2026-05-29

- **CI** — fixed Publish workflow tag trigger so pushing `*-v<version>` publishes automatically.

## [0.1.1] — 2026-05-29

- **CI** — build before lint/typecheck so cross-package type imports resolve on clean checkout.
- **CI** — bumped `actions/checkout` and `actions/setup-node` to v6.
- **Tests** — made `resolveProjectPath` test portable.

## [0.1.0] — 2026-05-29

Initial public release.

- **`@gobing-ai/ts-utils`** — zero-dependency utilities: access control, API responses, cursor pagination, dates, errors, origins, output.
- **`@gobing-ai/ts-runtime`** — runtime abstractions (Bun / Node / Cloudflare Workers): config, context, filesystem, process executor.
- **`@gobing-ai/ts-db`** — Drizzle ORM layer: adapters (Bun SQLite, Cloudflare D1), DAOs, schema builders, migrations.
- **`@gobing-ai/ts-infra`** — infrastructure: API client, event bus, job queue, scheduler, logger, OpenTelemetry telemetry.

[Unreleased]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.23...HEAD

[0.4.23]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.22...@gobing-ai/ts-libs-v0.4.23
[0.4.20]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.19...@gobing-ai/ts-libs-v0.4.20
[0.4.18]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.16...@gobing-ai/ts-libs-v0.4.18
[0.4.15]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.14...@gobing-ai/ts-libs-v0.4.15
[0.4.12]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.11...@gobing-ai/ts-libs-v0.4.12
[0.4.11]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.10...@gobing-ai/ts-libs-v0.4.11
[0.4.6]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.5...HEAD
[0.4.5]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.4...@gobing-ai/ts-libs-v0.4.5
[0.4.4]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.4.3...@gobing-ai/ts-libs-v0.4.4

[0.3.20]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.3.19...HEAD
[0.3.1]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.3.0...@gobing-ai/ts-libs-v0.3.1
[0.3.0]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.9...@gobing-ai/ts-libs-v0.3.0
[0.2.9]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.8...@gobing-ai/ts-libs-v0.2.9
[0.2.8]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.7...@gobing-ai/ts-libs-v0.2.8
[0.2.7]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.6...@gobing-ai/ts-libs-v0.2.7
[0.2.6]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.5...@gobing-ai/ts-libs-v0.2.6
[0.2.4]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.3...@gobing-ai/ts-libs-v0.2.4
[0.1.5]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.4...@gobing-ai/ts-libs-v0.1.5
[0.1.4]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.3...@gobing-ai/ts-libs-v0.1.4
[0.1.3]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.2...@gobing-ai/ts-libs-v0.1.3
[0.1.2]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.1...@gobing-ai/ts-libs-v0.1.2
[0.1.1]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.0...@gobing-ai/ts-libs-v0.1.1
[0.1.0]: https://github.com/gobing-ai/ts-libs/releases/tag/@gobing-ai/ts-libs-v0.1.0
