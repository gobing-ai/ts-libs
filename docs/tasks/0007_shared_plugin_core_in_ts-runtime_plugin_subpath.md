---
name: shared plugin core in ts-runtime plugin subpath
description: shared plugin core in ts-runtime plugin subpath
status: Testing
created_at: 2026-06-03T22:51:38.876Z
updated_at: 2026-06-03T23:00:32.638Z
folder: docs/tasks
type: task
feature-id: ""
priority: high
estimated_hours: 7
tags: ["0006","plugin-core","ts-runtime","security"]
preset: complex
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0007. shared plugin core in ts-runtime plugin subpath

### Background

Child of task 0006 (ADR-010). Extract the generic, domain-agnostic plugin mechanism into @gobing-ai/ts-runtime, exported from the subpath @gobing-ai/ts-runtime/plugin. This is the foundation both ts-rule-engine and ts-dual-workflow-engine migrate onto. The mechanism already exists in mature form inside rule-engine (CapabilityRegistry with origin metadata; loadExtensionsIntoHost with a fail-closed allowExtensions gate, a moduleLoader test seam, default/named-extension export contract, and a relative-path/no-traversal guard) — this task lifts it out generically without any engine vocabulary. It is the security-critical primitive of the whole effort: the trust gate must fail closed before any dynamic import.


### Requirements

R1 CapabilityRegistry<T> in packages/runtime exposes register(name,capability,origin?), has, get, list, plus getEntry/entries so origin ('builtin'|'extension') is inspectable. register replaces by name; get throws a clear generic error including kind+name; list returns insertion order. R2 Generic ExtensionRef<TKind>, LoadExtensionsOptions (allowExtensions?, logger?, moduleLoader?), and a loader that imports+validates default/named-extension export then calls an engine-provided registration callback — the loader never decides which registry receives a module. R3 assertRelativeExtensionPath() is a standalone validator function (NOT a zod schema) rejecting absolute paths and '..' traversal, enforced at load time. R4 Trust gate is verbatim fail-closed: refs present + allowExtensions !== true throws BEFORE any import(); a test asserts the injected moduleLoader is never called when the gate is closed. R5 Core imports neither engine and knows no engine vocabulary (no evaluator/resolver/action/guard). R6 Exported via package.json exports map subpath @gobing-ai/ts-runtime/plugin; tsconfig path alias added per ADR-004. R7 Unit tests cover registry replacement/origin/list/get-error, loader trust gate, invalid export, default export, named extension, injected moduleLoader, and path guard. R8 bun run spur-check + bun run build pass; no .skip, no suppression-only biome-ignore. Acceptance: shared core is generic and reusable; trust gate proven fail-closed before import.


### Q&A



### Design

**Location & convention.** Mirror the existing `./bun-sqlite` subpath: a top-level barrel
`packages/runtime/src/plugin.ts` re-exports from a `src/plugin/` directory. `tsconfig.build.json` uses
`module: Preserve`, so `tsc` emits `dist/plugin.js` + `dist/plugin/*.js`; one `exports` entry
(`"./plugin"`) and one `tsconfig` path alias (`@gobing-ai/ts-runtime/plugin` → `src/plugin`) complete it.

**Modules (all generic, zero engine vocabulary):**

- `src/plugin/capability-registry.ts` — `CapabilityOrigin`, `CapabilityEntry<T>`, `CapabilityRegistry<T>`
  with `register(name, capability, origin='extension')`, `has`, `get` (throws `Unknown ${kind}: ${name}`),
  `getEntry`, `entries`, `list` (insertion order). Lifted verbatim from rule-engine's registry, plus
  `getEntry`/`entries` so `origin` is inspectable (R1).
- `src/plugin/extension-path.ts` — `assertRelativeExtensionPath(path, { sourceName })` standalone
  validator: throws on absolute paths and `..` traversal (R3). Logic ported from rule-engine's
  `relativeExtensionPath` zod refinement, but as a plain function so the loader enforces it independent
  of any schema.
