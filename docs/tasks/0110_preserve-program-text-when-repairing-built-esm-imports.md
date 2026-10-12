---
schema_version: 1
name: Preserve program text when repairing built ESM imports
status: done
template: feature-impl
created_at: 2026-10-12T07:17:17.408Z
updated_at: "2026-10-12T21:30:29.143Z"
feature_id: L1

priority: P2
ac_numbering: task-local
ac_altitude: graduating
estimate_hours: 3
done_forced: "false"
done_reason: unforced close; PASS artifact at .spur/memory/evidence/0110-verdict.json
---

## 0110. Preserve program text when repairing built ESM imports

### Background

The 2026-10-12 inline review of packages and scripts reproduced output corruption in scripts/lib/build.ts:82. rewriteSpecifiers runs three regular expressions over whole emitted programs; fixDistRoot at scripts/lib/build.ts:57 writes the result back to disk. With feature.js present, the source `export const text = "import('./feature')";` becomes `export const text = "import('./feature.js')";`, changing exported program data. Comments are rewritten too. The reproduction in /tmp/ts-libs-review-script-repro.ts invokes the real resolveSpecifier with the emitted-file set, so this is a confirmed defect rather than a hypothesis. No existing task owns this repair. Direct triage fixes already address the separate strict-glob suffix boundary and Node event-log date-directory rollover defects; neither changes this builder.

**Refine corrections (2026-10-12)**
- Parser dependency was assumed installed → package.json, bun.lock and installed TypeScript all resolve 6.0.3 → use that existing parser; no dependency change.
- Content-span edits omitted escaped specifier handling → AST text is decoded while source contents can contain escapes → append the resolved suffix to the original raw contents, preserving escapes and quote delimiters.
- Design did not freeze parser failure behavior → emitted programs must parse → reject parse diagnostics before writing the affected file rather than repair ambiguous syntax.

### Requirements

- [x] R1. Replace whole-program regex matching with syntax-aware selection of actual relative static import/export and string-literal dynamic import module specifiers; preserve all other source text byte for byte.
- [x] R2. Keep resolveSpecifier and fixDistRoot behavior: known file/index modules gain .js or /index.js, existing extensions and unresolved or external specifiers remain unchanged, and unchanged files are not rewritten.
- [x] R3. Add unit and temporary-dist integration regressions proving import-shaped strings, comments, regex literals and template text stay unchanged while real imports are repaired; run both repository gates.

### Acceptance Criteria

- [x] AC1 — Non-module text survives repair (req: R1)
  Given matching import-shaped ordinary strings, comments, regex literals and template text alongside real static imports, re-exports and literal dynamic imports, when rewriteSpecifiers runs, then only the actual module specifier contents change and template interpolation containing a real dynamic import is still visited.
- [x] AC2 — Resolver semantics stay compatible (req: R2)
  Given direct-file and directory-index emitted modules, existing .js extensions and missing or external modules, when fixDistRoot runs, then only known extensionless relative references gain the appropriate extension and a second run is byte-identical.
- [x] AC3 — Runtime output and gates verify the repair (req: R3)
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

- [x] 1. Add a failing unit case containing actual imports plus import-shaped non-module text and a real dynamic import inside template interpolation; add escaped-relative literals, safe callback quoting and parse-error no-write coverage (R1, R3).
- [x] 2. Replace only rewriteSpecifiers matching with parser-selected span edits; reuse resolveSpecifier unchanged (R1, R2).
- [x] 3. Add temporary-dist runtime and idempotency checks; preserve current file/index/unknown-specifier tests (R2, R3).
- [x] 4. Run focused builder tests, bun run spur-check and bun run build; inspect git status for intentional changes (R3).

### Solution

rewriteSpecifiers now parses emitted JavaScript with the existing TypeScript parser, visits actual static import/export and quoted literal dynamic import nodes, and applies span edits in descending order without printing an AST (`scripts/lib/build.ts:87`). Non-module bytes survive unchanged; existing resolveSpecifier and disk-write lifecycle remain unchanged. Escaped specifiers retain raw contents, custom callback results are quoted safely, and parse errors throw before writing the affected file.

Trailing directory slashes, including escaped slashes, append index.js without an extra slash (`scripts/lib/build.ts:116`), covered by `scripts/tests/build.test.ts:154`. Text preservation and runtime/idempotency evidence: `scripts/tests/build.test.ts:108` and `scripts/tests/build.test.ts:199`.

**Scope extension requested before commit:** tightened the existing no-js-extension-in-ts-source-imports pattern in .spur/rules/typescript/esm-build-conventions.yaml to catch standalone dynamic and side-effect imports as well as static import/re-export statements. The real-engine positive/negative smoke regression is `scripts/tests/build.test.ts:62`; YAML validation passes. Consolidated build-test emitted-extension constants without changing assertions. No rule exclusions, suppressed failures, dependency or release-workflow changes.

