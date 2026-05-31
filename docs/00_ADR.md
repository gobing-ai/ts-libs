# 00 ADR — ts-libs

**Status:** Authoritative
**Last Updated:** 2026-05-31
**Owner:** Robin Min

Single source of truth for the architecture & release decisions that define this monorepo. Each
entry carries Context, Decision, and Consequences. When another document or a code change conflicts
with an entry here, this file wins — surface the conflict and resolve it. New cross-cutting decisions
are appended as `ADR-NNN`.

---

## ADR-001: Bun-Workspace Monorepo of Independently Published Packages

**Status:** Accepted · **Date:** 2026-05-31

**Context.** `@gobing-ai/ts-*` are small, co-evolving TypeScript libraries (utils, runtime, db,
infra, ai-runner, rule-engine, dual-workflow-engine, llm-jsonl-importer) consumed by each other and
by external projects (e.g. spur).

**Decision.** One Bun workspace (`"workspaces": ["packages/*"]`). Each package is independently
published to npm but **versioned in lockstep** (every release bumps all manifests to the same
version). Bun is the runtime, package manager, and test runner; Biome is lint/format; per-package
`tsc` is the type gate.

**Consequences.** Local development resolves siblings automatically via the workspace. Adding a
package needs no script edits (discovery is glob-driven from the root manifest). A single version
number describes a cohesive release across all packages.

---

## ADR-002: Internal Dependencies Use the `workspace:*` Protocol

**Status:** Accepted · **Date:** 2026-05-31

**Context.** Internal `@gobing-ai/ts-*` dependencies were pinned to hand-maintained semver ranges
(`^0.1.8`, etc.). `bump-ver` rewrites each package's `version` field but **not** its dependency
ranges, so the ranges drifted out of sync with the actual versions — and a breaking bump (ts-db
0.1.x → 0.2.0) silently left consumers pointing at a range that excluded the new version.

**Decision.** Every internal `@gobing-ai/ts-*` dependency declares `"workspace:*"` — never a
hand-written version range. Bun resolves these locally during development; the published range is
produced at publish time (ADR-003).

**Consequences.** Internal dependency ranges are never hand-edited again, and version drift is
structurally impossible. `bump-ver` only touches the `version` field. **No internal dep may use a
literal version range.**

---

## ADR-003: Resolve `workspace:*` to a Caret Range at Publish Time

**Status:** Accepted · **Date:** 2026-05-31

**Context.** Releases publish via **`npm publish`** (GitHub Actions, npm **Trusted Publishing** /
OIDC — see `docs/PACKAGE_RELEASE.md`). This per-package `npm publish` flow does **not** substitute
the `workspace:` protocol — verified by `npm pack`, it ships the literal `"workspace:*"` string,
which is unresolvable on the registry and breaks the package. Switching to `bun publish` would
forfeit OIDC Trusted Publishing and is rejected.

**Decision.** The publish step (`scripts/lib/release-commands.ts`, backed by
`scripts/lib/workspace-deps.ts`) rewrites each `workspace:*` dependency to `^<sibling-version>`
in the on-disk manifest immediately before `npm publish`, then restores the manifest. It is
**fail-closed**: if any `workspace:` range survives substitution, the publish is refused rather than
shipping a broken manifest.

**Consequences.** Published packages carry correct caret ranges (`^0.2.0`) while the source tree
keeps `workspace:*`. The substitution is a load-bearing invariant of the release pipeline, covered by
unit tests (`scripts/tests/workspace-deps.test.ts`) and proven end-to-end against `npm pack`. Any
change to the publish flow must preserve substitution + the fail-closed guard.

---

## ADR-004: TypeScript Path Aliases Resolve Cross-Package Imports to Source

**Status:** Accepted · **Date:** 2026-05-31

**Context.** A package's type gate (`tsc`) could resolve a sibling import via `node_modules` (the
built `dist/.d.ts`), which lags behind source — so cross-package breakage surfaces late.

**Decision.** Every package that imports a sibling declares a `compilerOptions.paths` entry mapping
`@gobing-ai/ts-<pkg>` → `../<pkg>/src/index`. This is **complementary to** the `workspace:*`
dependency (which governs runtime + publish), not a replacement for it.

**Consequences.** `tsc` typechecks against live sibling **source**, catching cross-package breakage
immediately. The `paths` entries must stay in sync with the declared dependencies; never remove a
`dependency` in favour of only a path alias — paths do not affect runtime or publish.

---

## ADR-005: `@gobing-ai/ts-db` Is a Drizzle-Free Facade

**Status:** Accepted · **Date:** 2026-05-31

**Context.** `ts-db` wraps drizzle-orm. Earlier it leaked drizzle through a lossy `DbClient`
interface (and `as unknown as` casts), and raw SQL escaped the DAO abstraction — so consumers were
coupled to drizzle and the storage engine was not swappable.

**Decision.** `ts-db` (v0.2.0) is a **complete facade**: drizzle is an internal implementation detail
that never appears in consumer code. Public surface = `createDbAdapter` + `BaseDao` (raw tier:
`query`/`one`/`tx` over a small predicate spec) + `EntityDao` (structured CRUD) + `defineTable`
(single source of truth → table + derived zod schemas). No `@gobing-ai/ts-*` package other than
`ts-db` may import `drizzle-orm` — enforced by the `db-boundaries` spur rule
(`no-drizzle-import-outside-db-package`).

**Consequences.** Consumers depend only on the ts-db vocabulary; the storage engine is swappable
without touching call sites. `drizzle-zod` + `zod` are **optional** peers (only needed for
`defineTable` validation). Schema construction lives in `packages/db/src/schema/` or via `defineTable`
(the sanctioned primitives).

---

## ADR-006: Quality Gates Are Enforced, Not Advisory

**Status:** Accepted · **Date:** 2026-05-31

**Context.** Consistency across packages erodes without an enforced gate.

**Decision.** `bun run spur-check` is the canonical gate: Biome + per-package `tsc` typecheck +
`bun test` (coverage) + `spur rule run` (the `recommended` and `spur-dev` presets, `--fail-on
warning`). Architectural invariants (drizzle containment, DB boundaries, runtime/output/http
boundaries) live as spur rules under `.spur/rules/` and must stay green.

**Consequences.** A change that violates a boundary fails the gate, turning architecture into a
checked guarantee. New cross-cutting invariants are added as spur rules, not just review habits.
