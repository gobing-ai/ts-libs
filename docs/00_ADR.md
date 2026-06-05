# 00 ADR — ts-libs

**Status:** Authoritative
**Last Updated:** 2026-06-04
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
immediately. Never remove a `dependency` in favour of only a path alias — paths do not affect runtime
or publish. The `paths` set and the `dependencies` set are **related but not identical** — see
**ADR-012**, which refines the "stay in sync" rule into the precise model (`dependencies` = direct
imports; `paths` = the full transitive source closure).

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
`spur rule run --preset recommended-pre-check` (static/structural rules before tests) + `bun test`
(coverage) + `spur rule run --preset recommended-post-check` (public export TSDoc and coverage gate
after tests), all `--fail-on warning`. Architectural invariants (drizzle containment, DB boundaries,
runtime/output/http boundaries) live as spur rules under `.spur/rules/` and must stay green.

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

## ADR-008: Runtime Selection Is the `getFs()` Global Swap, Not a `RuntimeFactory` — **SUPERSEDED by ADR-011**

**Status:** Superseded · **Date:** 2026-06-02 · **Superseded by:** ADR-011 · **Targets:** `@gobing-ai/ts-runtime`

**Context.** `ts-runtime` carried two parallel runtime-selection mechanisms. The `setFileSystem`/`getFs()`
global swap was load-bearing; a `RuntimeFactory` interface was declared but had zero implementations.
The decision was to keep the global swap and remove the unused factory.

**Supersession.** Task 0012 reintroduced the factory pattern with two real implementations
(`nodeBunFactory`, `cloudflareWorkersFactory`), a single `FileSystem` interface with union return types
(eliminating the `SyncFileSystem` split), a consolidated `ProcessExecutor` class, and expanded
runtime-portable path utilities. The `getFs()` global swap and `SyncFileSystem` are deprecated in
favor of `loadRuntimeFactory()` → `factory.createFileSystem()`. See ADR-011 for the full design.
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

---

## ADR-010: Shared Plugin Mechanism Lives in `ts-runtime`; Engine Concepts Stay Separate

**Status:** Accepted · **Date:** 2026-06-03 · **Targets:** `@gobing-ai/ts-runtime`, `@gobing-ai/ts-rule-engine`, `@gobing-ai/ts-dual-workflow-engine`

**Context.** `ts-rule-engine` and `ts-dual-workflow-engine` both need the same extensibility grammar:
a named, replace-by-key capability registry plus a trust-gated loader that imports arbitrary extension
modules only when explicitly allowed. The rule engine already has a mature version of this
(`CapabilityRegistry<T>` with `origin: 'builtin' | 'extension'` metadata; `loadExtensionsIntoHost`
with a fail-closed `allowExtensions !== true` gate, a `moduleLoader` test seam, a default/named-
`extension` export contract, and a relative-path/no-`..`-traversal guard). The workflow engine has the
weaker form — private `Map`s for actions/guards, no origin metadata, no extension loader — and task
0006 (R7/R8) is about to add exactly the loader the rule engine already has.

Two failure modes were on the table. (1) **Under-share:** let the workflow engine grow its own loader
independently — yields two trust gates, two `moduleLoader` seams, and two override behaviors to keep in
sync, with copy-pasted fail-closed security logic that will drift. (2) **Over-share:** unify the
*domain concepts* — define a common `Capability<TCtx, TResult>` supertype spanning evaluators, actions,
and guards, with a shared `EngineContext`. Inspection of the code shows this is a false commonality: a
`RuleEvaluator` is an idempotent *query* (`evaluate(rule, ctx) → {findings, fixes}`, `RuleContext =
{ workdir, rule }`), while an `ActionRunner` is an effectful *command* in a stateful run
(`execute(options, ctx) → ActionResult` with `terminal`, over `ActionRunContext = { runId,
stateOrNodeId, vars, env, ... }`). Their contexts overlap only in `workdir` (required vs optional).
Unifying them erases the command/query distinction and couples the rule engine to workflow run state
it never uses — the premature-abstraction trap (and what 0006 R9 / Non-Goals already forbid).

**Decision.** Share the **mechanism**, not the **concepts** (Option A from the 0006 brainstorm).

1. **Shared core location: `@gobing-ai/ts-runtime`, exported from the subpath `@gobing-ai/ts-runtime/plugin`.**
   Not a new `packages/plugin-core`. Both engines already depend on `ts-runtime`, the primitives are
   generic runtime infrastructure, and a new package adds path aliases, release metadata, OIDC publish
   surface, and docs for a ~150-line API (YAGNI, same posture as ADR-008). A dedicated package is a
   deliberate **future** ADR, triggered only by a third consumer or real plugin-lifecycle features —
   not by this task.

