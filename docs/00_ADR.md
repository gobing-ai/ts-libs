# 00 ADR — ts-libs

**Status:** Authoritative
**Last Updated:** 2026-06-02
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

---

## ADR-007: `defineTable` Is the Single Source of Truth — One Table → DDL + Zod

**Status:** Accepted · **Date:** 2026-06-01 · **Targets:** next `@gobing-ai/ts-db` (0.2.3)

**Context.** Today a persisted table is described in up to three places that drift independently: a
Drizzle table object (for DAOs/types), a hand-written `CREATE TABLE` DDL string (for migrations), and
a Zod schema (for boundary validation). Consumers feel this directly — e.g. spur's `packages/domain`
maintains Drizzle `schema/*.ts` objects **and** a hand-written `DOMAIN_SCHEMA_SQL`. Hand-written DDL
and `.sql` text-imports are also fragile: the `.sql` import broke the ts-libs build and is not
portable through `tsc` build → npm publish → consumer bundlers, so it was removed in favour of
inlined TS strings — which does not solve the drift, only the portability.

Separately, ADR-005's `defineTable` lives in the main barrel and statically imports `drizzle-zod`,
so the "optional" `drizzle-zod`/`zod` peers are loaded by *any* `@gobing-ai/ts-db` import — the
optionality is not actually honoured (every consumer must install `drizzle-zod`).

**Decision.** A Drizzle table object is the **single source of truth**; everything else is *derived*,
never re-authored:

1. **`defineTable(name, columns)` → `{ table, insertSchema, selectSchema, createTableSql }`.** The
   DDL is generated from the Drizzle table via `getTableConfig` (runtime, no drizzle-kit CLI) and
   covers columns, types, NOT NULL, defaults, PRIMARY KEY (incl. composite), UNIQUE, and FOREIGN KEYS.
   Zod schemas continue to come from `drizzle-zod`.
2. **No hand-written `CREATE TABLE` for tables that have a Drizzle definition.** Migrations compose
   the generated `createTableSql`. Raw DDL strings / `.sql` files are disallowed for such tables.
   (Hand-written SQL remains acceptable only for tables with no Drizzle object — and as inlined TS
   strings, never `.sql` text-imports in a published package.)
3. **Optionality made structural (fixes ADR-005's leak).** `defineTable` and its zod-deriving surface
   move to a subpath export `@gobing-ai/ts-db/schema`. The main barrel (`@gobing-ai/ts-db`) does not
   import `drizzle-zod`. Only consumers that import the subpath need the optional peers — verified by a
   build-time smoke import of the main barrel **without** `drizzle-zod` installed.

**Consequences.** One definition yields the DAO/type surface, the migration DDL, and the validation
schema — drift becomes impossible. This is a 0.2.3 release for `ts-db` (a `defineTable` return-shape
addition plus the `defineTable` subpath move). Downstream (spur `packages/domain`) replaces its
hand-written `DOMAIN_SCHEMA_SQL` with composed `createTableSql` and re-points `defineTable` imports to
the subpath. A spur rule (`no-hand-written-ddl-for-drizzle-tables`) enforces "no raw `CREATE TABLE`
beside a Drizzle table; derive it." `getTableConfig`-based generation is proven feasible at runtime
(columns/types/constraints/composite-PK/FK all extractable). Implementation is tracked as a task under
`docs/tasks/`.

---

## ADR-008: Runtime Selection Is the `getFs()` Global Swap, Not a `RuntimeFactory`

**Status:** Accepted · **Date:** 2026-06-02 · **Targets:** `@gobing-ai/ts-runtime`

**Context.** `ts-runtime` carried two parallel runtime-selection mechanisms that contradicted each
other. (1) The `setFileSystem`/`getFs()` global swap is load-bearing and tested: `RuntimeContext`,
`atomicWriteFile`, `walkDir`, and `schema-validation` all consume `getFs()`, and `CloudflareFileSystem`
plugs into it. (2) A `RuntimeFactory` interface (`createFileSystem`/`loadConfig`/optional
`createContext`) was declared as the portability seam but had **zero implementations** — no
`node-bun` factory, no `cloudflare-workers` factory — and was consumed by nothing. By the "two
adapters = real seam" test, the factory was a hypothetical seam; the global swap is the real one.
Keeping both forced every reader (and every AI agent) to guess which path is supported.

**Decision.** The `getFs()` global swap is the single runtime-selection seam. `RuntimeFactory` and the
optional `RuntimeContext.createContext` hook are removed, along with the unused `factory?` option on
`RuntimeContextOptions`. A Cloudflare Workers build is not imminent (YAGNI); when one lands, a factory
may be reintroduced **with two real adapters** (node-bun + workers) that `RuntimeContext` is built
from — not as an empty interface ahead of need.

**Consequences.** One obvious extension point: swap the active `FileSystem` via `setFileSystem`.
The config env accessors (`getNodeEnv`/`getProcessEnv`/`getDatabaseUrl`/`interpolateEnv`) reach
`process.env` directly and are documented as node-bun-only; on Workers, callers must inject config
rather than rely on `process`. Reintroducing a factory is a deliberate future ADR, not drift.

---

## ADR-009: `ts-infra` Telemetry Instruments Against the Global Provider; Export Is an Opt-In Subpath

**Status:** Accepted · **Date:** 2026-06-02 · **Targets:** `@gobing-ai/ts-infra`

**Context.** `ts-infra`'s telemetry both instrumented *and* half-owned a provider: `initTelemetry`
constructed a bare `NodeTracerProvider` (no exporter — so it exported nothing), and the main barrel
statically imported `@opentelemetry/sdk-trace-node` as a value. That made the SDK a *de-facto runtime
dependency of every consumer* the moment they enabled telemetry, even BYO-collector or browser/edge
consumers — and an exporter owned by a shared library forces one deployment-topology opinion (endpoint,
protocol, auth, batching) on all of them, plus an OTel-version lock-step. By the "library instruments,
app configures export" principle (and the same structural-optionality test as ADR-007), exporter
ownership is a consumer concern, not a library concern.

**Decision.** The core (`@gobing-ai/ts-infra`) **only instruments**: spans/metrics are recorded against
the globally-registered OTel provider via `trace.getTracer()` / `metrics.getMeter()`, degrading to
no-ops when none is registered. `initTelemetry` no longer constructs or registers any provider — it
resolves config and flips the enabled flag. Export is opt-in through a dedicated subpath,
`@gobing-ai/ts-infra/otel-node` (`initNodeTelemetry` / `shutdownNodeTelemetry`), which builds Node
OTLP/HTTP tracer + meter providers and registers them globally. The OTLP exporter packages
(`exporter-trace-otlp-http`, `exporter-metrics-otlp-http`, `resources`, `sdk-trace-node`,
`sdk-metrics`) are **optional peers** (`peerDependenciesMeta.optional`); the main barrel imports none
of them — proven by a shipped-artifact scan of `dist/index.js` and a static import-graph test. The OTel
SDK peers move to `^2.0.0` (the current line); `@opentelemetry/api` stays a required peer at `^1.9.0`.

**Consequences.** BYO and browser/edge consumers install nothing extra and hit no global-provider
conflict; Node consumers get turnkey OTLP with one `initNodeTelemetry` call. Library and consumer OTel
versions are decoupled — the app owns the exporter/collector matrix. A future Workers exporter is a new
subpath (`/otel-workers`), not a change to the core. Containment is enforced by
`tests/telemetry/optional-peers.test.ts`; a spur rule may later codify "no exporter import outside
`otel-*` subpaths."
