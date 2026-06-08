# 00 ADR — ts-libs

**Status:** Authoritative
**Last Updated:** 2026-06-05
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
`query`/`one`/`tx` over a small predicate spec) + `EntityDao` (structured CRUD). Schema helpers such as
`defineTable` live behind `@gobing-ai/ts-db/schema` per ADR-007. No `@gobing-ai/ts-*` package other than
`ts-db` may import `drizzle-orm` — enforced by the `db-boundaries` spur rule
(`no-drizzle-import-outside-db-package`).

**Consequences.** Consumers depend only on the ts-db vocabulary; the storage engine is swappable
without touching call sites. `drizzle-zod` + `zod` are **optional** peers (only needed for
`@gobing-ai/ts-db/schema`). Schema construction lives in `packages/db/src/schema/` or through the
`@gobing-ai/ts-db/schema` subpath (the sanctioned primitive surface).

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

**Status:** Accepted · **Date:** 2026-06-01 · **Targets:** `@gobing-ai/ts-db/schema`

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

### ADR-009 Addendum — Global Provider Default, Injectable Telemetry Ports Allowed (2026-06-05)

**Context.** The global-provider default is correct for normal OTel usage, but `ts-infra` is becoming the
foundation for long-lived runtime services, schedulers, queues, and event pipelines. Some robust infra use
cases need isolation from process-global telemetry state: deterministic tests, embedded runtimes, multi-app
hosts, and consumers that want to connect `ts-infra` instrumentation to a custom collector or in-memory
probe without mutating the global OTel provider.

**Decision.** ADR-009's rule is refined, not reversed:

- The default `ts-infra` telemetry path still instruments through the globally registered OTel provider and
  degrades to no-op when no provider is registered.
- Core instrumentation helpers may also accept **optional structural telemetry ports** (`TracerPort`,
  `MeterPort`, or narrower operation-specific ports) for isolated/embedded scenarios.
- Exporter ownership remains outside the core. A structural port may be backed by OTel, tests, a runtime
  adapter, or a consuming application's telemetry layer, but core `@gobing-ai/ts-infra` must not construct
  exporters.
- Node/Workers/exporter-specific implementations still live behind opt-in subpaths (`/otel-node`,
  future `/otel-workers`, etc.) per ADR-014.

**Consequences.** The global provider remains the ergonomic default, while advanced consumers are not forced
through a singleton. Tests can assert spans/metrics without global mutation. `ts-infra` can support robust
embedded and multi-tenant scenarios without taking ownership of exporter topology.

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

1. **Shared core location: `@gobing-ai/ts-runtime`, exported from the subpath `@gobing-ai/ts-runtime/extension`.**
   *(Subpath originally `@gobing-ai/ts-runtime/plugin`; renamed to `/extension` on 2026-06-08 — see the
   dated entry below — to disambiguate from the unrelated application-lifecycle `PluginHost` added to
   `ts-infra` in task 0025.)*
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
+ path guard + origin metadata) is defined and audited **once** in `ts-runtime/extension`; the workflow
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

### ADR-011 Addendum — Canonical Runtime Surface and Standard Context Services (2026-06-05)

**Context.** ADR-011 correctly chose the factory pattern and a single union-return `FileSystem`, but the
transition left a public-surface ambiguity: `packages/runtime/src/file-system.ts` defines the canonical
runtime-agnostic `FileSystem`, while the legacy `fs.ts` module still defines a deprecated `FileSystem`
with the old async-only method names. Because both names collide, the root barrel currently exports the
deprecated type and comments out the canonical export. That makes the compatibility layer look like the
steady-state API. Separately, `createRuntimeContextFromFactory()` is documented as auto-wiring runtime
services, but today only guarantees `config` and `fileSystem`; `ProcessExecutor` remains a factory method
rather than a standard context service.

**Decision.** ADR-011 is refined with a canonical runtime surface:

- The canonical root-exported `FileSystem` is the union-return interface from `file-system.ts`.
- `fs.ts` remains a compatibility module only. Its `getFs()`/`setFileSystem()`, `NodeFileSystem`,
  `NodeSyncFileSystem`, `CloudflareFileSystem`, old `FileSystem`, and `SyncFileSystem` surfaces may stay
  temporarily for source compatibility, but they must not own the root-barrel `FileSystem` name long-term.