2. **The shared core is domain-agnostic.** It exposes generic primitives only and must never import
   either engine or know any engine vocabulary (`evaluator`/`resolver`/`fixer`/`formatter` or
   `action`/`guard`/`driver`):
   - `CapabilityRegistry<T>` — `register(name, capability, origin?)`, `has`, `get`, `list`, plus
     `getEntry`/`entries` so `origin: 'builtin' | 'extension'` is inspectable (workflow introspection
     and rule-engine diagnostics both need it).
   - generic `ExtensionRef<TKind>`, `LoadExtensionsOptions` (`allowExtensions?`, `logger?`,
     `moduleLoader?`), and a generic loader that imports + validates the default/named-`extension`
     export, then invokes an **engine-provided registration callback** — the loader never decides which
     registry receives a module.
   - `assertRelativeExtensionPath()` extracted as a **standalone validator function** (not a zod
     schema), so the loader enforces the no-absolute-path / no-`..`-traversal guard at load time even
     if an engine forgets it in its own schema (defense in depth: validate at schema time *and* load
     time).

3. **Domain stays in each engine.** Each engine owns its `ExtensionKind` enum, its `extensions` zod
   schema (composed from the shared path validator), its kind→registry mapping, and its override
   *semantics* and warning strings — only the engine knows whether replacing a capability is meaningful.

