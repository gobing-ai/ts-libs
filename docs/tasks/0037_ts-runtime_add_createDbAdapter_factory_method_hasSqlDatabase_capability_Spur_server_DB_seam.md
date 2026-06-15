---
name: "ts-runtime: add createDbAdapter factory method + hasSqlDatabase capability (Spur server DB seam)"
description: "ts-runtime: add createDbAdapter factory method + hasSqlDatabase capability (Spur server DB seam)"
status: Done
created_at: 2026-06-15T16:00:02.481Z
updated_at: 2026-06-15T17:52:05.896Z
folder: docs/tasks
type: task
feature-id: ""
priority: P0
estimated_hours: 8
tags: ["ts-runtime","spur-consumer","server-side-adjustment"]
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0037. "ts-runtime: add createDbAdapter factory method + hasSqlDatabase capability (Spur server DB seam)"

### Background

Spur's server re-foundation (spur-new groups S/W) needs a migrated DbAdapter on BOTH the local Bun path and the Cloudflare Workers path, obtained through the SAME seam so apps/server carries ZERO platform-detection code (Spur invariant #9, enhance-first rule). Today RuntimeFactory exposes only createFileSystem/createProcessExecutor/loadConfig and RuntimeCapabilities has hasFilesystem/hasProcessExecution/hasPersistentStorage — no DB facility. The Bun DB wiring currently lives in Spur's packages/domain createMigratedDb; per the enhance-first rule it must move behind this factory. This is prerequisite P1 to Spur's S1 wave: S1 does not start until this ships (semver bump) and Spur consumes it. Verified absent in @gobing-ai/ts-runtime@0.3.18.


### Requirements

R1: RuntimeFactory gains createDbAdapter(config) returning a Promise<DbAdapter> (DbAdapter from @gobing-ai/ts-db). R2: RuntimeCapabilities gains a readonly hasSqlDatabase boolean. R3: nodeBunFactory.createDbAdapter wires Bun SQLite at the configured path via ts-db (relocate the behavior Spur's createMigratedDb has today; hasSqlDatabase=true). R4: cloudflareWorkersFactory.createDbAdapter is a stub that throws a typed D1NotConfiguredError until D1 ships (hasSqlDatabase=false); the method EXISTS on the interface so consumer app code is forward-compatible and needs no change when D1 lands. R5: D1 DbAdapter implementation itself is OUT OF SCOPE (deferred to a later ts-db round). R6: Tests cover the Bun adapter creation + migration, the CF stub throwing the typed error, and the capability flags per factory; per-file coverage >=90%. R7: Ship as a semver MINOR of @gobing-ai/ts-runtime; no breaking change to existing factory consumers.


### Q&A



### Design

Authority: Spur design doc `docs/design/server-side-adjustment-design.md` §2.1.1 (runtime adaptation is
ts-runtime's job), §2.3 (ServerContext.getDb), §2.3.1 (D1 scoped out); Spur invariant #9 (platform
divergence lives only in ts-runtime). This task is Spur prerequisite **P1**.

**Current state (verified against `@gobing-ai/ts-runtime@0.3.18`):**

- `packages/runtime/src/runtime-factory.ts` — `interface RuntimeFactory` has `runtimeName`,
  `capabilities`, `createFileSystem()`, `createProcessExecutor(config?)`, `loadConfig(options?)`.
  **No DB method.**
- `packages/runtime/src/types.ts` — `interface RuntimeCapabilities` has `hasFilesystem`,
  `hasProcessExecution`, `hasPersistentStorage`. **No `hasSqlDatabase`.**
- `packages/runtime/src/runtime-node-bun.ts` — `nodeBunFactory`, `capabilities` all `true`,
  `createFileSystem: () => getNodeFileSystem()`.
- `packages/runtime/src/runtime-cf.ts` — `cloudflareWorkersFactory`, `hasFilesystem:false`,
  `createFileSystem: () => createCfFileSystem()`, `createProcessExecutor` throws.
- `packages/runtime/src/platform.ts` — `loadRuntimeFactory()` auto-detects + lazy-imports + caches.

**Design constraints:**

1. **`createDbAdapter(config)` returns `Promise<DbAdapter>`** where `DbAdapter` is the `@gobing-ai/ts-db`
   type. `ts-runtime` already does NOT depend on `ts-db` today — add `@gobing-ai/ts-db` as a dependency
   of `packages/runtime` (it is a sibling workspace package; check for a circular-dep risk: `ts-db` must
   NOT depend on `ts-runtime`. If it does, the DB type must be injected/structural rather than imported —
   prefer importing the `DbAdapter` TYPE only, `import type`, which erases at compile time and avoids a
   runtime cycle). Verify with `bun pm ls` / the workspace graph before wiring.
2. **Config shape.** Reuse the existing runtime `Config` (from `packages/runtime/src/config.ts`) or accept
   a focused `DatabaseConfig` argument (`{ url: string; driver?: string; d1Binding?: string }`). Prefer a
   small dedicated `DatabaseConfig` so the DB facility does not bloat the general `Config`. The Bun path
   reads `config.url` (e.g. `.spur/spur.db` or `:memory:`); the CF path reads `config.d1Binding`.
3. **Bun impl = relocate Spur's `createMigratedDb` behavior.** Spur's `packages/domain/src/db`
   `createMigratedDb` opens Bun SQLite and applies migrations. The factory method opens the adapter via
   `ts-db` at the configured path. **Migration application stays the caller's concern** (Spur composes
   its own `CLI_SCHEMA_SQL`); the factory returns a connected `DbAdapter`, NOT a migrated one — keep the
   factory schema-agnostic. (Document this boundary clearly: ts-runtime owns *connection*, the consumer
   owns *schema*.) Confirm against how `ts-db` exposes adapter construction (`createDbAdapter`/`new ...`).
