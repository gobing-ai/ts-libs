---
schema_version: 1
name: Preserve program text when repairing built ESM imports
status: todo
template: feature-impl
created_at: 2026-10-12T07:17:17.408Z
updated_at: "2026-10-12T16:15:30.742Z"
feature_id: L1

priority: P2
ac_numbering: task-local
ac_altitude: graduating
estimate_hours: 3
---

## 0110. Preserve program text when repairing built ESM imports

### Background

The 2026-10-12 inline review of packages and scripts reproduced output corruption in scripts/lib/build.ts:82. rewriteSpecifiers runs three regular expressions over whole emitted programs; fixDistRoot at scripts/lib/build.ts:57 writes the result back to disk. With feature.js present, the source `export const text = "import('./feature')";` becomes `export const text = "import('./feature.js')";`, changing exported program data. Comments are rewritten too. The reproduction in /tmp/ts-libs-review-script-repro.ts invokes the real resolveSpecifier with the emitted-file set, so this is a confirmed defect rather than a hypothesis. No existing task owns this repair. Direct triage fixes already address the separate strict-glob suffix boundary and Node event-log date-directory rollover defects; neither changes this builder.

**Refine corrections (2026-10-12)**
- Parser dependency was assumed installed → package.json, bun.lock and installed TypeScript all resolve 6.0.3 → use that existing parser; no dependency change.
- Content-span edits omitted escaped specifier handling → AST text is decoded while source contents can contain escapes → append the resolved suffix to the original raw contents, preserving escapes and quote delimiters.
- Design did not freeze parser failure behavior → emitted programs must parse → reject parse diagnostics before writing the affected file rather than repair ambiguous syntax.

### Requirements

- [ ] R1. Replace whole-program regex matching with syntax-aware selection of actual relative static import/export and string-literal dynamic import module specifiers; preserve all other source text byte for byte.
- [ ] R2. Keep resolveSpecifier and fixDistRoot behavior: known file/index modules gain .js or /index.js, existing extensions and unresolved or external specifiers remain unchanged, and unchanged files are not rewritten.
- [ ] R3. Add unit and temporary-dist integration regressions proving import-shaped strings, comments, regex literals and template text stay unchanged while real imports are repaired; run both repository gates.

### Acceptance Criteria

- [ ] AC1 — Non-module text survives repair (req: R1)
  Given matching import-shaped ordinary strings, comments, regex literals and template text alongside real static imports, re-exports and literal dynamic imports, when rewriteSpecifiers runs, then only the actual module specifier contents change and template interpolation containing a real dynamic import is still visited.
- [ ] AC2 — Resolver semantics stay compatible (req: R2)
  Given direct-file and directory-index emitted modules, existing .js extensions and missing or external modules, when fixDistRoot runs, then only known extensionless relative references gain the appropriate extension and a second run is byte-identical.
- [ ] AC3 — Runtime output and gates verify the repair (req: R3)
  Given a temporary dist entry exporting import-shaped text and loading an actual sibling, when repaired and imported, then the exported text equals its original value and the sibling loads; bun test scripts/tests/build.test.ts, bun run spur-check and bun run build exit 0.

### Q&A

<!-- CLOSED decisions from refinement: what was chosen and why, what was deferred and on what
     condition. Not a parking lot for open questions — an unanswered question here means the task
     is not ready to hand off. Keep empty if none. -->

#### Q&A entry — 2026-10-12T16:15:30.300Z

Q: Parser or more regexes? A: Existing TypeScript 6.0.3, with targeted span edits and no printer. Scripts already owns platform APIs.

Q: Escape semantics and malformed programs? A: Preserve original raw literal contents for resolver suffixes, safely quote arbitrary callback results, and fail on parse errors before writing that file. Computed/backtick imports are outside the existing quoted-literal contract.

Q: Dependencies or release changes? A: None. This internal repair uses current tooling and does not change the package graph or release workflow.

### Design

Use the already installed TypeScript devDependency to parse emitted JavaScript (createSourceFile with ScriptKind.JS) and visit ImportDeclaration, ExportDeclaration with moduleSpecifier, and CallExpression with ImportKeyword and a string-literal first argument. Collect edits only for relative specifiers whose existing resolveSpecifier result differs. Apply content-span replacements in descending offset order so the original quotes, whitespace, comments and every unrelated byte remain intact. Do not print/reformat the AST. Keep the exported rewriteSpecifiers signature, SpecifierResolver callback, emitted-file lookup and disk write lifecycle unchanged. Targets: scripts/lib/build.ts and scripts/tests/build.test.ts only. Reject more regex exceptions because JavaScript strings/templates/comments make lexical matching fragile; reject a new parser dependency because TypeScript is already installed; reject an AST printer because it needlessly rewrites output formatting. No ADR or dependency graph change is required. This task repairs internal build tooling, not a public library surface.

Freeze remaining details: include side-effect imports and export-star declarations. Only quoted StringLiteral arguments are eligible; computed imports and backtick template specifiers remain unchanged. Visit children recursively so real imports inside template interpolations are selected. Call the resolver only for decoded relative literals. For resolveSpecifier's suffix-only .js or /index.js result, append that suffix to the original raw literal contents so escapes survive. For other custom callback results, encode the returned value safely for the existing quote; tests cover quotes/backslashes. Parse with ScriptTarget.Latest, ScriptKind.JS; throw on parse diagnostics before fixDistRoot writes that file. Syntax failures may leave earlier files repaired (existing sequential write lifecycle); no atomic directory transaction is promised. Keep SpecifierResolver internal and the existing function exports unchanged: no new API. Current callers are fixDistRoot, scripts/builder.ts fixDistRoots and scripts/tests/build.test.ts. Preserve all callers and disk-write equality checks. No task dependencies, active wip owners or extra worktrees at refinement.

### Plan

- [ ] 1. Add a failing unit case containing actual imports plus import-shaped non-module text and a real dynamic import inside template interpolation; add escaped-relative literals, safe callback quoting and parse-error no-write coverage (R1, R3).
- [ ] 2. Replace only rewriteSpecifiers matching with parser-selected span edits; reuse resolveSpecifier unchanged (R1, R2).
- [ ] 3. Add temporary-dist runtime and idempotency checks; preserve current file/index/unknown-specifier tests (R2, R3).
- [ ] 4. Run focused builder tests, bun run spur-check and bun run build; inspect git status for intentional changes (R3).

### Solution

<!-- Filled during implementation: file:line change map and concise rationale. -->

### Testing

<!-- Filled during verification: commands run, outcomes, coverage claim or N/A. -->

### Review

<!-- Filled during review: P1-P4 findings, residual risk, and final disposition. -->

### References

- Parent: docs/features/L1_preserve-emitted-javascript-text-during-esm-import-repair.md; docs/00_ADR.md ADR-003/004 retain existing build and dependency contracts.
- scripts/lib/build.ts; scripts/builder.ts; scripts/tests/build.test.ts; package.json; bun.lock.
- Confirmed again with /tmp/ts-libs-review-script-repro.ts during refinement; 43 focused builder/hub tests pass before implementation, demonstrating current tests miss the defect. Repro is scratch evidence, source/test paths above are durable.
- No scheduling dependencies, active wip tasks or extra worktrees at refinement.

### History

- 2026-10-12T07:18:19.461Z backlog → todo (system)