4. **Error types are engine-owned (the boundary 0006's API sketch glossed over).** The shared
   `CapabilityRegistry.get` stays generic; the workflow host preserves `WorkflowValidationError` for
   unknown action/guard kinds by doing `has()`-then-throw-own-error at its boundary rather than pushing
   error types into the core. The rule engine keeps its existing generic `Error` message. The shared
   core never imports an engine's error class.

5. **Trust gate is verbatim and fail-closed.** The single most important invariant carried over: when
   refs exist but `allowExtensions !== true`, the loader throws **before any `import()`**. A test must
   assert the injected `moduleLoader` is never called when the gate is closed. No silent drop of
   declared extensions; no dynamic import before the gate passes.

6. **Migration order, no behavior drift.** rule-engine migrates first onto the shared registry/loader
   with its public host shape, error messages, override warnings, schema semantics, and tests
   unchanged (re-export `CapabilityRegistry` from the old path for one release if it is currently public
   surface). Workflow migrates its action/guard maps to the shared registry next (built-ins register
   `origin: 'builtin'`), then gains trust-gated `actions`/`guards` extension loading via the shared
   loader. Dependencies + tsconfig path aliases stay in sync per ADR-002 / ADR-004.

7. **Explicitly deferred (design-only, no implementation in 0006).** A workflow **driver registry**
   abstracting `state-machine` vs `transition-flow` is *not* built; `WorkflowService` keeps explicit
   dispatch until a third dialect or a real override use case appears. The shell-action trust model is a
   separate security task. The workflow variable/template engine stays workflow-local — it is not a
   shared util.

**Consequences.** The genuinely duplicated, security-critical mechanism (registry + fail-closed loader
+ path guard + origin metadata) is defined and audited **once** in `ts-runtime/plugin`; the workflow
engine gets origin metadata, introspection, and a trust-gated loader without re-deriving the trust
gate. The shared core stays a small generic primitive because all domain knowledge — kinds, schemas,
contexts, error types, override semantics — is held by the engines, structurally preventing the core
from accreting engine specifics. This is an additive change to `ts-runtime` (new subpath) plus internal
migrations in both engines with no caller-visible behavior change. A spur rule may later codify "the
shared plugin core must not import either engine." Promoting the core to a dedicated `packages/plugin-core`,
building a driver registry, or sharing the template engine are each future ADRs gated on real pressure,
not drift. Implementation is tracked as task 0006 under `docs/tasks/`.


---

## ADR-011: Runtime Factory Pattern + Path Utility Consolidation + Runtime Boundary Rules

**Status:** Accepted · **Date:** 2026-06-04 · **Targets:** `@gobing-ai/ts-runtime`, `.spur/rules/`

**Context.** ADR-008 kept the `getFs()` global swap and removed the unused `RuntimeFactory`. However,
inspection of the original `spur-old` codebase revealed a more cohesive design: the old project had a
working `loadRuntimeFactory()` with two real implementations (`nodeBunFactory`, `cloudflareWorkersFactory`),
a single `FileSystem` interface with union return types, and a `ProcessExecutor` class wrapping `execa`.
The migration inadvertently fragmented these into split interfaces (`FileSystem` + `SyncFileSystem`,
`ProcessExecutor` + `SyncProcessExecutor` + `PipeProcessSpawner`) and lost the factory auto-detection.

Separately, 16 source files across 6 packages imported `node:path` directly, and `node:os` and
`Bun.which()` were used outside the runtime package. These are platform-specific APIs that should be
behind the `ts-runtime` seam per the package's design contract.

**Decision.**

1. **Reintroduce the factory pattern with two real implementations.** `loadRuntimeFactory()` detects the
   platform via `isCloudflareWorkerRuntime()` and returns `nodeBunFactory` or `cloudflareWorkersFactory`.
   Each factory provides `createFileSystem()`, `createProcessExecutor()`, and `loadConfig()`.
   `createRuntimeContextFromFactory()` is the async entry point that auto-wires everything.

2. **Replace split FileSystem interfaces with a single interface using union return types.**
   `FileSystem.readFile()` returns `string | Promise<string>` — sync implementations (Node/Bun) return
   strings directly, stubs (Workers) throw. `SyncFileSystem` is marked `@deprecated`. The new entry
   points are `createNodeFileSystem(root?)` and `createCfFileSystem()`.

3. **Consolidate process execution into a single `ProcessExecutor` class.** `run()` wraps `execa` for
   buffered execution; `runStreaming()` wraps `Bun.spawn` for interactive subprocesses. `SyncProcessExecutor`,
   `PipeProcessSpawner`, and the interface/impl split are removed (old classes kept as `@deprecated` shims).

4. **Expand runtime-portable path utilities.** `basenamePath`, `dirnamePath` (already present), `SEP`,
   and `relativePath` added to `packages/runtime/src/path.ts`. All use zero `node:*` imports, making them
   safe for Cloudflare Workers. This enabled migrating all 16 `node:path` exemptions to `ts-runtime` utilities.

5. **Consolidate runtime boundary rules into `.spur/rules/typescript/runtime-boundaries.yaml`.**
   New strict rules added: `no-direct-node-path`, `no-direct-node-url`, `no-direct-node-os`,
   `no-direct-bun-platform`, `no-direct-process-exit`. These enforce that all platform-specific APIs
   (`node:fs`, `node:path`, `node:os`, `node:child_process`, `Bun.spawn`, `Bun.which`, `process.exit`,
   `process.env`) are only imported within `packages/runtime/src/` (or explicitly sanctioned files).
   `no-direct-node-path` has zero source-code exemptions outside `packages/runtime/src/`.

**Consequences.** The factory pattern provides a single, testable entry point for platform detection.
The union-return-type `FileSystem` eliminates the sync/async dual-interface complexity.
`ProcessExecutor` as a class simplifies the three-interface/three-implementation matrix.
Runtime boundary rules are checked at the gate (`spur-check`), structurally preventing new
platform-specific imports from leaking outside `ts-runtime`. The `getFs()` global swap and old
classes are deprecated but preserved for backward compatibility.

Implementation is tracked as tasks 0012 (factory + FileSystem + ProcessExecutor) and 0013 (path
utility consolidation + exemption elimination) under `docs/tasks/`.

---

## ADR-012: `dependencies` Track Direct Imports; `paths` Track the Transitive Source Closure

**Status:** Accepted · **Date:** 2026-06-04 · **Targets:** every `@gobing-ai/ts-*` package · **Refines:** ADR-002, ADR-004

**Context.** ADR-004's Consequences said the `compilerOptions.paths` set "must stay in sync with the
declared dependencies." Read literally that implies `paths == dependencies`, and that reading caused a
real drift in three packages: `ts-rule-engine` declared `ts-db` and `ts-utils` as `dependencies` but
imported neither; `ts-ai-runner` and `ts-dual-workflow-engine` each declared `ts-utils` but never
imported it. The drift has two distinct costs — (1) consumers install transitive packages (and their
trees, e.g. `ts-db` → `drizzle-orm`) for code that never runs; (2) nothing flags a `dependency` that no
source line actually needs, the same blind spot ADR-002 was written to kill, just in the other
direction (present-but-unused rather than stale-range).

The root cause is that the two sets answer **different questions**, because ADR-004 resolves cross-package
imports to **source**, not built `.d.ts`:

- A package's `dependencies` answer *"what must a consumer install for this package to run?"* — that is
  exactly its **direct** `@gobing-ai/ts-*` imports. Transitive packages arrive automatically through the
  direct dependency's own manifest (npm resolves the tree); re-declaring them is redundant and wrong.
- A package's `tsconfig` `paths` answer *"what must `tsc` alias to typecheck this package against live
  source?"* — that is the **full transitive source closure**: every `@gobing-ai/ts-*` module reachable
  from this package's imports, *including* ones pulled in only via a dependency's source. Example:
  `ts-rule-engine` imports `ts-ai-runner` (which imports `ts-db/inbox`) and `ts-runtime` (which imports
  `ts-utils`), so its `paths` need `ts-db/inbox` and `ts-utils` aliases even though neither is a direct
  dependency.

These sets overlap (every direct dependency is also in the source closure) but are not equal.

**Decision.**

1. **`dependencies` = the package's direct `@gobing-ai/ts-*` imports — nothing more.** A declared internal
   dependency that no `src/**` line imports is removed. Subpath imports (e.g. `ts-db/inbox`) are satisfied
   by the bare package dependency (`ts-db`); declare the bare package, not the subpath.

2. **`tsconfig` `paths` = the transitive source closure required for `tsc`.** Aliases for transitively-
   reached modules are kept even when the module is not a direct dependency. A `paths` entry that resolves
   nothing in the closure is removed (e.g. `ts-runtime/bun-sqlite` where no reachable source imports it).

3. **ADR-004's "stay in sync" is restated as the directional rule it always meant:** never drop a *direct*
   dependency in favour of only a path alias (paths do not affect runtime or publish). It does **not** mean
   the two sets are identical.

**Consequences.** Published manifests stop forcing consumers to install unused internal packages and their
trees (notably `ts-rule-engine` no longer drags `ts-db`/`drizzle-orm`). `dependencies` becomes a truthful
statement of what a package directly needs, restoring the ADR-002 guarantee in both directions. `tsconfig`
`paths` remain the broader transitive set and are validated by each package's `tsc --noEmit` (a missing
alias fails the type gate immediately). A future spur rule may codify "no declared `@gobing-ai/ts-*`
dependency is unused in `src/**`" to enforce direction (1) at the gate rather than by review. Applied to
`ts-rule-engine`, `ts-ai-runner`, and `ts-dual-workflow-engine` in this change.


