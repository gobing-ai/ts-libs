# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` and `GEMINI.md` symlink here.

## Project

`@gobing-ai/ts-libs` — a **Bun-workspace monorepo** of small, independently published, lockstep-versioned
TypeScript libraries under `packages/*`:

| Package | Role |
|---------|------|
| `ts-utils` | output, errors, api-response, cursor, date, access helpers |
| `ts-runtime` | platform detection, factory, FileSystem, ProcessExecutor, path utilities, plugin core |
| `ts-db` | drizzle-free DB facade: adapters, `BaseDao`/`EntityDao`, predicate spec; schema helpers live behind `/schema` |
| `ts-infra` | portable logger/EventBus/telemetry/API client plus queue/scheduler contracts; DB/runtime/exporter adapters live behind subpaths |
| `ts-ai-runner` | coding-agent detection, doctor, prompt execution |
| `ts-rule-engine` | constraint rule schemas, loading, evaluation, formatting |
| `ts-dual-workflow-engine` | state-machine + transition-flow workflow runtime |
| `ts-llm-jsonl-importer` | generic JSONL importer for LLM history files |

- **Runtime / package manager / test runner:** Bun `1.3.14`. Use platform APIs only in their owning package/adapter seam; otherwise use `ts-runtime` abstractions.
- **Lint + format:** Biome. **Type gate:** per-package `tsc --noEmit`. No ESLint, no Prettier.
- **Hooks:** Lefthook. **Rule gate:** `spur` (global binary) against `.spur/rules/`.

Never introduce a new runtime, package manager, linter, or formatter.

## Key files (binding)

| File | What it governs |
|------|-----------------|
| `docs/00_ADR.md` | **Authoritative** architecture & release decisions. Read before any non-trivial change to the workspace graph, dependency strategy, the release/publish flow, the ts-db facade, or cross-package boundaries. A change that contradicts an ADR requires updating the ADR first (new dated entry). |
| `packages/<package>/README.md` | As a library collection project, we use package README.md to document the package's purpose and usage. |
| `docs/PACKAGE_RELEASE.md` | How releases work (lockstep versioning, OIDC Trusted Publishing, new-package bootstrap). |

## Commands

```bash
bun run lint         # biome check + per-package tsc --noEmit
bun run format       # biome check --write
bun run test         # bun test --coverage (all packages)
bun run check        # lint + test
bun run spur-check   # the canonical gate: lint + spur rule (recommended) + test + spur rule (coverage-gate)
bun run build        # build all packages to dist/
bun run bump-ver <x.y.z> [--push]   # lockstep version bump + release tags (release path — operator-run)
```

## Verification gate (all must pass before "done")

1. `bun run spur-check` clean — Biome, per-package typecheck, tests (coverage), and **both** spur rule
   presets (`recommended-pre-check` before tests + `recommended-post-check` after tests), all
   `--fail-on warning`.
2. `bun run build` succeeds for every package.
3. No test skipped/`.skip`'d/commented to go green. No `biome-ignore` added solely to silence the gate.
4. `git status` shows only intentional changes.

If a check fails, fix the root cause — never bypass with `--no-verify`, `--force`, or suppressions.

## Conventions & boundaries (enforced by ADRs + `.spur/rules/`)

- **Internal deps use `workspace:*`** — never a hand-written version range (ADR-002). The publish step
  resolves `workspace:*` → `^<version>` (ADR-003); the source tree always keeps `workspace:*`.
- **Cross-package imports also need `tsconfig` paths** so `tsc` resolves sibling packages to source
  (ADR-004). `dependencies` track direct package imports; `paths` track the broader transitive source
  closure, including sanctioned subpaths (ADR-012). Never drop a direct dependency in favour of only a
  path alias.
- **drizzle-orm is internal to `ts-db`** — no other package may import it (ADR-005, `db-boundaries` rule).
  Consume the main ts-db facade (`BaseDao`/`EntityDao` + predicate spec), not drizzle. Schema construction
  and `defineTable` belong behind `@gobing-ai/ts-db/schema` (ADR-007).
- **Architectural invariants are spur rules**, not just review habits — add new cross-cutting boundaries
  as rules under `.spur/rules/` (ADR-006).
- **Platform APIs are owned by `ts-runtime` by default** — no package may import `node:fs`, `node:path`,
  `node:os`, `node:child_process`, `Bun.spawn`, `Bun.which`, or `process.env` directly unless an ADR/rule
  explicitly sanctions a narrow adapter subpath (ADR-011 addendum, ADR-014). Use `@gobing-ai/ts-runtime`
  path utilities, canonical `FileSystem`, and `ProcessExecutor` instead.
- **`ts-infra` main barrel stays portable** — storage-backed queues, runtime-specific schedulers, and OTel
  exporters are opt-in subpaths such as `/job-queue-db`, `/scheduler-node`, `/scheduler-cloudflare`, and
  `/otel-node` (ADR-014).
- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `build:`, ...). Breaking changes in a
  `BREAKING CHANGE:` footer.
- Each package: source in `src/`, tests in `tests/`, builds to `dist/`. Tests live in `tests/`, not under `src/`.
- Never commit secrets or `.env*`. Never edit `.github/workflows/` (esp. the OIDC publish flow) without approval.
- Surgical changes only: touch what the task needs; no drive-by refactors or speculative abstractions.

## Releasing

Lockstep, automated, operator-initiated. `bun run bump-ver <version> --push` bumps all manifests,
tags, and pushes; GitHub Actions publishes via OIDC Trusted Publishing. Manual `npm publish` is
reserved for first-time package bootstrap. See `docs/PACKAGE_RELEASE.md`. Do not run `bun run release`
(intentionally disabled) or hand-edit internal dependency version ranges.
