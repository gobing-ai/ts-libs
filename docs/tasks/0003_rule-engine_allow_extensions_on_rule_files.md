---
name: "rule-engine: allow extensions on rule files"
description: "rule-engine: allow extensions on rule files"
status: Done
created_at: 2026-06-02T14:56:32.779Z
updated_at: 2026-06-02T15:45:16.159Z
folder: docs/tasks
type: task
feature-id: ""
priority: medium
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0003. "rule-engine: allow extensions on rule files"

### Background

Today only preset files (PresetDefinitionSchema, src/types.ts:241-258) may declare an 'extensions' block; rule files (ConstraintRuleFileSchema, src/types.ts:215-221) cannot. collectPresetExtensions (config/extensions.ts:44) is preset-specific only by naming, not by logic. Discussed in review of 0002: adding extensions to rule files (scope item ①) is low-cost and reuses existing plumbing; per-file capability self-scoping (items ②/③) was rejected as premature — the host-global registry and downward preset composition via extends stay as-is. The existing allowExtensions trust gate (extensions.ts:77-82) must remain unchanged: rule-file extensions get NO weaker trust treatment than preset extensions.


### Requirements

- [x] **R1 — ConstraintRuleFileSchema accepts `extensions`** → **MET** | `types.ts` shared `ExtensionsSchema` (resolvers/evaluators/fixers/formatters of `relativeExtensionPath`) on `ConstraintRuleFileSchema`; `ConstraintRuleFile.extensions?` added.
- [x] **R2 — single-rule schema does NOT gain extensions** → **MET** | `ConstraintRuleSchema` unchanged; test "single-rule file declares no extensions" asserts `extensions: []`.
- [x] **R3 — loadRuleFile threads extension refs out** → **MET** | `loader.ts` `loadRuleFile` returns `LoadedPreset` (`{rules, extensions}`); collects via `collectExtensions(basename, dirname, parsed.extensions)`. (Breaking change, operator-approved.)
- [x] **R4 — generalize collectPresetExtensions → collectExtensions** → **MET** | renamed in `extensions.ts` (`sourceName`/`sourceDir`); both preset path (loader.ts:66,130) and rule-file path call it.
- [x] **R5 — both extensions sub-objects `.strict()`** → **MET** | shared `ExtensionsSchema.strict()` used by both; test "rejects an unknown key (strict)" passes.
- [x] **R6 — allowExtensions gate unchanged; host-global registry; no per-file scoping** → **MET** | `loadExtensionsIntoHost` logic byte-for-byte unchanged (diff = doc comment only); test confirms `allowExtensions:false` throws for rule-file ref.
- [x] **R7 — tests: load, traversal-reject, strict-reject, allowExtensions:false throws** → **MET** | 5 new tests in `extensions.test.ts` (incl. single-rule edge); 16/16 pass.

### Gate
`bun run spur-check` PASS · `bun run build` PASS · diff = schema + loader + extensions + caller-test updates + README.


### Q&A



### Design

## Design

- Scope: give rule files the same `extensions` capability presets already have, with
  identical trust treatment. Net-new feature in `packages/rule-engine` (schema + loader
  + extensions helper + tests).
- Key decision: **break the public API for symmetry** (operator-approved). `loadRuleFile`
  changes from `Promise<ConstraintRule[]>` → `Promise<LoadedPreset>` (`{rules, extensions}`),
  matching `loadPreset`. `collectPresetExtensions` → `collectExtensions(sourceName, dir, ext)`.
  Pre-1.0 (v0.2.8), so acceptable under semver-zero; commit carries a BREAKING CHANGE footer.
- Schema: extract the shared `extensions` zod sub-object (with `relativeExtensionPath`
  no-traversal/no-absolute refinement) into one `ExtensionsSchema` constant, reused by
  both `ConstraintRuleFileSchema` and `PresetDefinitionSchema`. Both stay `.strict()` via
  the shared definition — a typo'd key throws (R5). Single-rule `ConstraintRuleSchema` is
  NOT given extensions (R2).
- Trust boundary unchanged (R6): `loadExtensionsIntoHost`'s `allowExtensions` gate and the
  host-global registry are untouched. Rule-file extensions flow through the exact same
  `ExtensionRef` → `loadExtensionsIntoHost` path as preset extensions — no weaker treatment,
  no per-file scoping.
- Boundaries affected: `src/types.ts` (shared ExtensionsSchema + ConstraintRuleFile.extensions),
  `src/config/extensions.ts` (rename), `src/config/loader.ts` (loadRuleFile return shape +
  collectExtensions call), and all `loadRuleFile`/`collectPresetExtensions` test call sites.
- Risks: breaking-change blast radius is contained (callers are all in-package tests, mapped:
  rule-engine.test.ts, loader.test.ts, schema-gaps.test.ts, extensions.test.ts). No other
  workspace package imports loadRuleFile. Gate (`spur-check`) catches any missed caller.


### Solution

## Solution