---

## ADR-013: Workflow Run Lifecycle Is a Deep Module Built on `ts-infra` Observability

**Status:** Accepted · **Date:** 2026-06-04 · **Targets:** `@gobing-ai/ts-dual-workflow-engine`

**Context.** The two workflow drivers (`StateMachineDriver`, `TransitionFlowDriver`) each carried a
verbatim copy of the run-level bookkeeping: run identity (`runId`/`startedAt`), the
`createRun → saveWorkflowState → savePhase → saveTransition → finalizeRun` persistence sequence, and the
`done`/`fail`/`runRecord`/`allowedEnv`/`runtimeBuiltins` helpers (~90 duplicated lines). The two copies had
to stay byte-identical with nothing enforcing it — a latent drift bug. Separately, the engine emitted **no
observability at all**: it executed shell actions, took transitions, and finalized runs silently, while the
workspace already ships `ts-infra` (`getLogger`, OTel `traceAsync`/`addSpanEvent`). A workflow engine that
cannot be observed in production is not robust. ADR-006 §7 deferred a **driver registry abstracting the two
dialects' dispatch** "until a third dialect or a real override use case appears"; that deferral was being
read more broadly than intended — as if the drivers' shared *bookkeeping* must also stay duplicated.

**Decision.**

1. **Run lifecycle is one deep module** (`src/run-lifecycle.ts`, `RunLifecycle`). It owns run identity, the
   persistence sequence, and observability behind a small interface (`begin`-via-`RunLifecycle.run`,
   `enter`, `recordTransition`, `done`, `fail`). Both drivers keep their **distinct dialect control loops**
   and call into this for every persistence touch. `WorkflowService` keeps explicit dispatch.

2. **ADR-006 §7 is clarified, not reversed.** The still-deferred item is a *driver registry that abstracts
   `state-machine` vs `transition-flow` dispatch*. Consolidating the drivers' shared run-lifecycle
   bookkeeping is **not** that abstraction and is explicitly permitted — the two control loops remain
   separate and dialect-specific.