- `src/plugin/extension-loader.ts` — generic `ExtensionRef<TKind>`, `LoadExtensionsOptions`
  (`allowExtensions?`, `logger?`, **required** `moduleLoader`), `LoadedExtension`, and
  `loadExtensionModules<TKind>(refs, options, register)`. Fail-closed: refs present +
  `allowExtensions !== true` throws **before any import** (R4). Validates default/named-`extension`
  export with a string `name`, enforces `assertRelativeExtensionPath` on every ref, then invokes the
  engine-provided `register` callback — the loader never chooses a target registry (R2/R5).
  **`moduleLoader` is required, not a defaulted optional:** the generic core performs no dynamic
  `import` of its own — the embedder supplies the import policy (`(p) => import(p)`). This is both a
  cleaner trust boundary (the shared core has zero ambient code-loading capability) and avoids an
  untested-by-design `import()` wrapper that would otherwise force a real-module fixture into the
  coverage report.
- `src/plugin/index.ts` + `src/plugin.ts` — barrels.

**Design choices vs the rule-engine original (no behavior loss for child 0008):**
- `get` keeps the generic `Error` (engines own their own error types — ADR-010 R13).
- Loader takes a `register` callback instead of a host; the rule-engine `presetName` field generalizes
  to `sourceName`; kind→registry mapping and override warnings move to the engine (ADR-010 R14).

### Solution

Create the four modules above under `packages/runtime/src/plugin/`, add the `plugin.ts` barrel, wire the
`exports` map and `tsconfig`/`tsconfig.build` path alias, and cover every behavior with unit tests under
`packages/runtime/tests/plugin/`. No engine is touched in this task — 0008/0009/0010 consume it.

### Plan

- [ ] Add `src/plugin/capability-registry.ts` (registry + origin + entries/getEntry).
- [ ] Add `src/plugin/extension-path.ts` (`assertRelativeExtensionPath`).
- [ ] Add `src/plugin/extension-loader.ts` (generic fail-closed loader + callback).
- [ ] Add `src/plugin/index.ts` and `src/plugin.ts` barrels.
- [ ] Add `"./plugin"` to `package.json` `exports`; add `@gobing-ai/ts-runtime/plugin` path alias to
      `tsconfig.json` (and confirm `tsconfig.build.json` emits it).
- [ ] Tests `tests/plugin/`: registry replacement/origin/list/get-error/entries; loader closed-gate
      throws-before-moduleLoader-call; invalid export; default export; named `extension`; injected
      `moduleLoader`; path guard (absolute + `..`).
- [ ] `bun run spur-check` + `bun run build` green.

### Review

**Verdict: PASS** (Phase 7 SECU + Phase 8 traceability, `/rd3:dev-verify --fix all`, 2026-06-03).

#### Phase 7 — SECU findings

| # | Title | Dimension | Location | P | Status |
|---|-------|-----------|----------|---|--------|
| 1 | Trust guard validated `path` but loader imported a separately-supplied `absPath` — a mismatched pair (`path: "./safe.ts", absPath: "/etc/evil"`) would pass the guard yet import the unvalidated target | Security | `src/plugin/extension-loader.ts:83-84` (pre-fix) | P2 | **FIXED** |

**Fix applied:** Replaced caller-supplied `ExtensionRef.absPath` with `baseDir`; the loader now
**derives** the import target via `resolve(baseDir, path)` *after* `assertRelativeExtensionPath(path)`,
so the trust guard always governs the module actually imported. `baseDir` must be absolute (validated).
This restores the rule-engine guarantee (resolve-in-one-trusted-place) that the generic loader had
severed. Two regression tests added: import target equals the resolved path; non-absolute `baseDir`
rejected.

Other dimensions — no findings:
- **Efficiency:** single O(n) pass over refs; Map-backed registry O(1); no N+1, no unbounded growth.
- **Correctness:** explicit null/type guards on the module export; errors thrown with source/kind/path
  context; no swallowed exceptions; zero `any`.
- **Usability:** JSDoc on every export; error messages name the source, kind, and path.

#### Phase 8 — Requirements traceability:

- **R1** ✅ `CapabilityRegistry<T>` (`src/plugin/capability-registry.ts`) — `register`/`has`/`get`/`list`
  plus `getEntry`/`entries` exposing `origin`. `get` throws `Unknown ${kind}: ${name}`; `list`/`entries`
  preserve insertion order. Covered by 7 registry tests.
