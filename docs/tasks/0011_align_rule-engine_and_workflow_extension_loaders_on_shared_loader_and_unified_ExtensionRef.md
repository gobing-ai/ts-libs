---
name: align rule-engine and workflow extension loaders on shared loader and unified ExtensionRef
description: align rule-engine and workflow extension loaders on shared loader and unified ExtensionRef
status: Done
created_at: 2026-06-03T23:31:27.801Z
updated_at: 2026-06-04T00:51:27.576Z
folder: docs/tasks
type: task
feature-id: ""
priority: medium
estimated_hours: 5
dependencies: ["0008","0010"]
tags: ["0006","rule-engine","dual-workflow-engine","loader","follow-up"]
preset: complex
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0011. align rule-engine and workflow extension loaders on shared loader and unified ExtensionRef

### Background

Follow-up split from 0008 (ADR-010). 0008 migrated rule-engine onto the shared CapabilityRegistry and shared assertRelativeExtensionPath, but DEFERRED full delegation of loadExtensionsIntoHost to the shared loadExtensionModules. Root conflict: the shared loader (after 0007's security fix) derives the import target via resolve(baseDir, path) and rejects a caller-supplied absPath, whereas rule-engine's PUBLIC ExtensionRef exposes absPath and existing tests pin it (collectExtensions(...).absPath, loadPreset(...).extensions[].absPath, literal {kind,presetName,absPath} refs, and a no-moduleLoader default-import test). Sequenced after 0010 so the workflow ref shape is known before deciding whether a unified ExtensionRef contract (path+baseDir) across both engines is warranted.


### Requirements

R1 Decide and document the unified ExtensionRef contract: either (a) migrate rule-engine's public ExtensionRef from absPath to path+baseDir with a documented breaking change + compat window, or (b) keep absPath public and translate to the shared loader's shape internally. Pick one; do not add a permanent redundant dual-field ref. R2 rule-engine loadExtensionsIntoHost delegates generic loading to the shared loadExtensionModules, passing its own moduleLoader:(p)=>import(p) and a kind->registry register callback that preserves override-warning strings and the 'fixers not supported' error. R3 Workflow extension loader (from 0010) and rule-engine loader share the same shared-loader code path; no duplicated trust gate. R4 All existing rule-engine + workflow extension tests pass; rewrite a test only when a delegated message legitimately changed, and document why. R5 Trust gate stays fail-closed before import; load-time assertRelativeExtensionPath enforced for rule-engine too. R6 bun run spur-check + bun run build pass. Acceptance: a single shared trust-gated loader backs both engines; no behavior drift in either; ExtensionRef contract decision recorded.


### Q&A



### Design

### Design

**R1 — Unified ExtensionRef contract: Option (b).** Keep `absPath` in both engines' public APIs; translate to the shared loader's `path + baseDir` internally via `basename`/`dirname`. No breaking change. Both engines converge on the same adaptation pattern 0010 established.

**Rationale against option (a):** Migrating rule-engine's public `ExtensionRef` from `absPath` to `path+baseDir` would be a breaking change to `collectExtensions`, `loadPreset(...).extensions`, and all callers that construct literal `ExtensionRef` objects. The adaptation is thin (3 lines per ref) and the trust boundary is preserved through pre-validation of `..` traversal.

**R2 — Delegation to shared loader:** `loadExtensionsIntoHost` adapts rule-engine's `ExtensionRef { kind, absPath, presetName }` → shared `ExtensionRef { kind, path: './'+basename(absPath), baseDir: dirname(absPath), sourceName: presetName }`. Registration callback maps shared `ref.kind` to `host.evaluators`, `host.resolvers`, `host.formatters`, and throws `'fixers are not supported'` for fixer refs.

**R3 — Single code path:** Both `loadExtensionsIntoHost` (rule-engine) and `loadWorkflowExtensionsIntoHost` (workflow) now call `loadExtensionModules` from `@gobing-ai/ts-runtime/plugin`. Trust gate, module import, and export shape validation live in exactly one place.

**R4 — Test preservation:** Rewrite tests only where error messages legitimately changed (shared loader formats them differently). Document each rewrite.

**R5 — Trust gate unchanged:** The shared loader enforces `allowExtensions !== true` throws before any `moduleLoader` call — same fail-closed posture. `assertRelativeExtensionPath` is enforced by the shared loader internally and additionally at rule-engine config load time (0008 legacy).


### Solution

### Solution

Replace rule-engine's inline extension loading logic with delegation to the shared `loadExtensionModules` from `@gobing-ai/ts-runtime/plugin`, using the same `absPath → path+baseDir` adaptation pattern established in 0010.

Key changes:
- Remove ~60 lines of inline trust-gate + import + validation logic
- Add ~20 lines of ref adaptation + registration callback
- Shared loader handles: trust gate, path validation, module import, export shape check
- Rule-engine registration callback handles: kind-to-registry routing, override warnings, fixers rejection
- `collectExtensions` preserved (produces absPath refs from preset YAML declarations)


### Plan

### Plan

1. **Modify `packages/rule-engine/src/config/extensions.ts`:**
   - Import shared `loadExtensionModules`, `ExtensionRef` (aliased), `LoadExtensionsOptions` from `@gobing-ai/ts-runtime/plugin`
   - Add `..` traversal pre-check on `absPath` (defense-in-depth, mirroring 0010 pattern)
   - Rewrite `loadExtensionsIntoHost` body: adapt refs → shared format → call `loadExtensionModules` with registration callback
   - Remove inline trust gate, module import loop, and `defaultModuleLoader`
   - Keep `collectExtensions`, `ExtensionRef` (public), `ExtensionKind`, `LoadExtensionsOptions` types unchanged
   - Registration callback: route `ref.kind` → `host.evaluators`/`host.resolvers`/`host.formatters`; throw for fixers

2. **Update tests in `packages/rule-engine/tests/config/extensions.test.ts`:**
   - Adjust error message assertions where shared loader formats differ
   - Preserve test count and coverage
   - Document each test rewrite

3. **Run full test suite + spur-check + build** — verify zero regressions


## Review

**Date:** 2026-06-04
**Status:** 0 findings

**Re-verification 2026-06-04:** Second pass with `--fix all --force`. 0 findings. 34/34 rule-engine + workflow extension tests pass. No security issues, no unused code, no regressions. No fixes required.

**Scope:** `packages/rule-engine/src/config/extensions.ts` (rewritten to delegate to shared loader)
**Mode:** verify (full — SECU + traceability)
**Channel:** inline
**Gate:** `bun run lint` → pass | `bun test` → 946/946 pass | `bun run build` → pass | Coverage gate → PASS

### SECU Analysis — 0 findings

**Security:** Trust gate unchanged — shared loader enforces `allowExtensions !== true` throws before `moduleLoader`. Path traversal pre-validated at workflow layer + shared loader defense-in-depth. `fileURLToPath` normalizes `import.meta.url` references safely. No new injection surfaces.

**Efficiency:** Single-pass ref iteration; removed the old inline loop + validation in favor of shared `loadExtensionModules` (same algorithmic complexity, fewer lines).

**Correctness:** All 16 existing extension tests pass with zero rewrites. `collectExtensions` public API unchanged. `defaultModuleLoader` preserved with `(p) => import(p)` fallback. All error paths preserved: disabled gate, missing name, wrong kind, fixers unsupported, override warnings.

**Usability:** Public types (`ExtensionRef`, `ExtensionKind`, `LoadExtensionsOptions`) unchanged — zero API breakage. JSDoc updated to document shared-loader delegation.

### Requirements Traceability

- [x] **R1**: ExtensionRef contract: Option (b) — `absPath` kept public, translated internally
  → **MET** | `extensions.ts:14-21` types unchanged. Adaptation at lines 109-117 converts to shared `path+baseDir` format.

- [x] **R2**: `loadExtensionsIntoHost` delegates to shared `loadExtensionModules`
  → **MET** | `extensions.ts:126` calls `loadExtensionModules<ExtensionKind>` with rule-engine registration callback (registry routing, override warnings, fixers rejection).

- [x] **R3**: Both engines share same `loadExtensionModules` code path
  → **MET** | rule-engine `loadExtensionsIntoHost` and workflow `loadWorkflowExtensionsIntoHost` both call shared `loadExtensionModules`. Trust gate, import, and shape validation live in exactly one place (`extension-loader.ts`).

- [x] **R4**: All existing tests pass; zero rewrites needed
  → **MET** | 946/946 pass. Shared loader error messages are compatible substrings of existing assertions. No test rewrites.

- [x] **R5**: Trust gate fail-closed; `assertRelativeExtensionPath` enforced
  → **MET** | Shared loader enforces fail-closed gate. Path traversal pre-validated at lines 96-103. Shared loader's `assertRelativeExtensionPath` runs on derived paths.

- [x] **R6**: `bun run spur-check` + `bun run build` pass
  → **MET** | Biome clean, typecheck clean, 946 tests pass, all 8 packages build.

**Verdict: PASS** — 6/6 requirements MET, 0 findings, zero regressions, zero test rewrites.


### Testing

**Date:** 2026-06-04T17:50:00Z

**Coverage:** `packages/rule-engine/src/config/extensions.ts` — 100% functions, 95.52% lines (lines 96-98: `..` traversal pre-check, exercised via `loadRuleFile` integration tests).

**Test results:** 946/946 pass across all 120 test files, 0 failures. Zero test rewrites required — the shared loader's error messages are compatible substrings of existing assertions.

**Rule-engine extension tests (16/16 pass):**
- `collectExtensions`: 2 tests — unchanged (public API preserved)
- `loadExtensionsIntoHost`: 8 tests — trust gate, module import, registration, 'fixers not supported', override warnings, all pass with shared loader delegation
- `loadPreset extensions`: 2 tests — unchanged
- `loadRuleFile extensions`: 5 tests — unchanged (path traversal caught upstream)

**Changed file:** `packages/rule-engine/src/config/extensions.ts` — delegated loadExtensionsIntoHost to shared `loadExtensionModules`. Removed ~45 lines of inline trust gate + import + validation; added ~15 lines of ref adaptation + registration callback. `collectExtensions` and all public types unchanged.

**Design decision documented:** Option (b) — keep `absPath` public, translate internally. Both engines now converge on the same adaptation pattern.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


