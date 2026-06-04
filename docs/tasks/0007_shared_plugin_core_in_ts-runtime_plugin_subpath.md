---
name: shared plugin core in ts-runtime plugin subpath
description: shared plugin core in ts-runtime plugin subpath
status: Done
created_at: 2026-06-03T22:51:38.876Z
updated_at: 2026-06-04T02:15:24.143Z
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

## Requirements — 2026-06-04 (re-audit, --force)

All 8 requirements MET. No scope drift.

- [x] **R1**: CapabilityRegistry<T> with register(name,capability,origin?), has, get, getEntry, entries, list → **MET** | Evidence: `packages/runtime/src/plugin/capability-registry.ts:20-58` (7 tests in `tests/plugin/capability-registry.test.ts`)
- [x] **R2**: Generic ExtensionRef<TKind>, LoadExtensionsOptions, loadExtensionModules with engine-provided register callback → **MET** | Evidence: `packages/runtime/src/plugin/extension-loader.ts:14-105` (11 tests in `tests/plugin/extension-loader.test.ts`)
- [x] **R3**: assertRelativeExtensionPath standalone validator (not zod) → **MET** | Evidence: `packages/runtime/src/plugin/extension-path.ts:1-20` (5 tests in `tests/plugin/extension-path.test.ts`); enforced at load time in loader line 92
- [x] **R4**: Fail-closed trust gate throws before any import → **MET** | Evidence: `packages/runtime/src/plugin/extension-loader.ts:74-83`; `loaderCalled === false` assertion in test at line 37-56
- [x] **R5**: Core imports neither engine — zero evaluator/resolver/action/guard vocabulary → **MET** | Evidence: only imports from `./extension-path` and `node:path`; no cross-package imports to ts-rule-engine or ts-dual-workflow-engine
- [x] **R6**: package.json exports `"./plugin"` → `dist/plugin.{js,d.ts}`; build emits plugin subpath → **MET** | Evidence: `packages/runtime/package.json:39-42`; `bun run build` green
- [x] **R7**: Unit tests — 23 tests across 3 files → **MET** | Evidence: all 23 passing in `bun run test`; 948 total tests pass
- [x] **R8**: Lint clean, coverage-gated, build green → **MET** | Evidence: `bun run spur-check` pass (30/30 rules + 948 tests + 8× typecheck)

### Scope Drift
None detected. All code in `packages/runtime/src/plugin/` maps to R1-R5. Tests map to R7. Config maps to R6.


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

## Review — 2026-06-04 (re-audit, --force)

**Verdict: PASS** — No SECU findings. All dimensions clean.
**Scope:** `packages/runtime/src/plugin/` + `packages/runtime/tests/plugin/` + `packages/runtime/package.json` (exports)
**Mode:** verify (Phase 7 SECU + Phase 8 traceability)
**Channel:** current
**Gate:** `bun run spur-check` → pass (all 30 rules + 948 tests + 8× typecheck)

### P1 — Blockers
No findings.

### P2 — Warnings
No findings.

### P3 — Info
No findings.

### P4 — Suggestions
No findings.

#### SECU analysis notes

- **Security:** Trust gate fail-closed (throws before any import at `extension-loader.ts:78`). Path guard (`assertRelativeExtensionPath`) enforced at load time on the authored `path`, which is also the basis for `resolve(baseDir, path)` — the loader never imports a caller-supplied absolute path (`extension-loader.ts:86-93`). The prior Phase 7 P2 finding (mismatched path/absPath) remains fixed — `ref.absPath` was replaced with `ref.baseDir`, and the import target is now derived. No hardcoded secrets, no injection vectors, no auth/authz issues in a core library module.
- **Efficiency:** O(n) single pass over refs; Map-backed registry O(1). No unbounded growth, no N+1, no blocking I/O.
- **Correctness:** Explicit null guards on module export (`candidate === null`, `typeof candidate !== 'object'`). Error messages include source, kind, and path context. No `any` types — uses `unknown` appropriately. No empty catch blocks, no silent error drops. Zero race conditions (sequential ref processing).
- **Usability:** JSDoc on every export; error messages are specific and actionable. Clean naming. Test seam via required `moduleLoader` injection.


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


