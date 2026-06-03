# Changelog

All notable changes to the `@gobing-ai/ts-*` packages are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All packages are
versioned in **lockstep** — a single version number covers every package in the monorepo.

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

[0.2.9]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.2.8...HEAD
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