- Any helper still backed by the legacy global swap (`readJsonFile`, `writeJsonFile`, `walkDir`,
  `atomicWriteFile`, etc.) should either accept the canonical `FileSystem` shape or move behind clearly
  named compatibility exports. New code must prefer `createRuntimeContextFromFactory()` or
  `RuntimeFactory.createFileSystem()` over `getFs()`.
- `RuntimeContext`'s standard services are `config`, `fileSystem`, and, when
  `capabilities.hasProcessExecution === true`, `processExecutor`.
- Runtimes without process execution (currently Cloudflare Workers) expose that absence through
  `capabilities.hasProcessExecution === false` and do not register a misleading process executor service.
  Callers that need processes must branch on capabilities or use `RuntimeFactory.createProcessExecutor()`
  and handle its runtime-specific unavailability.

**Consequences.** The root barrel becomes a reliable guide to the modern runtime API instead of a mix of
old and new file-system seams. `RuntimeContext` becomes the normal dependency-injection entry point for
both filesystem and process execution, reducing repeated factory plumbing in consumers. The compatibility
layer can be migrated package-by-package without a breaking removal, but future runtime work should deepen
the canonical surface rather than adding behavior to `fs.ts`.

### ADR-011 Addendum — Runtime Boundary Is Default Ownership, Not an Adapter Ban (2026-06-05)

**Context.** The strict runtime-boundary rules correctly prevent platform APIs from leaking randomly across
packages. However, `ts-infra` now owns infrastructure adapters: schedulers, queue/file observers, health
pings, telemetry exporters, and other operational integrations. Treating ADR-011 as "only `ts-runtime` may
ever contain platform behavior" would force awkward injected seams for every infra adapter or push
infrastructure concerns down into `ts-runtime`, which would couple runtime primitives to higher-level
observability and operations concepts.

**Decision.** Runtime ownership is the default, not an absolute ban on infra adapters:

- `ts-runtime` remains the default owner of raw platform primitives: filesystem, process execution,
  platform detection, path utilities, config loading, and direct `node:*` / `Bun.*` usage.
- `@gobing-ai/ts-infra` **core** must stay platform-neutral and must not import raw platform APIs.
- Platform-specific infra implementations are allowed only as **opt-in adapter subpaths** (for example
  `/otel-node`, future `/scheduler-node`, `/file-observer-runtime`, `/health-node`, `/otel-workers`) and
  must not be statically imported by the main barrel.
- Where an adapter needs raw platform primitives, prefer composing with `@gobing-ai/ts-runtime` first. Raw
  platform imports inside a narrowly scoped adapter subpath require an explicit ADR/rule exemption and a
  test proving the main barrel remains clean.
- `.spur/rules/` should distinguish core source from sanctioned adapter subpaths instead of weakening the
  boundary globally.

**Consequences.** The monorepo keeps platform discipline without blocking first-party, production-grade
infra adapters. The main `@gobing-ai/ts-infra` import remains portable and lightweight; consumers opt into
runtime-specific behavior explicitly through subpaths. Future code changes should migrate heavy or
platform/storage-backed implementations toward the ADR-014 boundary rather than adding more surface to the
main barrel.

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

---
### ADR-013 Addendum — Observability Layering: Injected EventBus vs Structural Port (2026-06-04)

**Context.** The prior addendum assumes a package can import `EventBus` from `ts-infra`. Code at or below
`ts-infra` in the graph (`ts-utils → ts-runtime → ts-db → ts-infra`) cannot: importing `EventBus` forms a
cycle (`ts-runtime → ts-infra → ts-db → ts-runtime`), and `EventBus` is heavyweight (`Logger`, `JobQueue`,
telemetry metrics), so relocating it down is rejected. Task 0017 surfaced this: `ts-runtime`'s
`ProcessExecutor` must emit `process.*` lifecycle events but cannot reach `ts-infra`.

**Decision.** Two observability patterns, selected by dependency layer:

- **Above `ts-infra`** — inject `EventBus<XEvents>` directly, plus `getLogger()` / `traceAsync()`; own a
  typed event map in-package. (rule-engine, dual-workflow-engine, ai-runner consumer layer.)
- **At or below `ts-infra`** — emit through zero-dependency **structural ports** declared locally
  (`ProcessEventSink`, `TracerPort`); a higher layer injects the concrete `EventBus`/`traceAsync` adapter.
  (`ts-runtime` `ProcessExecutor` — the only current case.)

**Selection rule.** Can the package import `EventBus` from `ts-infra` without a cycle? Yes → inject
directly. No → structural port.

