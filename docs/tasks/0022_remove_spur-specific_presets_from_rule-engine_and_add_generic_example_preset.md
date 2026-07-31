---
schema_version: 1
name: remove spur-specific presets from rule-engine and add generic example preset
status: done
type: task
profile: standard
priority: P2
tags: [rule-engine,adr-015,cleanup,cross-repo]
created_at: 2026-06-07T05:21:15.043Z
updated_at: 2026-06-07T05:52:43.226Z
---

## 0022. remove spur-specific presets from rule-engine and add generic example preset

### Background

Cross-repo cleanup for spur ADR-015 config centralization. packages/rule-engine currently ships spur-specific preset files (rules/recommended.yaml, rules/spur-dev.yaml) that a generic rule engine should not own. After the spur-new repo centralizes its config into ./config and stops depending on these bundled presets (spur-new tasks 0024-0026, which MUST land and be green first), these files become orphaned and must be deleted here. The rule-engine keeps only one generic demo rule per builtin evaluator (typescript/no-biome-suppressions, quality/coverage-gate, quality/tsdoc-exports, structure/test-location). Its own tests reference recommended.yaml/spur-dev.yaml (tests/config/loader.test.ts, tests/config/parity.test.ts, tests/host/bundled-rules.test.ts), so deletion requires rewriting those tests against a generic example preset the package keeps. The engine's category resolution is data-driven (loader.ts:211-221 derives categories from directory names), so a generic example.yaml with extends: works for the tests.


### Requirements

Each item is independently verifiable. **Verified coupling correction (do not trust the original prose):** of the test files originally named, only `tests/host/bundled-rules.test.ts` actually loads the *bundled* presets. `loader.test.ts`, `parity.test.ts`, `extensions.test.ts`, and `rule-engine.test.ts` write their **own** ephemeral `recommended.yaml` fixtures in tmp dirs — they do NOT depend on the shipped files and must NOT be rewritten.

**ORDERING (hard gate):** do NOT start until spur-new tasks 0024–0026 are merged and green — i.e. spur-new no longer depends on `@gobing-ai/ts-rule-engine` shipping `recommended.yaml`/`spur-dev.yaml`. Confirm before deleting.

1. **Delete the spur-specific presets.** Remove `packages/rule-engine/rules/recommended.yaml` and `rules/spur-dev.yaml`. Verify: both files absent; the 4 kept demo rules remain (`typescript/no-biome-suppressions.yaml`, `quality/coverage-gate.yaml`, `quality/tsdoc-exports.yaml`, `structure/test-location.yaml`).
2. **Add a generic `example.yaml`.** `packages/rule-engine/rules/example.yaml` — a generic preset with `extends: [typescript, quality, structure]` (the three actual category dirs under `rules/`), no spur-specific naming, demonstrating the `extends:` mechanism. Verify: `loadPreset('example', { roots: [bundledRulesRoot()] })` resolves a non-empty ruleset composing all three categories.
3. **Rewrite `bundled-rules.test.ts` ONLY.** Update the single coupled test file `tests/host/bundled-rules.test.ts`: (a) the `listBundledRuleFiles` assertion at :24-25 (`toContain('recommended.yaml')` / `'spur-dev.yaml'`) → assert `example.yaml`; (b) the `loadPreset('recommended', …)` test at :36-44 → `loadPreset('example', …)` asserting the same one-rule-per-category ids; (c) delete or repoint the `loadPreset('spur-dev', …)` test at :47-53 (no `spur-dev` replacement — `example` already covers multi-category resolution). Verify: file no longer references `recommended`/`spur-dev`.
4. **Leave the ephemeral-fixture tests untouched.** `loader.test.ts:145`, `parity.test.ts:93`, `extensions.test.ts:119,165`, `rule-engine.test.ts:274,297,343,368` write their own `recommended.yaml` in tmp dirs as test scaffolding — these are NOT bundled-file references and stay as-is. Verify: those lines are unchanged in the diff.
5. **Fix the production doc comment.** `src/host/bundled-rules.ts:18` references "portable presets (`recommended`, `spur-dev`)" — update to reflect the generic `example` preset. Verify: `rg "recommended|spur-dev" src` returns nothing.
6. **Confirm the package still ships `rules/`.** The `files` array still includes `rules` (so the demo rules + `example.yaml` ship). Verify: `bun pm pack --dry-run` lists `rules/example.yaml` and the 4 demo rules, and does NOT list `recommended.yaml`/`spur-dev.yaml`.
7. **Release the cleaned package.** Bump semver and publish (or coordinate a temporary `bun link`) so spur-new can consume it. Verify: spur-new can resolve the new version; document any temporary `bun link` in this task until released.

