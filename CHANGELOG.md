# Changelog

All notable changes to the `@gobing-ai/ts-*` packages are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All packages are
versioned in **lockstep** — a single version number covers every package in the monorepo.


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

[0.3.20]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.3.19...HEAD
[0.3.2]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.3.1...HEAD
[0.3.1]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.3.0...@gobing-ai/ts-libs-v0.3.1
[0.3.0]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.9...@gobing-ai/ts-libs-v0.3.0
[0.2.9]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.8...@gobing-ai/ts-libs-v0.2.9
[0.2.8]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.7...@gobing-ai/ts-libs-v0.2.8
[0.2.7]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.6...@gobing-ai/ts-libs-v0.2.7
[0.2.6]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.5...@gobing-ai/ts-libs-v0.2.6
[0.2.4]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.3...@gobing-ai/ts-libs-v0.2.4
[0.2.3]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.5...@gobing-ai/ts-libs-v0.2.3
[0.1.5]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.4...@gobing-ai/ts-libs-v0.1.5
[0.1.4]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.3...@gobing-ai/ts-libs-v0.1.4
[0.1.3]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.2...@gobing-ai/ts-libs-v0.1.3
[0.1.2]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.1...@gobing-ai/ts-libs-v0.1.2
[0.1.1]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.0...@gobing-ai/ts-libs-v0.1.1
[0.1.0]: https://github.com/gobing-ai/ts-libs/releases/tag/@gobing-ai/ts-libs-v0.1.0