**Consequences.** Event ownership stays at the layer that owns the behavior (`process.*` with the executor,
`agent.*` with ai-runner). No cycles. Default ports are no-ops — existing callers unaffected. Span event
names and `EventBus` names share dotted prefixes (`process.`, `agent.`) to keep traces and subscribers
aligned. Additive: logs and traces work without a bus. A spur rule may enforce this (ADR-006): `ts-infra`
dependents emitting lifecycle behavior accept `events?: EventBus<...>`; runtime-layer emitters use a port,
never import `ts-infra`.

---

## ADR-014: `ts-infra` Core/Adapter Boundary

**Status:** Accepted · **Date:** 2026-06-05 · **Targets:** `@gobing-ai/ts-infra`

**Context.** `ts-infra` is intended to be the shared infrastructure foundation: logging, eventing,
telemetry instrumentation, schedulers, queues, API client behavior, and operational observers. After the
post-migration review, its functionality is broader and more useful, but the package structure now risks
turning the main barrel into a heavy "everything import":

- `EventBus` is portable and useful as core infrastructure.
- `Logger` and telemetry helpers are portable if they only instrument and accept injected/configured sinks.
- DB-backed queues naturally depend on `ts-db`.
- Node telemetry export naturally depends on optional OTel SDK/exporter peers.
- File observers and health pings need filesystem behavior that belongs to runtime/platform adapters.
- Scheduler adapters differ by runtime (`node`, `cloudflare`, no-op).

If all of these stay in `@gobing-ai/ts-infra`'s main export, a consumer that only wants `EventBus` can
inherit storage, exporter, scheduler, and platform concerns. Conversely, if ADR-011 is read too strictly,
`ts-infra` cannot ship robust first-party adapters at all. The right boundary is not "infra does nothing
platform-specific"; it is "infra core stays portable, adapters are explicit."

**Decision.** `@gobing-ai/ts-infra` is split conceptually into a portable core and opt-in adapters.

1. **Core barrel (`@gobing-ai/ts-infra`) stays portable and dependency-light.** It exports contracts and
   runtime-neutral primitives: typed event bus, logger facade, telemetry helper contracts/defaults, event
   maps, scheduler/queue interfaces, and other code that does not require storage, platform APIs, exporter
   SDKs, or runtime-specific behavior.

2. **Adapters live behind explicit subpaths.** Storage-backed, runtime-backed, and exporter-backed
   implementations should be exposed from opt-in subpaths, for example:
   - `@gobing-ai/ts-infra/job-queue-db` for `ts-db` backed queue implementations;
   - `@gobing-ai/ts-infra/otel-node` for Node OTel exporters/providers;
   - future `@gobing-ai/ts-infra/otel-workers` for Workers telemetry export;
   - `@gobing-ai/ts-infra/scheduler-node` / `scheduler-cloudflare` for runtime-specific schedulers;
   - future `@gobing-ai/ts-infra/file-observer-runtime` for FileSystem-backed observers.

3. **No static adapter imports from the core barrel.** The main barrel may export adapter-independent
   interfaces and factory types, but must not import adapter implementation modules as values. Subpath
   imports are the opt-in boundary.

4. **Dependency placement follows import weight.** Dependencies needed only by adapters belong to the
   adapter subpath's implementation path and should be optional peers when the package manager requires
   visibility in `package.json` (same structural optionality principle as ADR-007 and ADR-009). Direct
   internal dependencies still use `workspace:*` per ADR-002.

5. **Injection remains valid for tiny seams, but not as a substitute for adapters.** Injected writers,
   sinks, and ports are appropriate when the operation is small and keeps core portable. When an
   implementation becomes a real integration with lifecycle, configuration, retry/error policy, or
   platform-specific behavior, prefer a named adapter subpath over widening every core API with callback
   seams.

6. **Event maps are owned by the package that owns the behavior.** `ts-infra` owns infrastructure-level
   event maps (`queue.*`, `scheduler.*`, `api.*`, `db.*`). Higher-level packages own their domain event
   maps and may compose them with `InfraEvents`.

**Consequences.** `@gobing-ai/ts-infra` remains a robust foundation without becoming a monolithic import.
Consumers can depend on the portable core for events/logging/telemetry contracts and opt into concrete
storage/runtime/exporter implementations intentionally. DB-backed queues and runtime-specific schedulers
now live behind subpaths; future refactors should move platform/file-backed observers toward subpaths without breaking existing
callers unless a normal semver-breaking release is explicitly planned. Spur rules should eventually enforce:
main-barrel import graph contains no adapter-only SDKs/platform modules, and sanctioned adapter subpaths do
not leak into core.