3. **The engine consumes `ts-infra` for observability** (`dual-workflow-engine → ts-infra`, a direct
   dependency per ADR-012; no cycle — `ts-infra` depends only on `ts-db`). `RunLifecycle` logs run
   start/enter/transition/done/fail via a `child`-bound `getLogger('workflow')` (injectable) and wraps each
   run in a `workflow.run` OTel span with per-step span events. Telemetry instruments against the global
   provider (ADR-009): zero-config and no-op until a consumer initializes a provider.

4. **Runtime builtin namespaces are single-sourced.** `RUNTIME_BUILTIN_KEYS` in `run-lifecycle.ts` is the
   one definition consumed by both the resolver (`runtimeBuiltins`) and the config validator
   (`RUNTIME_TEMPLATE_NAMESPACES`), so a reference the runtime would resolve can never be rejected by
   validation, or vice-versa.

**Consequences.** The "two files must never drift" invariant is gone — run bookkeeping changes once, in one
place, tested once through the real `WorkflowPersistenceAdapter` interface. The engine is observable by
default (structured logs) and traceable on demand (OTel spans) without forcing a telemetry provider on
consumers. The drivers shrink to their actual algorithms. A future driver registry (ADR-006 §7) remains
deferred and is now unambiguously scoped to *dispatch abstraction*, not lifecycle sharing. A future ADR
would be required to make the workflow variable/template engine a shared util (ADR-006 §7 keeps it
workflow-local).

---
### ADR-013 Addendum — Error Policy Alignment (2026-06-04)

**Context.** Task 0014 aligned the error-handling vocabulary and configuration pattern across the two
sibling engines while preserving their intrinsic behavioral differences. The rule engine's exhaustive
traversal (`for`-loop over all rules) gained an opt-in `stopOnFirst?: 'error' | 'warning' | 'info'`
parameter; the workflow engine gained a per-action, per-workflow, and per-run `onError?: 'fail' |
'continue'` policy with resolved precedence `action.onError ?? workflow.defaultOnError ?? runOptions.onError
?? 'fail'`.

**Decision.** Align the shared *vocabulary* (severity enum + config-default→runtime-override pattern) while
keeping the *policy verb* honestly different between the engines:

- **rule-engine** uses `stopOnFirst` (traversal control). Undefined default → exhaustive (today's behavior);
  when set, breaks the rule loop after the first finding matching or exceeding the threshold.
- **workflow-engine** uses `onError` (control-flow branching). Default `'fail'` → fail-fast (today's
  behavior); `'continue'` → log a non-fatal warning via the `RunLifecycle` observability seam (ADR-013
  §3) and continue to the next state/node/action.

No shared code was introduced between the two engines — the policy is resolved per-package, per-driver.
The rule engine's verdict (exit code) remains in the consumer (spur `rule-service.ts`); the engine only
controls traversal, never pass/fail.

**Consequences.** Both packages remain releasable in one lockstep bump for spur-new#0017. The workflow
engine now supports resilient workflows where non-fatal action failures log and continue. The rule engine
supports early exit for noisy linter runs. Policy verbs stay distinct and honest.

---
### ADR-013 Addendum — Engine EventBus Observability Layer (2026-06-04)

**Context.** ADR-013 added workflow logs and traces, but neither `ts-dual-workflow-engine` nor
`ts-rule-engine` exposed a programmatic in-process subscription layer. Downstream consumers that need
progress events (IDE integrations, CI dashboards, spur progress bars) should not scrape logs or require an
OTel collector. The workspace already ships a typed `EventBus` in `ts-infra`.

**Decision.** Engine observability has three distinct layers:

- **Logs** (`getLogger`) are for human/file debugging.
- **Traces** (`traceAsync`/`addSpanEvent`) are for distributed performance correlation.
- **Events** (`EventBus`) are for in-process programmatic subscribers.

`EventBus` is additive; it does not replace existing logs or traces. Each engine owns its local event map:
`RuleEngineEvents` in `ts-rule-engine` and `WorkflowEngineEvents` in `ts-dual-workflow-engine`. They share
only the injection shape (`options.events?: EventBus<...>`), not a common event-map module. Rule-engine
events are prefixed `rule.` and workflow-engine events are prefixed `workflow.` so one consumer can attach
both engines to one bus without name collisions. Workflow span event names and workflow EventBus names use
the same `workflow.*` vocabulary.

**Consequences.** The rule engine gains a direct `ts-infra` dependency for logging/tracing/events, matching
the workflow engine dependency introduced by ADR-013. Both engines remain decoupled at the type-map level,
but consumers get symmetric subscription semantics. Omitting `events` keeps the default path unchanged:
logs and traces still work, and no event bus handler dispatch is introduced.