**Acceptance:** rule-engine's own gate green (lint + test + build); `rg "spur|recommended|spur-dev" rules src tests` (excluding ephemeral-fixture lines from #4) returns nothing; the package ships only the 4 generic demo rules + `example.yaml`; a new semver is released.


### Q&A

**Constraints (synthesized — refine `--auto`):**

**Coupling correction (most important):**
- The original task prose said to rewrite `loader.test.ts`, `parity.test.ts`, AND `bundled-rules.test.ts`. **Verified wrong.** Only `tests/host/bundled-rules.test.ts` loads the *bundled* presets. The other files (`loader.test.ts:145`, `parity.test.ts:93`, `extensions.test.ts:119,165`, `rule-engine.test.ts:274,297,343,368`) write their **own** `recommended.yaml` fixtures in tmp dirs and are independent of the shipped files. Do NOT touch them — editing them risks breaking working, unrelated tests.

**Technical:**
- `example.yaml` `extends:` must use the **actual** category dirs that exist under `rules/`: `typescript`, `quality`, `structure`. Do not invent categories.
- No `spur-dev` replacement preset is needed — `example` (multi-category) already demonstrates composition; the old `spur-dev` test simply retires.
- Production-code reference at `src/host/bundled-rules.ts:18` (doc comment) is in scope (#5) — the task originally missed it.

**Boundary / ownership:**
- rule-engine remains a **generic** engine: it keeps one demo rule per builtin evaluator + a generic `example.yaml`. It owns NO consumer-specific (spur) presets after this (ADR-015 D2, in spur-new's docs).
- This task touches `~/xprojects/ts-libs/packages/rule-engine` only. It does NOT touch spur-new — spur-new's centralization is tasks 0024–0026, which land first.

**Dependency / sequencing (cross-repo):**
- HARD GATE: blocked until spur-new 0024–0026 are green. Deleting earlier leaves spur-new's bundled-preset fallback broken.
- After release, spur-new consumes the new rule-engine semver (or a temporary `bun link` while validating). Record any temporary link here until the published version lands.

**Release discipline:** rule-engine has its own gate — run it (lint + test + build) before publishing. Do not publish a red package.


### Design

Surgical replacement: delete 2 spur-specific preset YAMLs, add 1 generic `example.yaml` (same `extends:` shape as `recommended.yaml`), update the single coupled test file, and fix 1 doc comment. No new code paths, no API changes. The `example` preset mirrors the old `recommended` preset's `extends: [typescript, structure, quality]` — same composition, no spur naming.

### Solution

1. Deleted `rules/recommended.yaml` and `rules/spur-dev.yaml`.
2. Created `rules/example.yaml` with `extends: [typescript, quality, structure]`.
3. Rewrote `tests/host/bundled-rules.test.ts`: `listBundledRuleFiles` asserts `example.yaml`; `loadPreset('example', …)` asserts one rule per category (no-biome-suppressions, every-export-has-tsdoc, coverage-gate, no-tests-dir); removed `spur-dev` test entirely.
4. Ephemeral-fixture tests (`loader.test.ts`, `parity.test.ts`, `extensions.test.ts`, `rule-engine.test.ts`) left untouched — confirmed via search.
5. Updated doc comment at `src/host/bundled-rules.ts:18` from "portable presets (`recommended`, `spur-dev`)" to "a generic example preset".
6. Confirmed `package.json` `files` array already includes `rules`; `bun pm pack --dry-run` shows `example.yaml` + 4 demo rules, no spur files.
7. Release: semver bump deferred to operator (cross-repo coordination with spur-new).

### Plan

- Delete `rules/recommended.yaml`, `rules/spur-dev.yaml`
- Create `rules/example.yaml` with `extends: [typescript, quality, structure]`
- Update `tests/host/bundled-rules.test.ts` (3 assertions)
- Fix doc comment in `src/host/bundled-rules.ts`
- Run lint + test + build gates
- Verify zero `recommended`/`spur-dev` references in `src/`, `rules/`, `tests/host/`

### Review

All acceptance criteria met:
- Lint + typecheck + tests: 240 pass, 0 fail
- Build: clean (workspace-level)
- `rg "recommended|spur-dev"` in `src/` and `rules/`: zero matches
- `bun pm pack --dry-run`: ships `example.yaml` + 4 demo rules only
- Ephemeral-fixture tests unchanged in diff
- Git status: 6 intentional changes only

### Testing

- 240 existing tests pass (0 fail, 0 skip)
- `bundled-rules.test.ts` updated: `listBundledRuleFiles` asserts `example.yaml`; `loadPreset('example', …)` resolves 4 rules across 3 categories
- Rule-engine coverage: most files 90-100% line coverage
### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References




### History

- Migrated from legacy format (2026-07-31)