---

## 2026-06-08 — Bare PluginHost + Plugin lifecycle core in ts-infra (task 0025)

**Decision.** Add a bare `PluginHost` + `Plugin` lifecycle core to `@gobing-ai/ts-infra`'s portable
`application` subpath, and integrate it into `runApplication`'s deterministic startup/shutdown lifecycle.

**Rationale.** The downstream Spur project had an unused 945-LOC plugin SDK (`spur-plugin-sdk`) with
capability registries and a trust ladder that no consumer ever invoked. Rather than let that decompose in a
downstream app, upstream the minimal lifecycle core every ts-infra application can inherit for free. This
follows the same "portable core / platform subpath" pattern as the existing telemetry and scheduler
adapters (ADR-014).

**What landed.**
- `Plugin` interface with `name`, `version`, `onLoad`/`onUnload`/`onStart`/`onStop` hooks. Names are
  runtime-neutral (not server-specific) so CLI + server share them.
- `PluginHost` class with insertion-ordered registration, fail-fast `loadAll()`, and fail-soft
  `startAll()`/`stopAll()`/`unloadAll()` (reverse-order for stop/unload).
- `runApplication` integration: host construction after scheduler init, `loadAll()` → `startAll()` before
  user `start()`, and `stopAll()` → `unloadAll()` as step 0 of `performShutdown`. Zero-cost when no
  plugins are provided (R5).
- `ApplicationBootstrapOptions.plugins?: Plugin[]`, `ApplicationServices.pluginHost?`, and
  `ApplicationRuntime.pluginHost?`.

**Deferred.** Capability registries, trust ladder, and manifest schema. They were the unused complexity in
Spur's package; they can be re-added later as built-in plugins or a higher layer when a concrete need
appears.

**Code location.** `packages/infra/src/application/plugins/` — exported from the portable `application`
surface. No runtime-specific imports (R6).

## 2026-06-08 — Rename `ts-runtime/plugin` subpath → `ts-runtime/extension` (amends ADR-010)

**Decision.** Rename the ADR-010 shared core's subpath from `@gobing-ai/ts-runtime/plugin` to
`@gobing-ai/ts-runtime/extension`. The directory `packages/runtime/src/plugin/` (and its barrel
`src/plugin.ts`) move to `src/extension/` / `src/extension.ts`. Public symbols are unchanged
(`CapabilityRegistry`, `loadExtensionModules`, `assertRelativeExtensionPath`, `ExtensionRef`, …).

**Rationale.** Task 0025 added a bare application-lifecycle `PluginHost`/`Plugin` to `ts-infra`. Two
distinct mechanisms both called "plugin" in one monorepo is a naming hazard. They are orthogonal:

- **`ts-runtime/extension`** — *extension loading*: a trust-gated capability registry + module loader
  that discovers code on disk and gates it by origin/capability. Consumers: `ts-rule-engine`,
  `ts-dual-workflow-engine` (engine internals). Answers *"what code may extend this engine, from where?"*
- **`ts-infra` `PluginHost`** — *lifecycle orchestration*: load/start/stop/unload fan-out for components
  in a `runApplication` bootstrap. Consumers: whole applications. Answers *"when do these components boot
  and shut down?"* No trust model (deliberately deferred).

