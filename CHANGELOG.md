# Changelog

All notable changes to the `@gobing-ai/ts-*` packages are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). All packages are
versioned in **lockstep** — a single version number covers every package in the monorepo.

## [0.2.0] — Unreleased

### Breaking Changes

#### `@gobing-ai/ts-db` — Drizzle-Free Facade (v0.2.0)

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

[0.2.0]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.5...HEAD
[0.1.5]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.4...@gobing-ai/ts-libs-v0.1.5
[0.1.4]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.3...@gobing-ai/ts-libs-v0.1.4
[0.1.3]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.2...@gobing-ai/ts-libs-v0.1.3
[0.1.2]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.1...@gobing-ai/ts-libs-v0.1.2
[0.1.1]: https://github.com/gobing-ai/ts-libs/compare/@gobing-ai/ts-libs-v0.1.0...@gobing-ai/ts-libs-v0.1.1
[0.1.0]: https://github.com/gobing-ai/ts-libs/releases/tag/@gobing-ai/ts-libs-v0.1.0
