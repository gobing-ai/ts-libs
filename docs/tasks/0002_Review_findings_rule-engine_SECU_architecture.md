---
name: "Review findings: rule-engine SECU + architecture"
description: "Review findings: rule-engine SECU + architecture"
status: Done
created_at: 2026-06-02T14:14:12.809Z
updated_at: 2026-06-02T15:28:10.851Z
folder: docs/tasks
type: task
feature-id: ""
impl_progress:
  planning: pending
  design: pending
  implementation: pending
  review: pending
  testing: pending
---

## 0002. "Review findings: rule-engine SECU + architecture"

### Background

Source-oriented review of packages/rule-engine via /rd3:dev-review --focus all. Architecture pass (code-improvement) + SECU pass (code-verification).

#### Review Findings — 2026-06-02

**Status:** 8 findings (0 P1 · 2 P2 · 4 P3 · 2 P4)
**Scope:** `packages/rule-engine/src` (25 modules, ~2000 LOC)
**Mode:** source (`/rd3:dev-review --focus all --auto`)
**Channel:** inline (current)
**Gate:** `bun run lint` → pass · `bun test packages/rule-engine` → 197 pass / 0 fail

No P1 blockers. No hardcoded secrets, no SQLi/XSS surface (non-web library), no
empty catch blocks, no `any`, no shell-string command construction (process-backed
evaluators pass `args[]` arrays, not concatenated strings). Dynamic `import()` in
`config/extensions.ts` is gated behind an explicit `allowExtensions` trust flag with
`..`-traversal rejection at the schema layer — correct.

##### P1 — Blockers

_None._

##### P2 — Warnings

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Unbounded user-config regex → ReDoS | Security | `evaluators/regex-evaluator.ts:23`, `secrets-scanner-evaluator.ts:101-107`, `forbidden-import-evaluator.ts:126-128`, `import-boundary-evaluator.ts:122` | Rule config compiles arbitrary patterns via `new RegExp(userPattern)` with no complexity bound. A catastrophic-backtracking pattern (or one matched against a very long minified line) can hang the evaluator. Rules are trusted config (`.spur/rules/`-style), so risk is bounded — but a shared/published rule pack widens the trust boundary. Mitigate: run line scans with a per-file/per-line timeout (the package already has `ProcessExecutor` timeouts as precedent), or cap line length before `.test()`, or document the trust assumption explicitly in the evaluator JSDoc. |
| 2 | `parseLcov` accepts NaN coverage counts | Correctness | `evaluators/coverage-gate-evaluator.ts:111-114,84-87` | `Number(trimmed.slice(3))` on a malformed `LF:`/`LH:` line yields `NaN`. The `cov.linesFound === 0` guard (`:78`) does not catch `NaN`, so `Math.round(NaN/NaN)` → `NaN`, `NaN >= threshold` → false → a spurious "below-threshold" finding against a file with unparseable coverage. Guard with `Number.isFinite(linesFound) && linesFound > 0` and skip/flag malformed records. |

##### P3 — Info

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 3 | Three divergent file-scoping semantics | Correctness | `regex-evaluator.ts:24`, `forbidden-import-evaluator.ts:89-91`, `tsdoc-export-evaluator.ts:54-59` | "Which files does this rule apply to?" resolves differently per evaluator: loose `matchesAny` (substring/suffix) vs. strict `matchesGlob` re-filter vs. both. Same `include` glob can select different file sets depending on evaluator type — surprising and bug-prone. See architecture Candidate 1: unify behind a single `scanFiles` seam in `file-utils.ts` with one documented scoping rule. |
| 4 | `evaluate` / `evaluateWithFixes` duplicated loop | Maintainability | `engine.ts:43-62` vs `:76-128` | The rule loop, enabled-check, and try/catch→error-finding block are copy-pasted. `evaluate` is `evaluateWithFixes(rules, workdir, 'none')` — `effectiveFixMode(_, 'none')` already returns `'none'`. Implement `evaluate` as a thin delegate so error-finding semantics live in one place. |
| 5 | Inline-flag `(?i)` folding implemented 3 ways | Maintainability | `regex-evaluator.ts:64`, `secrets-scanner-evaluator.ts:101`, `fixers/fixers.ts:274` | Three subtly different parsers for "fold a leading `(?i)` group into JS flags." A flag-handling fix won't propagate. Extract one `parseInlineFlags` helper. |
| 6 | `tsdoc-export` discovers with hardcoded include, re-filters separately | Correctness | `evaluators/tsdoc-export-evaluator.ts:52-59` | `discoverFiles({ include: ['.ts','.tsx'] })` ignores `rule.include` at discovery, then re-applies `rule.include` via `matchesGlob`. Works today (the `.ts` suffix superset covers it) but the double-scoping is a latent trap if discovery's include semantics change. Fold into the Candidate-1 `scanFiles` seam. |

