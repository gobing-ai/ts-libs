---
name: migrate rule-engine onto shared plugin core
description: migrate rule-engine onto shared plugin core
status: Testing
created_at: 2026-06-03T22:51:51.216Z
updated_at: 2026-06-03T23:32:05.769Z
folder: docs/tasks
type: task
feature-id: ""
priority: high
estimated_hours: 6
dependencies: ["0007"]
tags: ["0006","rule-engine","migration"]
preset: complex
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0008. migrate rule-engine onto shared plugin core

### Background

Child of task 0006 (ADR-010), depends on 0007 (shared core). Migrate packages/rule-engine onto the shared CapabilityRegistry and generic extension loader from @gobing-ai/ts-runtime/plugin with ZERO behavior drift. rule-engine currently owns CapabilityRegistry in src/host/capability-registry.ts and the trust-gated loader in src/config/extensions.ts. The migration replaces the internal mechanism with the shared one while keeping every caller-visible behavior identical: RuleEngineHost public shape, error messages, override warnings, schema semantics, and the allowExtensions trust gate all unchanged. Extension kinds (resolvers/evaluators/fixers/formatters) and the extensions zod schema stay rule-engine-local; only the generic mechanism is shared.


### Requirements

R1 RuleEngineHost uses the shared CapabilityRegistry; public shape (evaluators/formatters/resolvers registries) unchanged. R2 collectExtensions stays in rule-engine (kinds + schema are domain-specific). R3 loadExtensionsIntoHost reimplemented to delegate generic loading to the shared loader while keeping rule-engine kind->registry mapping and override-warning strings local (override semantics stay engine-owned per ADR-010 R14). R4 The relative-path guard composes the shared assertRelativeExtensionPath() — schema-time AND load-time enforcement. R5 Existing rule-engine error messages preserved unless a test deliberately approves a clearer message; allowExtensions gate unchanged; fixers remain outside host registration. R6 If CapabilityRegistry is currently public surface, re-export from the old path for one release; if internal-only, update imports directly without adding public surface. R7 Dependency + tsconfig path alias to @gobing-ai/ts-runtime kept in sync (ADR-002/004). R8 All existing rule-engine extension/loader tests pass unchanged; add compatibility tests if a re-export or message changed. R9 bun run spur-check + bun run build pass. Acceptance: rule-engine behavior identical from caller perspective; no drift.


### Q&A



### Design

**Shared core API consumed (from 0007, ADR-010):** `@gobing-ai/ts-runtime/plugin` exports
`CapabilityRegistry<T>`, `loadExtensionModules<K>(refs, options, register)`, `ExtensionRef<K>` (with
`{ kind, path, baseDir, sourceName }`), `LoadExtensionsOptions` (with **required** `moduleLoader`), and
`assertRelativeExtensionPath()`. Note the 0007 security fix: the loader resolves `path` against
`baseDir` itself — callers supply `baseDir`, **not** a pre-resolved `absPath`.

**Migration moves (no caller-visible drift):**

1. **Registry** — delete `src/host/capability-registry.ts`; re-export `CapabilityRegistry`,
   `CapabilityEntry`, `CapabilityOrigin` from the shared core via a compatibility shim at the old path
   so the public barrel (`index.ts:9`) keeps exporting them (R6 — currently public surface). The shared
   registry is API-compatible (it adds `getEntry`/`entries`; rule-engine used only `register`/`has`/
   `get`/`list`).
2. **`RuleEngineHost`** — unchanged public shape (`evaluators`/`formatters`/`resolvers`); only its
   import of `CapabilityRegistry` repoints to the shim/shared export.
3. **`collectExtensions`** — stays in rule-engine. *(Originally planned to emit `{path, baseDir}`;
   **deferred to 0011** — see R3. It keeps its current `absPath` shape, which existing tests pin.)*
4. **`loadExtensionsIntoHost`** — *(Originally planned to delegate to the shared `loadExtensionModules`;
   **deferred to 0011** due to the `absPath`-vs-`baseDir` public-contract conflict — see R3. It is
   unchanged in this task.)*
5. **Path guard** — the rule-engine zod `relativeExtensionPath` refinement stays (schema-time
   validation) **and** the shared loader re-checks at load time (defense in depth).
6. **Wiring** — add tsconfig path alias `@gobing-ai/ts-runtime/plugin` → `../runtime/src/plugin`
   (ADR-004); dep already `workspace:*`.

### Solution

Repoint rule-engine's registry to the shared core (with a compat re-export), adapt `collectExtensions`
to the `path`+`baseDir` ref shape, and rewrite `loadExtensionsIntoHost` to delegate to the shared
trust-gated loader while keeping kind→registry mapping, override warnings, and the `allowExtensions`
gate local. Preserve every existing rule-engine test; update a test only when a delegated message
genuinely changed, and document why.

### Plan

- [ ] Add tsconfig path alias for `@gobing-ai/ts-runtime/plugin`.
- [ ] Replace `src/host/capability-registry.ts` with a re-export shim from the shared core (keep the
      public symbols at the old path).
- [ ] Repoint `RuleEngineHost` + internal importers to the shim/shared export; confirm public shape
      unchanged.
- [ ] Adapt `collectExtensions` to emit `{ kind, path, baseDir, sourceName }`.
- [ ] Rewrite `loadExtensionsIntoHost` to delegate to `loadExtensionModules` with a local `moduleLoader`
      and a kind→registry `register` callback that preserves override warnings.