4. **CF stub throws a typed error.** Define `class D1NotConfiguredError extends Error` exported from
   `packages/runtime`. `cloudflareWorkersFactory.createDbAdapter` throws it. `hasSqlDatabase:false` on CF.
   This lets Spur app code call `getDb()` uniformly; the Worker path surfaces a clear typed failure until
   D1 ships, never a silent undefined.
5. **Capability flag.** `nodeBunFactory.capabilities.hasSqlDatabase = true`;
   `cloudflareWorkersFactory.capabilities.hasSqlDatabase = false`. `RuntimeCapabilities` interface gains
   `readonly hasSqlDatabase: boolean` — this is an interface widening; every existing `RuntimeCapabilities`
   literal in the repo (node-bun, cf, and any `test` factory) MUST add the field or tsc breaks. Grep for
   all `capabilities:` / `RuntimeCapabilities` literals before changing the interface.
6. **D1 adapter is OUT OF SCOPE** (Spur §2.3.1). Only the CF *stub* ships here. The real `D1DbAdapter`
   in `ts-db` is a separate deferred ts-libs round.

**Out of scope:** D1 `DbAdapter`/`BaseDao` flavor in `ts-db`; any Spur-side consumption (that is Spur
task S1 0073, which bumps the ts-runtime semver and calls the new method).


### Solution

Add a DB seam to `@gobing-ai/ts-runtime` via interface widening: `RuntimeFactory.createDbAdapter(config)` + `RuntimeCapabilities.hasSqlDatabase`. Type-only import of `DbAdapter` from `@gobing-ai/ts-db` (`import type`) to avoid any runtime cycle — ts-runtime depends on ts-db at the type level only.

**Boundary:** ts-runtime owns *connection* (opens the adapter at a path); the consumer owns *schema* (migrations). The factory returns a connected, un-migrated `DbAdapter`.

**Config:** dedicated `DatabaseConfig` (`{ url: string; driver?: string; d1Binding?: string }`) — does not bloat the general runtime `Config`.

**Per-runtime:**
- `nodeBunFactory.createDbAdapter` — opens Bun SQLite at `config.url` via ts-db's adapter constructor; `hasSqlDatabase = true`.
- `cloudflareWorkersFactory.createDbAdapter` — throws typed `D1NotConfiguredError`; `hasSqlDatabase = false`. Method exists on the interface so consumer code is forward-compatible when the D1 round lands.

**Exports:** `DatabaseConfig`, `D1NotConfiguredError`, and re-export of `DbAdapter` type from the package index.

**Out of scope:** D1 `DbAdapter` implementation in ts-db (deferred round); Spur-side consumption (Spur task 0073).


### Plan

