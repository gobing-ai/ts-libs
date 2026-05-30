# Changelog

All notable changes to the `@gobing-ai/ts-*` packages are documented here.

This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html), and the
format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Packages are
versioned **independently**; entries are grouped by package under each release.

## [Unreleased]

- **CI** — move Publish package selection into a workspace-aware script, so release tags for new `packages/*` packages work without editing the workflow.
- **CI** — scope Publish runs to the package/version named by the release tag and fail early on tag/manifest mismatches, preventing stale tag reruns from publishing an old manifest.
- **Tooling** — consolidate build/release automation behind `scripts/builder.ts`, centralize script constants in `scripts/config.ts`, and move unit coverage under `scripts/tests/`.
- **Tooling** — harden release pushes so `bump-ver --push` disables `push.followTags` and pushes each tag with an explicit source/destination ref.
- **CI** — trigger Publish from a single aggregate `@gobing-ai/ts-libs-v<version>` tag so lockstep releases publish all packages in one workflow run.
- **Tooling** — make root `build`, `typecheck`, and Bun smoke imports discover publishable workspaces automatically, reducing new-package setup to the package manifest plus optional Node smoke config.
- **Docs** — clarify the tag-scoped release workflow and stale-tag failure mode.

## 0.1.5 — 2026-05-29

- **CI** — serialize Publish runs with a `concurrency` group and treat "already published" as a clean skip, so per-tag release runs no longer race or fail red.
- **CI** — pin npm to `^11.5.1` (was `@latest`) in the publish workflow.
- **Tooling** — `bump-ver` now pre-checks remote tags and npm for the target version, and scopes the release commit to manifests + changelog + lockfile.
- **Docs** — release guide and README aligned with the current tag-triggered, lockstep release flow.

## 0.1.4 — 2026-05-29

- **CI** — fixed the tag-trigger chain end-to-end: corrected the tag glob to `**-v*`, push tags individually (GitHub skips runs when >3 tags are pushed at once), and ensure the tagged commit is reachable from `main` before tagging.

## 0.1.3 — 2026-05-29

- **Tooling** — added `bump-ver` and `drop-tags` scripts (dynamic workspace discovery) for releases.
- **Tooling** — `bump-ver` now prints a `chore(release):` commit (the previous `release:` type is rejected by the commit-msg hook).

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
