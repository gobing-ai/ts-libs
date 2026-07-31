---
schema_version: 1
name: "rule-engine: unify evaluator file-scanning seam + engine dedup"
status: done
type: task
priority: P2
created_at: 2026-06-02T15:07:49.501Z
updated_at: 2026-06-02T17:48:14.448Z
---

## 0004. "rule-engine: unify evaluator file-scanning seam + engine dedup"

### Background

Architectural refactor cluster surfaced by the review in task 0002 (findings #3,#4,#5,#6,#7) and the code-improvement pass (Candidate 1 'FileScanEvaluator seam' + Candidate 2 'engine evaluate/evaluateWithFixes dedup'). Five line-scanning evaluators (regex, forbidden-import, secrets-scanner, import-boundary, tsdoc-export) repeat a discover→read→split→iterate skeleton, and that repetition has ALREADY drifted into three different file-scoping semantics (loose matchesAny vs strict matchesGlob re-filter vs both) — a correctness hazard, not just duplication. Split out from 0002 (mechanical fixes) because this is design work, multi-day, touching the evaluator layer + engine + file-utils. Reviewer recommendation: do these together in one scanFiles pass, not piecemeal.


### Requirements


- [x] **R1 — single scanFiles seam with explicit matchMode** → **MET** | `evaluators/file-utils.ts` exports `scanFiles({workdir, include, exclude, matchMode, fs})`; takes scope as a parameter so import-boundary's per-boundary scan composes.
- [x] **R2 — migrate 5 evaluators; same findings for same inputs** → **MET** | regex (loose), forbidden-import-simple (loose) / -structured (glob), secrets-scanner (loose), import-boundary (glob), tsdoc-export (glob + collapsed double-scoping). Per-evaluator suites green: 3, 6, 2, 10, 10 respectively — no test changed.
- [x] **R3 — tsdoc-export double-scoping collapsed** → **MET** | `evaluators/tsdoc-export-evaluator.ts:55` now a single `scanFiles(matchMode:'glob', include, exclude)` call; the previous `discoverFiles({include:['.ts','.tsx']})` + per-file `matchesGlob(rule.include/exclude)` is gone.
- [x] **R4 — parseInlineFlags replaces the 2 leading-group copies** → **MET** | `evaluators/file-utils.ts` exports `parseInlineFlags(source) → {flags, rest}`. Used by regex-evaluator.normalizePattern and secrets-scanner-evaluator.compile. The third site (fixers.flagsFromRule) is a different shape (whole-string `(?flags)` config field, not a pattern prefix) — recorded in the task as deliberate non-merge; see Solution.
- [x] **R5 — escapeRegExp + stringArray hoisted** → **MET** | Both in `file-utils.ts`; removed verbatim copies from forbidden-import-evaluator, import-boundary-evaluator, secrets-scanner-evaluator.
- [x] **R6 — engine evaluate() delegates to evaluateWithFixes** → **MET** | `engine.ts:43-50` is a thin delegate with `maxFixMode='none'`; the `effectiveFixMode(_, 'none')` short-circuit keeps fix code inactive. The copy-pasted loop and error-finding block now exist only in `evaluateWithFixes`.
- [x] **R7 — focused scanFiles scoping test; gate green** → **MET** | 7 new tests in `file-utils.test.ts` (3 parseInlineFlags + 4 scanFiles covering both modes). Full rule-engine 203/203; biome 100% clean on changed files; `bun run build` PASS.

### Gate
Per-evaluator suites green · full rule-engine 203/203 · biome clean on refactored files · `bun run build` PASS. (Pre-existing `.claude/settings.local.json` format issue trips `spur-check` on baseline `main`; unrelated to 0004.)


### Q&A



### Design

## Design

- Scope: remove the duplicated discover→filter→read scaffolding across 5 line-scanning
  evaluators and 3 helper copies, plus dedupe the engine loop. **Refactor — behavior
  must not change.**
- Key decision (operator-approved): the divergent file-SCOPING is preserved, not unified
  on strict. Three evaluators (regex, forbidden-import simple, secrets-scanner) use loose
  `matchesAny`; three use strict `matchesGlob`. Forcing all to strict would change
  file-selection for loose-pattern rules — a real behavior change. So `scanFiles` takes an
  explicit `matchMode: 'loose' | 'glob'` and each evaluator keeps its current mode. R1's
  "one scoping rule" is reinterpreted as "one seam with an explicit, documented mode" —
  the scaffolding is unified, the policy stays per-evaluator. This reconciles R1 with R2.
- Seam shape: `scanFiles({workdir, include, exclude, matchMode, fs}) → {file, content}[]`
  owns discovery + scope filtering (mode-aware) + read-each-once. Evaluators keep their
  own line/match logic (the matcher), which is genuinely per-evaluator and should not be
  abstracted into a callback (leaky). import-boundary calls `scanFiles` once with all
  files (no include) and applies its per-boundary globs itself — the seam takes scope as
  a param, so this composes (R1 caveat satisfied).
- Helpers (#5, #7): extract `parseInlineFlags` (the `(?i)`→JS-flags fold, 3 copies) and
  hoist `escapeRegExp` / `stringArray` into file-utils.ts; remove the verbatim duplicates.
- Engine (#4, #6/Candidate 2): `evaluate()` delegates to `evaluateWithFixes(rules, workdir,
  'none')` — `effectiveFixMode(_, 'none')` already short-circuits the fixer path — removing
  the copy-pasted loop + error-finding block.
- Boundaries affected: file-utils.ts (new scanFiles + hoisted helpers), 5 evaluator files,
  fixers.ts (use shared parseInlineFlags), engine.ts (evaluate delegate). Per-evaluator
  test suites must stay green unchanged (the behavior-preservation contract).
- Risks: HIGH for a refactor — behavior drift across 5 evaluators. Mitigation: per-evaluator
  mode preserves exact scoping; existing suites are the regression net; migrate one
  evaluator at a time, running its suite after each.


### Solution

## Solution

`scanFiles` seam in file-utils.ts owns discovery + scope-filter + read; evaluators keep
their matcher. Scoping mode is explicit (`matchMode: 'loose' | 'glob'`) to preserve each
evaluator's current behavior (operator decision — see Design; reconciles R1 "one seam"
with R2 "no behavior change"). Helpers `escapeRegExp`/`stringArray`/`parseInlineFlags`
centralized in file-utils.ts. engine `evaluate()` becomes a thin delegate. One evaluator
migrated + suite-verified at a time.


### Plan

## Plan

- [ ] Add `scanFiles({workdir, include, exclude, matchMode, fs}) → {file,content}[]` to file-utils.ts
- [ ] Hoist `escapeRegExp`, `stringArray`; add `parseInlineFlags` helper to file-utils.ts (#5,#7)
- [ ] Migrate regex-evaluator onto scanFiles (matchMode 'loose'); run its suite
- [ ] Migrate forbidden-import (simple='loose', structured='glob'); run its suite
- [ ] Migrate secrets-scanner (matchMode 'loose'); run its suite
- [ ] Migrate import-boundary (scanFiles all + per-boundary glob); run its suite
- [ ] Migrate tsdoc-export (matchMode 'glob', collapse double-scoping #6); run its suite
- [ ] fixers.ts: use shared parseInlineFlags; remove local flagsFromRule fold
- [ ] engine.ts: evaluate() → thin delegate to evaluateWithFixes(_, 'none') (#4)
- [ ] Add focused scanFiles scoping test; assert both modes once (#7)
- [ ] Gate: `bun run spur-check` + `bun run build` green; per-evaluator suites unchanged


### Review


Verification 2026-06-02 (Phase 7 + 8). **Verdict: PASS.**

**Status:** 0 P1, 0 P2, 1 P3 (advisory, behavior observation), 0 P4
**Scope:** 0004 refactor (8 files, +217/-82), `packages/rule-engine`
**Mode:** verify (full)
**Channel:** inline (current)
**Gate:** per-evaluator suites green; full rule-engine 203/203 + 0 fail; biome 100% on changed files; `bun run build` PASS (8 pkgs)

#### Phase 7 — SECU on the change set

- **Security:** scanFiles seam is the same discover+filter+read with a new wrapper; the extension trust gate is untouched (this task didn't touch extensions). No injection surface — paths still resolved via `NodeFileSystem` and existing `walkDir`. Clean.
- **Efficiency:** Incidental win on import-boundary — previous code called `readWorkdirFile` once per `(boundary, file)` pair; the seam reads each file once at scan time, then reuses content across all boundaries. Net reduction in file I/O for the boundary-heavy case. Clean.
- **Correctness:** Migration order was per-evaluator with suite-green-then-move-next. The double-scoping collapse in tsdoc-export (R3) is verified by its 10/10 suite — same findings for the same fixtures. The loose-mode decision for regex/secrets/forbidden-simple is exercised by the new file-utils tests (loose `.ts` matches `src/app.ts` but not `vendor/lib.js`). Engine error-finding semantics now live only in `evaluateWithFixes` (engine.test.ts via the integration path). Clean.
- **Usability:** Engine `evaluate()` delegate has a clear JSDoc explaining why it delegates. `parseInlineFlags` and `ScanMatchMode` types are documented. The seam is internal (file-utils is not in `index.ts`), so no public API surface change.

#### P3 — Info
| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Three evaluators still use loose scoping; future tooling may expect uniform | Usability | `evaluators/{regex,secrets-scanner,forbidden-import}-evaluator.ts` | Behavior preserved intentionally (R1 reconciled with R2; see Solution). Loose `matchesAny` accepts bare fragments like `src/`, `.ts`; users of these evaluators' rule packs may rely on this. If the project later wants strict-only, a separate task with its own behavior-change review (and a deprecation note for loose patterns) is the right path. |

#### Verdict
**PASS.** All 7 requirements MET with evidence; behavior preserved; trust boundary intact; gate clean. The R1/R2 tension was resolved by making the mode explicit rather than forcing strict. P3 advisory logged so a future strict-unification effort doesn't sneak in unexamined.


### Testing

## Testing

- Date: 2026-06-02
- Command: per-evaluator suite (after each migration) + full `bun test` (rule-engine) with coverage + `bun run build`
- Scope: behavior preservation across 5 migrated evaluators + engine dedup; new scanFiles + parseInlineFlags tests; coverage above 0.9 funcs/lines threshold.
- Result: PASS — every migrated evaluator suite green (regex 3/3, secrets 2/2, forbidden-import 6/6, import-boundary 10/10, tsdoc-export 10/10); file-utils 17/17 (incl. 7 new scanFiles/parseInlineFlags cases); full rule-engine suite 203 pass / 0 fail; engine dedup via evaluate→evaluateWithFixes('none') preserves error semantics (engine.test.ts 27/27 implicit in the full 203); `bun run build` exit 0 for all 8 packages. Coverage on migrated files: regex 100/100, secrets 100/91.8, tsdoc 100/100, import-boundary unchanged, forbidden-import unchanged. Biome 100% clean on the refactored files.
- Evidence: per-evaluator tests are the regression contract (no test changed). New scanFiles tests assert both `matchMode: 'loose'` and `matchMode: 'glob'` behavior in one focused suite so the seam's contract is documented independently of any evaluator.
- Note: `bun run spur-check` exits 1 on baseline `main` (pre-existing) due to `.claude/settings.local.json` format — verified unrelated to 0004 by `git stash` + retest; the user's local Claude config is the source. Refactor itself is biome-clean.
- Next action: none — gate clean for 0004, no test skipped, no suppression.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References




### History

- Migrated from legacy format (2026-07-31)
