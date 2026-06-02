---
name: "rule-engine: unify evaluator file-scanning seam + engine dedup"
description: "rule-engine: unify evaluator file-scanning seam + engine dedup"
status: Backlog
created_at: 2026-06-02T15:07:49.501Z
updated_at: 2026-06-02T15:07:49.501Z
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

## 0004. "rule-engine: unify evaluator file-scanning seam + engine dedup"

### Background

Architectural refactor cluster surfaced by the review in task 0002 (findings #3,#4,#5,#6,#7) and the code-improvement pass (Candidate 1 'FileScanEvaluator seam' + Candidate 2 'engine evaluate/evaluateWithFixes dedup'). Five line-scanning evaluators (regex, forbidden-import, secrets-scanner, import-boundary, tsdoc-export) repeat a discover→read→split→iterate skeleton, and that repetition has ALREADY drifted into three different file-scoping semantics (loose matchesAny vs strict matchesGlob re-filter vs both) — a correctness hazard, not just duplication. Split out from 0002 (mechanical fixes) because this is design work, multi-day, touching the evaluator layer + engine + file-utils. Reviewer recommendation: do these together in one scanFiles pass, not piecemeal.


### Requirements

1. Introduce a single file-scan seam in file-utils.ts (e.g. scanFiles(rule, context, perLine) or an abstract FileScanEvaluator) that owns discovery + ONE documented scoping rule (strict matchesGlob over rule.include/exclude, with the loose .ts-suffix convenience folded in explicitly) + line iteration. CAVEAT: import-boundary scans per-boundary (N globs x files), not per-rule — the seam must take scope as a parameter, not assume one scope per rule. (#3, Candidate 1). 2. Migrate regex, forbidden-import, secrets-scanner, import-boundary, tsdoc-export onto the seam; each evaluator shrinks to its matcher. Behavior for existing rules must not change — same findings for same inputs (#3, #6). 3. tsdoc-export double-scoping (discoverFiles hardcoded include + separate matchesGlob) collapses into the seam (#6). 4. Extract one parseInlineFlags helper for the (?i)->JS-flags folding, replacing the 3 divergent copies in regex-evaluator, secrets-scanner, fixers (#5). 5. Hoist escapeRegExp and stringArray to file-utils.ts, removing the verbatim copies (#7). 6. engine.ts: implement evaluate() as a thin delegate to evaluateWithFixes(rules, workdir, 'none') OR extract a shared evaluateRule helper, removing the copy-pasted loop + error-finding block (#4, Candidate 2). 7. Tests: a focused file-scoping test suite asserts the unified semantics once; per-evaluator suites then exercise only the matcher; engine error-finding semantics tested in one place; full bun run spur-check + bun run build pass with no behavior change to existing rule fixtures.


### Q&A



### Design



### Solution



### Plan



### Review



### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


