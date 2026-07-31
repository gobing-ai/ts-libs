---
schema_version: 1
name: migrate rule-engine onto shared plugin core
status: done
type: task
profile: complex
priority: P1
tags: ["0006",rule-engine,migration]
dependencies: ["0007"]
created_at: 2026-06-03T22:51:51.216Z
updated_at: 2026-06-04T02:20:34.118Z
---

## 0008. migrate rule-engine onto shared plugin core

### Background

Child of task 0006 (ADR-010), depends on 0007 (shared core). Migrate packages/rule-engine onto the shared CapabilityRegistry and generic extension loader from @gobing-ai/ts-runtime/plugin with ZERO behavior drift. rule-engine currently owns CapabilityRegistry in src/host/capability-registry.ts and the trust-gated loader in src/config/extensions.ts. The migration replaces the internal mechanism with the shared one while keeping every caller-visible behavior identical: RuleEngineHost public shape, error messages, override warnings, schema semantics, and the allowExtensions trust gate all unchanged. Extension kinds (resolvers/evaluators/fixers/formatters) and the extensions zod schema stay rule-engine-local; only the generic mechanism is shared.


### Requirements

## Requirements — 2026-06-04 (re-audit, --force)

All 9 requirements MET. R3 (previously deferred) is now implemented via the adapter pattern.

- [x] **R1**: RuleEngineHost uses shared CapabilityRegistry; public shape unchanged → **MET** | Evidence: `host/capability-registry.ts:9` re-exports from shared; `host/rule-engine-host.ts:6-18` uses shared; 219 tests pass against shared impl
- [x] **R2**: collectExtensions stays rule-engine-local (kinds + schema domain-specific) → **MET** | Evidence: `config/extensions.ts:51-64` — local function using ExtensionKind
- [x] **R3**: loadExtensionsIntoHost delegates to shared `loadExtensionModules` with kind→registry mapping + override warnings local → **MET** | Evidence: `config/extensions.ts:82-141` — adapter converts rule-engine `ExtensionRef` (absPath) → shared `ExtensionRef` (path+baseDir) via `dirname`/`basename` decomposition, then calls shared loader with kind→registry callback preserving override warnings
- [x] **R4**: Relative-path guard composes shared `assertRelativeExtensionPath()` — schema-time + load-time enforcement → **MET** | Evidence: `types.ts:226-238` uses `assertRelativeExtensionPath` in zod `.superRefine()`; load-time via shared loader's own guard
- [x] **R5**: No error-message changes, allowExtensions gate unchanged, fixers outside host registration → **MET** | Evidence: override warnings preserved lines 136-138; gate delegated to shared loader; HOST_REGISTRY_BY_KIND lacks 'fixers'
- [x] **R6**: CapabilityRegistry re-exported from old path (public surface) → **MET** | Evidence: `host/capability-registry.ts:9` re-exports from shared
- [x] **R7**: tsconfig path alias `@gobing-ai/ts-runtime/plugin` added → **MET** | Evidence: `tsconfig.json:10`; dep already `workspace:*`
- [x] **R8**: 219 rule-engine tests pass unchanged → **MET** | Evidence: full suite 219/219 pass, 0 fail, 0 modified
- [x] **R9**: Lint + typecheck + test + build green → **MET** | Evidence: `bun run spur-check` pass (30 rules + 948 tests + 8× typecheck)

### R3 Note
The previous review (2026-06-03) deferred R3 due to an `absPath`-vs-`baseDir` public-contract conflict between rule-engine's `ExtensionRef` (exposing `absPath`) and the shared loader's `ExtensionRef` (requiring `path`+`baseDir`). The adapter at `extensions.ts:109-117` resolves this by decomposing `absPath` → `{ path: ./basename(fp), baseDir: dirname(fp) }` pre-delegation, preserving the shared loader's security guarantee (it derives the import target) while keeping rule-engine's public API intact. The original `..` traversal guard on `absPath` (`extensions.ts:96-103`) runs before this decomposition as defense-in-depth.

### Scope Drift
None detected.


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

## Review — 2026-06-04 (re-audit, --force)

**Verdict: PASS** — Previously PARTIAL (R3 deferred); now all requirements met. No SECU findings.
**Scope:** `packages/rule-engine/src/host/` + `packages/rule-engine/src/config/extensions.ts` + `packages/rule-engine/src/types.ts` + tsconfig
**Mode:** verify (Phase 7 SECU + Phase 8 traceability)
**Channel:** current
**Gate:** `bun run spur-check` → pass (30 rules + 948 tests + 8× typecheck); rule-engine suite 219/219 pass

### P1 — Blockers
No findings.

### P2 — Warnings
No findings.

### P3 — Info
No findings.

### P4 — Suggestions
No findings.

#### SECU analysis notes

- **Security:** The adapter (`extensions.ts:96-103`) retains the original rule-engine `..` traversal check on caller-supplied `absPath` *before* the basename adaptation. The shared loader's `assertRelativeExtensionPath` runs independently on the derived path (defense in depth). The shared fail-closed gate (`allowExtensions !== true`) governs all imports at `loadExtensionModules`. Re-export shim (`capability-registry.ts`) is pure — no new attack surface.
- **Efficiency:** Single `refs.map(...)` O(n) adaptation; shared loader O(n) imports. No N+1, no unbounded growth.
- **Correctness:** Adapter faithfully maps: `absPath` → `{path: ./basename, baseDir: dirname}`; rule-engine `allowExtensions` gate → shared gate; override warnings preserved in the `register` callback (`extensions.ts:136-138`); fixers excluded via `HOST_REGISTRY_BY_KIND`; `defaultModuleLoader` fallback preserved (`extensions.ts:119`). All 219 tests pass unchanged.
- **Usability:** Shim JSDoc guides consumers to `@gobing-ai/ts-runtime/plugin`. Adapter comments document the basename adaptation. Error messages unchanged.


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




### History

- Migrated from legacy format (2026-07-31)