- **R2** ✅ Generic `ExtensionRef<TKind>`, `LoadExtensionsOptions`, `loadExtensionModules<TKind>(refs,
  options, register)` — loader calls an engine-provided `register` callback and never selects a registry.
- **R3** ✅ `assertRelativeExtensionPath()` (`src/plugin/extension-path.ts`) is a standalone function
  (not a zod schema), enforced inside the loader at load time on the authored `path`, which is also the
  basis for the resolved import target (see Phase 7 fix). Rejects absolute + `..` paths.
- **R4** ✅ Fail-closed gate throws **before** any import/`moduleLoader` call; the
  `loaderCalled === false` assertion proves no import precedes the gate. Verbatim port of rule-engine
  posture.
- **R5** ✅ Core imports neither engine; no `evaluator`/`resolver`/`action`/`guard` vocabulary. Only
  intra-package + `node:*` imports.
- **R6** ✅ `package.json` `exports["./plugin"]` → `dist/plugin.{js,d.ts}`; build emits `dist/plugin.js`
  + `dist/plugin/*`. Consumer tsconfig path aliases are added in 0008/0009 (per ADR-004, those are the
  packages that import the subpath).
- **R7** ✅ 23 unit tests across 3 files cover registry, path guard, and loader (both export forms,
  invalid export, closed gate, resolved-import-target, absolute-`baseDir`).
- **R8** ✅ Lint clean, coverage-gated `bun run test` exits 0, full `bun run build` green (8/8 packages).
  No `.skip`, no suppression-only `biome-ignore`.

Security review: trust gate is fail-closed and proven to short-circuit before import; path guard is
enforced at load time independent of any schema (defense in depth). No `import()` reachable before the
gate. `get` stays generic so engines own their error types (ADR-010 R13) — no engine error class leaks
into the core.

### Testing

- **Suite:** `packages/runtime/tests/plugin/` — 23 tests, all passing (`capability-registry.test.ts` 7,
  `extension-path.test.ts` 5, `extension-loader.test.ts` 11, incl. 2 Phase-7 security regressions).
- **Coverage (new files):** `capability-registry.ts` 100% / `extension-path.ts` 100% /
  `extension-loader.ts` 100% (lines & functions). `moduleLoader` is a required dependency (the core
  performs no dynamic `import` itself), so coverage needs no real-module fixture and the report carries
  no transient temp-path entries.
- **Full monorepo:** `bun run test` → 922 pass / 0 fail, coverage threshold (lines 0.9 / functions 0.9)
  satisfied, exit 0. `bun run lint` clean (Biome + 8× `tsc --noEmit`). `bun run build` green for all 8
  packages incl. emitted `dist/plugin.*`.
- **Gate caveat:** `bun run spur-check` could not run end-to-end — the `spur` global binary is **not
  installed in this environment** (`command not found`). Lint, typecheck, tests, and build (the
  non-spur portions) all pass. The two `spur rule run` presets must be re-run in an environment with
  `spur` on PATH before final sign-off.

### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |
| Code | `packages/runtime/src/plugin/capability-registry.ts` | Claude | 2026-06-03 |
| Code | `packages/runtime/src/plugin/extension-loader.ts` | Claude | 2026-06-03 |
| Code | `packages/runtime/src/plugin/extension-path.ts` | Claude | 2026-06-03 |
| Code | `packages/runtime/src/plugin/index.ts` | Claude | 2026-06-03 |
| Code | `packages/runtime/src/plugin.ts` | Claude | 2026-06-03 |
| Config | `packages/runtime/package.json` (exports `./plugin`) | Claude | 2026-06-03 |
| Test | `packages/runtime/tests/plugin/*.test.ts` (23 tests) | Claude | 2026-06-03 |

### References

- `packages/rule-engine/src/host/capability-registry.ts` — origin of the registry mechanism.
- `packages/rule-engine/src/config/extensions.ts` — origin of the trust-gated loader.
- `docs/00_ADR.md` ADR-010 — shared-core decision and boundaries (R13 error types, R14 override/path).