1. `types.ts`: extract `ExtensionsSchema` = the `.strict()` object of
   `resolvers/evaluators/fixers/formatters` arrays of `relativeExtensionPath`. Use it in
   both `PresetDefinitionSchema.extensions` and a new `ConstraintRuleFileSchema.extensions`.
   Add `extensions?: PresetExtensions` to the `ConstraintRuleFile` interface.
2. `extensions.ts`: rename `collectPresetExtensions` → `collectExtensions` (param `sourceName`
   replaces `presetName` in the ref's `presetName` field meaning — keep field name for
   compatibility within ExtensionRef, document it now means "declaring source").
3. `loader.ts`: `loadRuleFile` returns `LoadedPreset` (`{rules, extensions}`). It parses the
   file once, runs `ConstraintRuleFileSchema` to read `extensions`, calls
   `collectExtensions(basename, dirname(file), fileExtensions)`, and returns both. Preset
   path swaps `collectPresetExtensions` → `collectExtensions`.
4. Update all in-package callers/tests to the new return shape.
5. Tests (R7): rule-file extension collected + loaded into host; `..`-traversal rejected on
   a rule file; strict-mode unknown key throws; `allowExtensions:false` throws for a
   rule-file extension ref.


### Plan

## Plan

- [ ] Extract shared `ExtensionsSchema` in types.ts; add `extensions` to ConstraintRuleFile(+Schema)
- [ ] Rename collectPresetExtensions → collectExtensions (extensions.ts)
- [ ] loadRuleFile returns {rules, extensions}; wire collectExtensions in both paths (loader.ts)
- [ ] Update all loadRuleFile / collectPresetExtensions callers + tests
- [ ] Add R7 tests: load, traversal-reject, strict-key-reject, allowExtensions:false throws
- [ ] Gate: `bun run spur-check` + `bun run build` green; diff intentional only


### Review

Verification 2026-06-02 (Phase 7 + 8). **Verdict: PASS.**

**Status:** 1 advisory (P4), 0 blocking findings
**Scope:** 0003 diff (7 files, +171/-45), `packages/rule-engine`
**Mode:** verify (full)
**Channel:** inline (current)
**Gate:** `bun run spur-check` → PASS (0/0/0) · `bun run build` → PASS (8 pkgs) · extensions suite 16/16

#### Phase 7 — SECU on the change set

- **Security:** Core risk was weakening the extension trust boundary. R6 verified — `loadExtensionsIntoHost` + `allowExtensions` gate are byte-for-byte unchanged (only a doc comment differs). Rule-file refs flow through the identical `ExtensionRef` → gate path; traversal/absolute-path rejection is now the *shared* `ExtensionsSchema`, so rule files inherit the same protection as presets. Test proves `allowExtensions:false` throws for a rule-file ref. No weakening.
- **Correctness:** Single-rule files correctly yield `extensions: []` (file-shape safeParse fails → empty). Strict `.strict()` rejects typo'd keys; `..`/absolute paths rejected. All 4 R7 scenarios covered.
- **Efficiency:** `loadRuleFile` parses `raw` twice (once via `normalizeRuleFile`, once via `ConstraintRuleFileSchema.safeParse` for extensions). Load-time only, O(1) extra parse per file — acceptable. → P4 below.
- **Usability:** Breaking API change (return shape + rename) documented in README; API is now symmetric with `loadPreset` (the task's goal).

#### P4 — Suggestions
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | `loadRuleFile` double-parses the raw file | Efficiency | `config/loader.ts:113-122` | Minor: `normalizeRuleFile` and the extensions `safeParse` each parse `raw`. Could thread the parsed result through once. Not worth the added coupling now; load-time path. |

#### Verdict
**PASS.** All 7 requirements met with evidence; trust boundary provably intact; gate green. Breaking change is intentional and operator-approved; needs BREAKING CHANGE footer on commit.


### Testing

## Testing

- Date: 2026-06-02
- Command: `bun test packages/rule-engine/tests/config/extensions.test.ts` then full `bun run spur-check` + `bun run build`
- Scope: rule-file extension load/collect/trust-gate/traversal/strict-key (R7); breaking-API caller updates across 4 test files; full monorepo gate.
- Result: PASS — extensions suite 16 pass / 0 fail (11 existing + 5 new R7); `spur-check` exit 0 (0/0/0, both presets); `build` exit 0 for all 8 packages. `extensions.ts` 100% coverage.
- Evidence: new tests — "collects extension refs declared by a rule file", "rule-file extensions flow through the same allowExtensions trust gate" (rejects with `extensions are disabled`), "rejects a rule-file extension path that traverses out" (`".." traversal`), "rejects an unknown key (strict)", "single-rule file declares no extensions". Caller updates: loadRuleFile now returns `{rules, extensions}` — fixed loader.test/schema-gaps.test/rule-engine.test; collectPresetExtensions→collectExtensions in extensions.test.
- Next action: none — gate clean. Breaking change (loadRuleFile return shape; collectExtensions rename) needs BREAKING CHANGE footer on commit.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