Pre-commit regression closure: `scripts/tests/build.test.ts:341` now uses temporary package directories and cleans them in finally. Previously buildPackages deleted real workspace dist outputs even with a mocked launcher; isolated paths prevent test/build interference.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | AST-selected edits in `scripts/lib/build.ts:87`; tests preserving non-module text and raw escapes at `scripts/tests/build.test.ts:108` and `scripts/tests/build.test.ts:138` passed, including real imports inside template interpolation. |
| R2 | MET | Existing resolver in `scripts/lib/build.ts:160` retains file/index, existing-extension, unresolved and external behavior. Trailing literal/escaped slash regression at `scripts/tests/build.test.ts:154` failed before this repair to `scripts/lib/build.ts:116` and passed in the full gate. Runtime/idempotency test `scripts/tests/build.test.ts:199` passed. |
| R3 | MET | Regressions at `scripts/tests/build.test.ts:108`, `scripts/tests/build.test.ts:154`, `scripts/tests/build.test.ts:199`, `scripts/tests/build.test.ts:247` passed. Fresh canonical gate and all-package build both exited zero; 2996 tests passed with zero failures and no skipped tests. Real-engine rule smoke test `scripts/tests/build.test.ts:62` proves static, re-export, side-effect and standalone dynamic import enforcement by `.spur/rules/typescript/esm-build-conventions.yaml:18`; source-extension constants are consolidated; the build-order test at scripts/tests/build.test.ts:345 uses temporary package roots so tests cannot delete real build outputs. |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — Non-module text survives repair (req: R1) | MET | test | AST-selected edits in `scripts/lib/build.ts:87`; tests preserving non-module text and raw escapes at `scripts/tests/build.test.ts:108` and `scripts/tests/build.test.ts:138` passed, including real imports inside template interpolation. |
| AC2 — Resolver semantics stay compatible (req: R2) | MET | test | Existing resolver in `scripts/lib/build.ts:160` retains file/index, existing-extension, unresolved and external behavior. Trailing literal/escaped slash regression at `scripts/tests/build.test.ts:154` failed before this repair to `scripts/lib/build.ts:116` and passed in the full gate. Runtime/idempotency test `scripts/tests/build.test.ts:199` passed. |
| AC3 — Runtime output and gates verify the repair (req: R3) | MET | test | Regressions at `scripts/tests/build.test.ts:108`, `scripts/tests/build.test.ts:154`, `scripts/tests/build.test.ts:199`, `scripts/tests/build.test.ts:247` passed. Fresh canonical gate and all-package build both exited zero; 2996 tests passed with zero failures and no skipped tests. Real-engine rule smoke test `scripts/tests/build.test.ts:62` proves static, re-export, side-effect and standalone dynamic import enforcement by `.spur/rules/typescript/esm-build-conventions.yaml:18`; source-extension constants are consolidated; the build-order test at scripts/tests/build.test.ts:345 uses temporary package roots so tests cannot delete real build outputs. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

| Priority | Location | Finding | Disposition |
| --- | --- | --- | --- |
| P4 | scripts/lib/build.ts:116 | Directory import reconstruction could add an extra slash. | FIXED — literal and escaped trailing-slash regressions pass. |
| P4 | scripts/tests/build.test.ts | Duplicate names represented the emitted extension. | FIXED — one emittedExtension constant across all assertions and command fixtures. |
| P4 | .spur/rules/typescript/esm-build-conventions.yaml:18 | The source import rule missed standalone dynamic imports (and side-effect imports). | FIXED — smallest pattern correction; `scripts/tests/build.test.ts:62` proves four forbidden forms fire and compliant forms pass using the real engine. |

Reviewed security, efficiency, correctness, usability and architecture. AST edits preserve unrelated bytes and quotes, escaped resolver suffixes, custom callback quoting, parse-error handling and sequential write lifecycle. No new dependencies, rule exclusions or public API. No open findings or deferrals remain.

Pre-commit regression closure: `scripts/tests/build.test.ts:341` now uses temporary package directories and cleans them in finally. Previously buildPackages deleted real workspace dist outputs even with a mocked launcher; isolated paths prevent test/build interference.

### References

- Parent: docs/features/L1_preserve-emitted-javascript-text-during-esm-import-repair.md; docs/00_ADR.md ADR-003/004 retain existing build and dependency contracts.
- scripts/lib/build.ts; scripts/builder.ts; scripts/tests/build.test.ts; package.json; bun.lock.
- Confirmed again with /tmp/ts-libs-review-script-repro.ts during refinement; 43 focused builder/hub tests pass before implementation, demonstrating current tests miss the defect. Repro is scratch evidence, source/test paths above are durable.
- No scheduling dependencies, active wip tasks or extra worktrees at refinement.

### History

- 2026-10-12T07:18:19.461Z backlog → todo (system)
- 2026-10-12T18:20:48.709Z todo → wip (system)
- 2026-10-12T18:37:11.626Z wip → testing (system)
- 2026-10-12T18:37:20.968Z testing → done (system)

