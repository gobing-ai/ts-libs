# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md` and `GEMINI.md` symlink here.

## Project

`@gobing-ai/ts-libs` — a **Bun-workspace monorepo** of small, independently published, lockstep-versioned
TypeScript libraries under `packages/*`:

| Package | Role |
|---------|------|
| `ts-utils` | output, errors, api-response, cursor, date, access helpers |
| `ts-runtime` | runtime context, FileSystem, ProcessExecutor, config loader |
| `ts-db` | drizzle-free DB facade: adapters, `BaseDao`/`EntityDao`, predicate spec, `defineTable` |
| `ts-infra` | logger, EventBus, telemetry, scheduler, job-queue, API client |
| `ts-ai-runner` | coding-agent detection, doctor, prompt execution |
| `ts-rule-engine` | constraint rule schemas, loading, evaluation, formatting |
| `ts-dual-workflow-engine` | state-machine + transition-flow workflow runtime |
| `ts-llm-jsonl-importer` | generic JSONL importer for LLM history files |

- **Runtime / package manager / test runner:** Bun `1.3.14`. Prefer `bun:*` APIs over `node:*`.
- **Lint + format:** Biome. **Type gate:** per-package `tsc --noEmit`. No ESLint, no Prettier.
- **Hooks:** Lefthook. **Rule gate:** `spur` (global binary) against `.spur/rules/`.

Never introduce a new runtime, package manager, linter, or formatter.

## Key files (binding)

| File | What it governs |
|------|-----------------|
| `docs/00_ADR.md` | **Authoritative** architecture & release decisions. Read before any non-trivial change to the workspace graph, dependency strategy, the release/publish flow, the ts-db facade, or cross-package boundaries. A change that contradicts an ADR requires updating the ADR first (new dated entry). |
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
- **Cross-package imports also need a `tsconfig` path** mapping `@gobing-ai/ts-<pkg>` → `../<pkg>/src/index`
  so `tsc` resolves to source (ADR-004). Keep deps and path aliases in sync; never drop a dep for a path alias.
- **drizzle-orm is internal to `ts-db`** — no other package may import it (ADR-005, `db-boundaries` rule).
  Consume the ts-db facade (`BaseDao`/`EntityDao` + predicate spec), not drizzle.
- **Architectural invariants are spur rules**, not just review habits — add new cross-cutting boundaries
  as rules under `.spur/rules/` (ADR-006).
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