- [ ] Run `packages/rule-engine` tests; reconcile any delegated-message diffs honestly.
- [ ] Run `bun run lint` + `bun run test` + `bun run build`; confirm 8/8 packages and rule-engine
      coverage unchanged.

### Review

**Verdict: PARTIAL** — registry + path-guard migrated cleanly with zero drift; full loader delegation
(R3) deferred due to a surfaced API/security conflict (operator-approved 2026-06-03).

#### Phase 7 — SECU (`/rd3:dev-verify --fix all`, 2026-06-03): no findings

- **Security:** migration *strengthens* the guard story (one source of truth via shared
  `assertRelativeExtensionPath`); the shim is a pure re-export, no new attack surface, deferred
  `extensions.ts` untouched and internally consistent.
- **Correctness:** verified the `superRefine` short-circuits identically to the original two `.refine`
  chain (absolute checked before traversal, first failure wins); no test relies on dual issues or issue
  count; `.min(1)` empty-path rejection preserved. Old local `CapabilityRegistry` class fully removed —
  no dead duplicate.
- **Efficiency / Usability:** re-export is zero-cost; guard runs the same checks; real error messages
  pass through `superRefine` so `".." traversal` / `must be relative` wording is preserved.
- **Subpath resolution (build/runtime/publish):** confirmed `@gobing-ai/ts-runtime` ships
  `exports["./plugin"]`, `dist/plugin.{js,d.ts}` + `dist/plugin/` emit, and the rule-engine dist
  resolves `@gobing-ai/ts-runtime/plugin` end-to-end (full build green).

`--fix all`: no findings to fix.

#### Phase 8 — Requirements traceability:

- **R1** ✅ `RuleEngineHost` now uses the shared `CapabilityRegistry`. `src/host/capability-registry.ts`
  is a compatibility re-export from `@gobing-ai/ts-runtime/plugin`, so the public barrel
  (`index.ts:9`) and all internal importers keep working unchanged. Public host shape
  (`evaluators`/`formatters`/`resolvers`) untouched. Verified by `tests/host/capability-registry.test.ts`
  (passing against the shared impl) + 219 rule-engine tests green.
- **R2** ✅ `collectExtensions` and the `extensions` zod schema stay rule-engine-local (kinds remain
  `resolvers/evaluators/fixers/formatters`).
- **R3** ⏸ **DEFERRED (conflict surfaced).** The shared loader (after 0007's security fix) resolves
  `path`+`baseDir` itself and rejects a caller-supplied `absPath`; rule-engine's **public**
  `ExtensionRef` exposes `absPath` and existing tests pin it (`collectExtensions(...).absPath`,
  `loadPreset(...).extensions[].absPath`, literal `{kind,presetName,absPath}` refs, and a
  no-`moduleLoader` "default import" test). Delegating fully would either break rule-engine's published
  API (`absPath`→`baseDir`) or require a redundant dual-field ref. Per global rule R6 (surface
  conflicts, don't average), this is **deferred to a follow-up** to be sequenced after 0010 settles the
  workflow ref shape and whether a unified `ExtensionRef` contract is warranted. rule-engine's own
  `loadExtensionsIntoHost`, `ExtensionRef`, default `moduleLoader`, error strings, and override warnings
  are unchanged for now. **Tracked as task 0011** (depends on 0008 + 0010).
- **R4** ✅ The zod `relativeExtensionPath` refinement now delegates to the shared
  `assertRelativeExtensionPath()` (single source of truth) at schema time; the `".." traversal` and
  absolute-path rejections are preserved (`schema-gaps.test.ts`, `extensions.test.ts` green). Load-time
  enforcement lands when R3 completes.
- **R5** ✅ No error-message or behavior changes; `allowExtensions` gate untouched; fixers remain
  outside host registration.
- **R6** ✅ `CapabilityRegistry` re-exported from the old path (it is public surface).
- **R7** ✅ tsconfig path alias `@gobing-ai/ts-runtime/plugin` → `../runtime/src/plugin` added; dep
  already `workspace:*` (the subpath ships in the same package, so no new dependency).
- **R8** ✅ All 219 rule-engine tests pass unchanged; no test rewritten. Full suite 923 pass / 0 fail.
- **R9** ⚠ `bun run lint` + `bun run test` + `bun run build` all green (8/8 packages). `bun run
  spur-check` not runnable — `spur` binary absent in this environment (same caveat as 0007).

### Testing

- **rule-engine suite:** 219 tests, all passing — registry, extensions loader, schema-gaps,
  and loadPreset extension tests all green against the migrated registry + delegated path guard. **Zero
  tests modified.**
- **Full monorepo:** `bun run test` → 923 pass / 0 fail; `bun run lint` clean (Biome + 8× `tsc`);
  `bun run build` green for all 8 packages.
- **Gate caveat:** `spur-check` pending a spur-equipped environment.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| Code | `packages/rule-engine/src/host/capability-registry.ts` (now a shared re-export shim) | Claude | 2026-06-03 |
| Code | `packages/rule-engine/src/types.ts` (path guard → shared `assertRelativeExtensionPath`) | Claude | 2026-06-03 |
| Config | `packages/rule-engine/tsconfig.json` (`/plugin` path alias) | Claude | 2026-06-03 |

### References