They **may compose** (an infra plugin's `onLoad` could drive an extension loader) but neither imports the
other. The files were already named `extension-loader` / `extension-path`; `extension` is the honest name.

**Scope.** In-repo only. Verified `~/xprojects/spur-new` consumes **no** `ts-runtime/plugin` subpath
(it uses the `ts-runtime` main barrel + its own `spur-plugin-sdk`), so the rename is safe with no
downstream coordination. Changed: `runtime` package.json exports map, `src/` + `tests/` dirs, two
consumer `tsconfig` path aliases, nine import specifiers across the two engines, and package READMEs.
Historical `CHANGELOG.md` and `docs/tasks/000*.md` entries are left as dated records.

**Deferred (still, per ADR-010).** A dedicated `packages/*-core`, a cross-import spur rule, and any
symbol-level rename remain future work gated on real pressure, not drift.

## 2026-06-08 — Infra services as built-in plugins on the runApplication lifecycle (task 0027)

**Decision.** Migrate `runApplication`'s hand-rolled service init/shutdown choreography onto the
task-0025 `Plugin` lifecycle. Logger, telemetry+metrics, and scheduler each become an internal
built-in `Plugin` whose `onStart` = init and `onStop` = teardown; the user `start` callback is wrapped
as a built-in plugin too. The host's existing forward `startAll` / reverse `stopAll` then provides A→Z
init / Z→A shutdown from registration order alone — no priority/phase tier.

**`failFast` semantics.** Added an optional `failFast?: boolean` to the `Plugin` interface. `startAll`
rethrows (aborting boot) when a `failFast: true` plugin throws in `onStart`; others log + continue.
`loadAll` stays unconditionally fail-fast; `stopAll`/`unloadAll` stay unconditionally fail-soft
(every teardown attempted on the way down). Built-in services + the user-callback plugin are
`failFast: true`; user plugins default to fail-soft. This is additive — no existing plugin behavior
changes.

**Registration order = dependency order.** logger → telemetry → [user plugins] → user-callback →
scheduler (scheduler last so its autoStart runs after the user `start`).

**Deliberate inline exceptions (not everything is a plugin).**
- **User `stop`** stays inline in `performShutdown`: `onStop(host)` cannot carry the
  `ApplicationStopReason` the user callback signature requires.
- **DB `close`** stays inline, *after* user stop: a DB plugin's `onStop` would run inside `stopAll`
  (before user stop), changing the observable order and risking use-after-close in user stop code.
  The portable DB remains caller-injected; a DB plugin + ownership model is deferred to the phase that
  introduces a bootstrap-created adapter (the Node subpath, per task 0026's ownership rule).
- **Events** construction stays inline (it is construction, not a lifecycle pair).

**Status.** Partial migration (logger/telemetry/scheduler/user-start are plugins). Zero observable
behavior change, zero public-API removal (`failFast` is additive). Remaining collapse (full inline
removal, Node-telemetry plugin) is gated on the same A→Z/Z→A ordering guarantees and a deliberate DB
ownership decision.

---

## 2026-06-08 — Plugin migration completion: reason-carrying teardown + caller-owned DB (task 0028)

**Decision.** Complete the infra plugin migration by adding optional `reason?: string` to the plugin
teardown path (`onStop`, `onUnload`, `stopAll`, `unloadAll`), converting user-stop and Node-owned
services (telemetry, DB) into plugins, and stopping the portable layer from closing caller-injected DBs.

**Rationale.** The single blocker that left task 0027 PARTIAL was that `PluginHost.stopAll()` and
`onStop(host)` carried no stop reason, so the user `stop(app, reason)` callback couldn't be a plugin.
Threading `reason` through teardown removed this blocker. The DB ownership rule — *close what you create;
never close what you were handed* — was applied uniformly across both portable and Node layers.

**What landed.**
- **Phase 1 (keystone):** `Plugin.onStop?(host, reason?)` / `onUnload?(host, reason?)`,
  `PluginHost.stopAll(reason?)` / `unloadAll(reason?)`. Reason typed as plain `string` — core stays
  runtime-neutral; `runApplication` passes its `ApplicationStopReason` (a string union) directly.
- **Phase 2:** `userCallbackPlugin` gains `onStop(host, reason)` calling `options.stop(app, reason)`.
  Inline user-stop and inline `app.db.close()` removed from `performShutdown`. Caller-injected DB no
  longer closed — a DELIBERATE behavior change, called out for the release.
- **Phase 3:** `nodeTelemetryPlugin` (failFast, onStart=initNodeTelemetry, onStop=shutdownNodeTelemetry) +
  `dbPlugin` (reason-aware onStop=close) registered in `runNodeApplication`. Manual try/catch rollback
  (task 0026) and stop override removed — all cleanup now plugin-driven.
- `performShutdown` collapsed to `stopAll(reason) → unloadAll(reason)`. Orchestrator fully host-driven.

**Behavior change:** `@gobing-ai/ts-infra` no longer closes an injected `services.db` on stop.
Callers who relied on this must close their own adapter. Callers who already own their adapter see
no double-close.

**Code location.** `application/plugins/types.ts` (+reason on teardown hooks), `host.ts` (+reason on
stopAll/unloadAll), `builtins.ts` (+reason-aware userCallbackPlugin.onStop, re-added dbPlugin),
`application/index.ts` (-inline user-stop, -inline DB-close, +reason passthrough),
`application-node.ts` (+plugins array, -manual rollback, -stop override).