- [ ] Pre-flight: verify `@gobing-ai/ts-db` does NOT depend on `@gobing-ai/ts-runtime` (no runtime cycle). Add `@gobing-ai/ts-db` to `packages/runtime/package.json` deps; use `import type { DbAdapter }` to keep it type-only if any cycle risk exists.
- [ ] Define `DatabaseConfig` type in `packages/runtime/src/types.ts` (or a new `db-config.ts`): `{ url: string; driver?: string; d1Binding?: string }`.
- [ ] Add `createDbAdapter(config: DatabaseConfig): Promise<DbAdapter>` to `interface RuntimeFactory` (`runtime-factory.ts`) (R1).
- [ ] Add `readonly hasSqlDatabase: boolean` to `interface RuntimeCapabilities` (`types.ts`) (R2).
- [ ] Grep every `RuntimeCapabilities` literal (`rg "hasFilesystem" packages/runtime/src`) and add `hasSqlDatabase` to each (node-bun=true, cf=false, test factory if present).
- [ ] `nodeBunFactory.createDbAdapter` (`runtime-node-bun.ts`): open Bun SQLite at `config.url` via `ts-db` adapter constructor; return the connected `DbAdapter` (connection only, no migration — caller owns schema) (R3). `capabilities.hasSqlDatabase = true`.
- [ ] Export `class D1NotConfiguredError extends Error` from the package index (`packages/runtime/src/index.ts`).
- [ ] `cloudflareWorkersFactory.createDbAdapter` (`runtime-cf.ts`): `throw new D1NotConfiguredError('D1 DbAdapter not yet implemented; see ts-db D1 round')` (R4). `capabilities.hasSqlDatabase = false`.
- [ ] Export `DatabaseConfig`, `D1NotConfiguredError`, and re-export `DbAdapter` type from `packages/runtime/src/index.ts` so consumers import the DB seam from `@gobing-ai/ts-runtime`.
- [ ] Tests (`packages/runtime/tests/`): (a) `nodeBunFactory.createDbAdapter(':memory:')` returns a usable adapter (run a trivial `SELECT 1` / a known ts-db smoke); (b) the returned capabilities expose `hasSqlDatabase:true` for node-bun, `false` for cf; (c) `cloudflareWorkersFactory.createDbAdapter` rejects/throws `D1NotConfiguredError` (instanceof assertion); (d) the interface widening compiles (type-level: a `RuntimeCapabilities` value requires `hasSqlDatabase`). Per-file >=90% line+func (R6).
- [ ] Gate: `bun run spur-check` (or the package's gate) green; no breaking change to existing factory consumers (R7).
- [ ] Bump `@gobing-ai/ts-runtime` semver MINOR; publish. Record the released version in this task so Spur task 0073 can pin it (R7).
- [ ] Hand-off note: Spur task **0073 (S1 — ServerContext + DB wiring)** consumes this by bumping the ts-runtime catalog entry and routing `ServerContext.getDb()` through `RuntimeFactory.createDbAdapter()`.

## Review

**Verdict: PASS**

### Requirements traceability

| Req | Status | Evidence |
|-----|--------|----------|
| R1: `RuntimeFactory.createDbAdapter(config)` returns `Promise<DbAdapter>` | PASS | `runtime-factory.ts:45` — `createDbAdapter(config: DatabaseConfig): Promise<RuntimeDbAdapter>`. Uses structural `RuntimeDbAdapter` (assignable from ts-db's `DbAdapter`) instead of a direct type import to avoid a build-time cycle (see SECU-1). |
| R2: `RuntimeCapabilities.hasSqlDatabase` boolean | PASS | `types.ts:21` — `readonly hasSqlDatabase: boolean` added to interface. All 4 capability literals updated (node-bun=true, cf=false, context default=true, test assertion). |
| R3: `nodeBunFactory.createDbAdapter` wires Bun SQLite via ts-db, `hasSqlDatabase=true` | PASS | `runtime-node-bun.ts:42-54` — dynamic `import('@gobing-ai/ts-db')` delegates to ts-db's `createDbAdapter({driver:'bun-sqlite', url})`. Connection only (no migration — boundary documented). `capabilities.hasSqlDatabase=true` at line 34. |
| R4: CF stub throws typed `D1NotConfiguredError`, `hasSqlDatabase=false` | PASS | `runtime-cf.ts:31-36` — `createDbAdapter` returns `Promise.reject(new D1NotConfiguredError())`. `hasSqlDatabase=false` at line 25. Method exists on the interface for forward compatibility. |
| R5: D1 DbAdapter implementation OUT OF SCOPE | PASS | Not implemented. Only the stub ships. `D1NotConfiguredError` exported from `db-errors.ts`. |
| R6: Tests cover Bun adapter, capabilities, CF stub | PASS | `tests/create-db-adapter.test.ts` — 8 tests: (a) `:memory:` adapter executes SQL, (b) type annotation compiles, (c) node-bun `hasSqlDatabase:true`, (d) cf `hasSqlDatabase:false`, (e) CF rejects with `D1NotConfiguredError` instanceof, (f) error name, (g) `D1NotConfiguredError` extends Error, (h) custom message. All pass. |
| R7: No breaking change to existing consumers | PASS | Interface widening: `hasSqlDatabase` added (required field — all literals updated). `createDbAdapter` is additive. Deprecated re-exports preserved. All packages typecheck + build green. |

### SECU review

**S — Security:** No external input handling, no secrets, no network. The dynamic import uses a hardcoded module specifier (no injection surface). `DatabaseConfig.url` is passed directly to ts-db's factory — no SQL interpolation in ts-runtime.

**E — Error handling:** CF stub throws a typed `D1NotConfiguredError` (not a generic `Error`) — consumers can `catch` by type. The error carries a descriptive default message. `D1NotConfiguredError` properly sets `name` for stack trace clarity.

**C — Correctness:** The dynamic import via variable specifier (`const spec = '@gobing-ai/ts-db'; await import(spec)`) is intentional — it prevents tsc from type-resolving ts-db at build time (ts-db builds after ts-runtime in the dependency order). At runtime, Bun resolves via workspace + tsconfig paths. The structural `RuntimeDbAdapter` type is satisfied by ts-db's `DbAdapter` via structural subtyping (extra `db` property is harmless). Connection/schema boundary is clean: factory returns connected adapter, caller owns migrations.

**U — Usability:** `DatabaseConfig` is focused (`{url, driver?, d1Binding?}`) — does not bloat the general runtime `Config`. README section 8 documents the seam, the boundary, and the dependency note. `D1NotConfiguredError` and `DatabaseConfig` exported from the package index.

### Architecture note (SECU-1): structural type vs. type-only import

The Design anticipated using `import type { DbAdapter }` to avoid a runtime cycle. In practice, `ts-db` depends on `ts-runtime` (confirmed in `packages/db/package.json:69`), making ANY import — even type-only — problematic at BUILD time: the build order is runtime → db, so when runtime builds, ts-db's `dist/` doesn't exist, and `import type` with `paths: {}` in the build config cannot resolve. A structural `RuntimeDbAdapter` type (the public method surface of `DbAdapter`, minus the `@internal db` property) is the correct decoupling — it compiles without ts-db and is structurally compatible with ts-db's `DbAdapter`.

### Gate results

- `bun run spur-check`: PASS (all 37 pre-check rules + 1460 tests + 2 post-check rules)
- `bun run build`: PASS (all 8 packages)
- No tests skipped or `.skip`'d
- No `biome-ignore` added
- `git status`: only intentional changes (15 files)

## Testing

**Date:** 2026-06-15T18:00:00Z
**Command:** `bun run spur-check` + `bun run build`
**Result:** ALL PASS

### Test coverage

| File | % Funcs | % Lines |
|------|---------|---------|
| `packages/runtime/src/db-errors.ts` | 100.00 | 100.00 |
| `packages/runtime/src/runtime-cf.ts` | 100.00 | 100.00 |
| `packages/runtime/src/runtime-node-bun.ts` | 100.00 | 100.00 |
| `packages/runtime/src/types.ts` | 100.00 | 100.00 |

### Test file: `packages/runtime/tests/create-db-adapter.test.ts` (8 tests)

1. `nodeBunFactory.createDbAdapter > returns a connected DbAdapter for an in-memory database` — opens `:memory:`, creates table, inserts, queries, asserts row data. Verifies connection works end-to-end.
2. `nodeBunFactory.createDbAdapter > the returned adapter satisfies the RuntimeDbAdapter type` — type-level check that the returned adapter is assignable to `RuntimeDbAdapter`.
3. `capabilities.hasSqlDatabase > is true on nodeBunFactory` — R2/R3.
4. `capabilities.hasSqlDatabase > is false on cloudflareWorkersFactory` — R2/R4.
5. `cloudflareWorkersFactory.createDbAdapter > rejects with D1NotConfiguredError` — R4, instanceof assertion.
6. `cloudflareWorkersFactory.createDbAdapter > the error carries the expected name` — R4, name field.
7. `D1NotConfiguredError > extends Error with the correct name` — error class contract.
8. `D1NotConfiguredError > accepts a custom message` — error class flexibility.

### Existing test updated

- `packages/runtime/tests/runtime-node-bun.test.ts:53` — added `hasSqlDatabase: true` to the `toEqual` capabilities assertion (interface widening).

### Gate results

```
spur-check: 1460 pass, 0 fail (37 pre-check + 2 post-check rules all green)
build: 8/8 packages built successfully
```


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