##### P4 — Suggestions

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 7 | `escapeRegExp` / `stringArray` duplicated verbatim | Maintainability | `forbidden-import-evaluator.ts:131,142`, `import-boundary-evaluator.ts:133`, `secrets-scanner-evaluator.ts:110` | Identical pure helpers in 3+ files. Hoist to `file-utils.ts` (opportunistic — bundle with Candidate 1's pass; do not refactor standalone). |
| 8 | Empty no-op constructors | Usability | `regex-evaluator.ts:12`, `secrets-scanner-evaluator.ts:48`, `formatters/text.ts:5`, `formatters/json.ts:5`, `tsdoc-export-evaluator.ts:40` | Several `constructor() {}` (one with a "V8 function coverage requires explicit constructor" comment). If only present to satisfy a coverage tool, that's a tooling smell worth confirming — otherwise removable noise. Leave if the coverage-gate genuinely needs them. |


### Requirements
## Requirements

Scope: **mechanical / low-risk fixes only.** Refactor cluster (#3–#7) → task 0004.

- [x] **R1 — `parseLcov` NaN guard** → **MET** | Evidence: `coverage-gate-evaluator.ts:111-114,131-135` (`parseCount` + skip at `end_of_record`); regression test `coverage-gate-evaluator.test.ts` "skips records with malformed counts instead of reporting NaN coverage".
- [x] **R2 — empty constructors (investigate → decide)** → **MET** | Decision: KEEP all (each load-bearing for V8 function-coverage gate; removal fails `bun run test`). Rationale comments added to all empty constructors (`formatters/{json,text}.ts`, `resolvers/test-path-resolver.ts`, `evaluators/{regex,secrets-scanner,tsdoc-export}-evaluator.ts`). Decision recorded in Solution.
- [x] **R3 — ReDoS document-only** → **MET** | Evidence: class JSDoc trust-assumption notes in `regex-evaluator.ts`, `secrets-scanner-evaluator.ts`, `forbidden-import-evaluator.ts`, `import-boundary-evaluator.ts`; verified comment-only (no behavioral change). Hardening deferred → task 0003.

Out of scope (→ 0004): #3 file-scoping, #4 engine dedup, #5 inline-flag folding, #6 tsdoc double-scoping, #7 duplicated helpers.

### Gate
`bun run spur-check` PASS · `bun run build` PASS · diff = R1/R2/R3 files only.


### Gate
`bun run spur-check` clean and `bun run build` succeeds — no test skipped, no
suppression added.


### Q&A



### Design

## Design

- Scope: three independent mechanical fixes in `packages/rule-engine` — `parseLcov`
  NaN guard (R1), empty-constructor cleanup (R2), ReDoS trust-assumption docs (R3).
- Key decision: keep all three local and behavior-preserving except R1 (which fixes a
  spurious-finding bug). The evaluator-layer refactor that findings #3–#7 imply is
  deliberately excluded → task 0004, to keep this task low-risk and gate-verifiable.
- Boundaries affected: `evaluators/coverage-gate-evaluator.ts` (R1);
  `formatters/{text,json}.ts`, `evaluators/{regex,secrets-scanner,tsdoc-export}-evaluator.ts`,
  `resolvers/test-path-resolver.ts` (R2, pending experiment);
  `evaluators/{regex,secrets-scanner,forbidden-import,import-boundary}-evaluator.ts`
  class JSDoc (R3). No public type or interface changes.
- Risks: R2 may regress V8 function-coverage on a specific file — mitigated by the
  spur-check coverage preset acting as the empirical decider. R1/R3 are low-risk.


### Solution

## Solution

Mechanical-only scope (refactor cluster lives in 0004). Three independent changes:

**R1 — `parseLcov` NaN guard** (`coverage-gate-evaluator.ts`)
`LF:`/`LH:` fields are parsed via a `parseCount` helper returning `number | null`
(null for non-finite or negative). At `end_of_record`, a record with either count
null is skipped entirely — a file whose coverage cannot be parsed no longer produces
a NaN-driven spurious below-threshold finding. Regression test added: a malformed
`LF:not-a-number` record is skipped while a valid record alongside it still reports.

**R2 — empty constructors** (investigated → KEEP all, with rationale)
Empirical result: removing the no-op `constructor() {}` bodies dropped V8 *function*
coverage below the 0.9 `bunfig.toml` threshold for every method-light class — the
`bun run test` coverage gate failed (regex 80%, secrets-scanner 80%, tsdoc 85.71%,
formatters/json 50%, formatters/text 66.67%, test-path-resolvers 83.33%). V8 counts
the implicit constructor as an uncovered function, so classes with few methods need
the explicit empty constructor to clear the function-coverage gate. **Decision:** keep
all empty constructors; the original "V8 function coverage requires explicit
constructor" comment was correct. This change adds that same one-line rationale to
every previously-undocumented empty constructor so the next reader does not repeat
the experiment. No constructor was removed; no behavior changed.

**R3 — ReDoS document-only** (no behavior change)
Added a trust-assumption note to the class JSDoc of `RegexEvaluator`,
`SecretsScannerEvaluator`, `ForbiddenImportEvaluator`, `ImportBoundaryEvaluator`:
rule config is trusted input; user-supplied patterns are compiled with `new RegExp`
and run per line without a backtracking bound, so catastrophic-backtracking patterns
are the rule author's responsibility. Runtime hardening deferred (ties to external
rule-pack distribution, task 0003). No behavioral code change.

### R2 decision (filled after experiment)
KEEP all empty constructors — each is load-bearing for the V8 function-coverage gate
(verified: removal fails `bun run test`). Documented inline.


### R2 decision (filled after experiment)
_pending experiment_


### Plan

## Plan

- [ ] R1: add NaN/malformed guard to `parseLcov`; skip unparseable records
- [ ] R1: regression test — malformed lcov line produces no below-threshold finding
- [ ] R2: remove empty no-op constructors; run `bun run spur-check` coverage presets
- [ ] R2: keep only constructors the coverage gate provably needs; record decision
- [ ] R3: add trust-assumption JSDoc to the 4 pattern-compiling evaluators (no behavior change)
- [ ] Gate: `bun run spur-check` clean + `bun run build` succeeds; only intentional diffs


### Review

Verification 2026-06-02 (Phase 7 + 8). **Verdict: PASS.**

**Status:** 0 new findings — implementation verified
**Scope:** R1/R2/R3 diff (10 files, +74/-9), `packages/rule-engine`
**Mode:** verify (`--mode-verify full`)
**Channel:** inline (current)
**Gate:** `bun run spur-check` → PASS (0/0/0, 799 tests) · `bun run build` → PASS (8 pkgs)

#### Phase 7 — SECU on the change set

- **Security:** R1 parses lcov counts via `Number()` guarded by `Number.isFinite && >= 0` — no injection surface. R3 added trust-assumption JSDoc only (no code). No new secrets/exec/eval. Clean.
- **Efficiency:** R1 adds one O(1) `parseCount` per `LF:`/`LH:` line — no regression. Clean.
- **Correctness:** R1 fixes the targeted bug — malformed counts return `null`, the record is skipped at `end_of_record`, and `SF:` resets state so no partial leak into the next record. Covered by a new regression test. Clean.
- **Usability:** R2 constructor comments encode a non-obvious WHY (V8 function-coverage constraint) — correct comment discipline. R3 JSDoc improves trust-boundary clarity. Clean.

#### Findings: P1 none · P2 none · P3 none · P4 none

#### Verdict

**PASS.** All three requirements met with evidence; gate green; diff limited to the
three scoped changes plus one regression test. No scope drift (the #3–#7 refactor was
correctly excluded → task 0004). R2's "investigate" requirement was resolved
empirically: the coverage-gate experiment proved the empty constructors are
load-bearing; decision recorded in Solution.


### Testing

## Testing

- Date: 2026-06-02
- Command: `bun run spur-check` (lint + per-package typecheck + `bun test --coverage` + both spur rule presets) and `bun run build`
- Scope: full monorepo gate; R1 fix exercised by new coverage-gate regression test; R2 verified by coverage-gate pass/fail experiment; R3 is doc-only (typecheck + lint).
- Result: PASS — `spur-check` exit 0 (0 errors / 0 warnings, recommended + coverage-gate presets); 799 tests pass / 0 fail; coverage above 0.9 funcs/lines threshold; `build` exit 0 for all 8 packages.
- Evidence: new test `skips records with malformed counts instead of reporting NaN coverage` asserts a malformed `LF:` record yields no finding while a valid record still reports. R2 experiment: removing constructors dropped funcs coverage (regex 80%, secrets 80%, tsdoc 85.71%, formatters/test-path-resolver) → gate failed → constructors restored with rationale → gate green.
- Next action: none for implementation — gate clean, diff limited to R1/R2/R3 files (+74/-9).

#### Stage 5 post-flight (2026-06-02, --preset simple)

Change set committed on branch `fix/rule-engine-secu-mechanical`
(`12f6541` code, `95f8be6` tasks) over pre-commit SHA `be19eaa`. Post-flight
re-run against that start commit: `code-changes-exist` pass, `no-uncommitted-drift`
pass, `verification-verdict-pass` pass, mandatory subset pass → ready for `done`.


### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References

