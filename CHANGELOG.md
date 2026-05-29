# Changelog

All notable changes to the `@gobing-ai/ts-*` packages are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Packages are
versioned **independently**; entries are grouped by package under each release.

## [Unreleased]

## 0.1.2 — 2026-05-29

- **CI** — fixed the Publish workflow tag trigger so pushing a `*-v<version>` tag publishes automatically (previously only the manual run button worked).

## 0.1.1 — 2026-05-29

- **CI** — build before lint/typecheck so cross-package type imports resolve on a clean checkout.
- **CI** — bumped `actions/checkout` and `actions/setup-node` to v6.
- **Tests** — made the `resolveProjectPath` test portable (no hardcoded local path).

## 0.1.0 — 2026-05-29

Initial public release.

- **`@gobing-ai/ts-utils`** — zero-dependency utilities: access control, API responses, cursor pagination, dates, errors, origins, output.
- **`@gobing-ai/ts-runtime`** — runtime abstractions (Bun / Node / Cloudflare Workers): config, context, filesystem, process executor.
- **`@gobing-ai/ts-db`** — Drizzle ORM layer: adapters (Bun SQLite, Cloudflare D1), DAOs, schema builders, migrations.
- **`@gobing-ai/ts-infra`** — infrastructure: API client, event bus, job queue, scheduler, logger, OpenTelemetry telemetry.

[Unreleased]: https://github.com/gobing-ai/ts-libs/compare/main...HEAD
