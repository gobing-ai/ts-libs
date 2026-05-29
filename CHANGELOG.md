# Changelog

All notable changes to the `@gobing-ai/ts-*` packages are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Packages are
versioned **independently**; entries are grouped by package under each release.

## [Unreleased]

## 0.1.0 — 2026-05-29

Initial public release of the four-package TypeScript library suite.

### `@gobing-ai/ts-utils` 0.1.0

Zero-dependency TypeScript utilities.

- **Access control** — role-based access helpers.
- **API responses** — standardized success/error response envelopes.
- **Cursor pagination** — opaque cursor encode/decode helpers.
- **Dates** — date formatting and manipulation utilities.
- **Errors** — typed error classes and helpers.
- **Origins** — origin parsing/validation.
- **Output** — output formatting helpers.
- **Constants** — shared constants.

### `@gobing-ai/ts-runtime` 0.1.0

Runtime abstractions for Bun, Node, and Cloudflare Workers.

- **Config** — environment/configuration loading.
- **Context** — runtime execution context.
- **Filesystem** — cross-runtime filesystem access.
- **Process executor** — process execution (built on `execa`).
- **Types** — shared runtime type definitions.
- Depends on `@gobing-ai/ts-utils`.

### `@gobing-ai/ts-db` 0.1.0

Database abstraction layer built on Drizzle ORM.

- **Adapters** — `createDbAdapter` with `BunSqliteAdapter` (Bun SQLite) and `D1Adapter` (Cloudflare D1).
- **DAOs** — `BaseDao`, `EntityDao` (with soft-delete support), and `QueueJobDao`.
- **Schema builders** — `standardColumns`, `appendOnlyColumns`, soft-delete column helpers, and `queueJobs` schema.
- **Migrations** — `applyMigrations` and embedded-migration support.
- `drizzle-orm` is a peer dependency (`>=0.38.0`). Depends on `@gobing-ai/ts-runtime`.

### `@gobing-ai/ts-infra` 0.1.0

Infrastructure backbone for application services.

- **API client** — `APIClient` with typed errors (`APIError`).
- **Event bus** — `EventBus` and `createSystemBus` with typed event maps.
- **Job queue** — queue/consumer abstractions with enqueue options and stats.
- **Scheduler** — pluggable adapters for Node, Cloudflare, and no-op environments.
- **Logger** — `getLogger` / `initializeLogger` with configurable log levels.
- **Telemetry** — OpenTelemetry tracing and metrics (`initTelemetry`, `withSpan`, `traceAsync`, and HTTP/DB/queue/scheduler/event-bus instrument helpers).
- `@opentelemetry/api` is a peer dependency (`^1.9.0`). Depends on `@gobing-ai/ts-db` and `@gobing-ai/ts-runtime`.

[Unreleased]: https://github.com/gobing-ai/ts-libs/compare/main...HEAD
