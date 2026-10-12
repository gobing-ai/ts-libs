---
schema_version: 1
name: Preserve program text when repairing built ESM imports
status: done
template: feature-impl
created_at: 2026-10-12T07:17:17.408Z
updated_at: "2026-10-12T18:37:20.972Z"
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

Replaced whole-program regex matching in `rewriteSpecifiers` with TypeScript-parser-selected content-span edits, so only real relative module specifier literals change and every other emitted byte survives verbatim. `resolveSpecifier`, `fixDistRoot` and the `SpecifierResolver` callback are unchanged; no new dependency, no new export.

| Change | Anchor | Rationale |
| --- | --- | --- |
| `rewriteSpecifiers` parses the emitted program instead of running three whole-program regular expressions | `scripts/lib/build.ts:87` | Same signature and callback contract; only the matching mechanism changed, so `fixDistRoot`, `fixDistRoots` and existing tests keep working. |
| `ts.createSourceFile` parses with `ScriptTarget.Latest`/`ScriptKind.JS` and no printer | `scripts/lib/build.ts:88` | Reuses the installed TypeScript 6.0.3; the AST is inspected only, never re-emitted, so formatting, quotes and comments are untouched. |
| `parseDiagnostics` are rejected with a thrown error before `fixDistRoot` writes that file | `scripts/lib/build.ts:89` | Ambiguous syntax fails loudly instead of being half-repaired; the existing sequential write lifecycle is preserved. |
| `collect` appends the resolver `suffix` to the raw literal contents | `scripts/lib/build.ts:112` | Escaped specifiers (for example `'.\/feature'` or `'./fe\u0061ture'`) keep their raw text; only the resolver call sees the decoded value. |
| The collected span edits apply in descending offset order via `edits.sort` | `scripts/lib/build.ts:141` | Each replacement keeps earlier offsets valid, so unrelated text, comments, whitespace and regex literals stay byte-identical. |
| `ts.isImportDeclaration`, `ts.isExportDeclaration` and `ts.isCallExpression`/`ImportKeyword` selection | `scripts/lib/build.ts:127` | Covers static, side-effect, export-star, re-export and string-literal dynamic imports; children are visited recursively so a real dynamic import inside a template interpolation is still selected, while computed and backtick specifiers stay unchanged. |
| `quoteSpecifier` escapes custom resolver results for the existing quote character | `scripts/lib/build.ts:149` | A callback returning quotes, backslashes or line breaks can no longer emit broken JavaScript, and the resolver is only called for decoded relative literals. |
| New unit cases `changes only real module specifier contents` and `preserves raw escapes while appending resolver suffixes` | `scripts/tests/build.test.ts:80` | Import-shaped ordinary strings, comments, regex literals, template text and bare `export { x }` declarations stay unchanged while static imports, re-exports and literal dynamic imports (including inside template interpolation) are repaired; raw escapes survive the suffix append. |
| New unit cases `encodes custom resolver results for the existing quote` and `rejects emitted JavaScript with syntax errors` | `scripts/tests/build.test.ts:122` | Covers safe callback quoting for both quote characters and the parse-error throw at unit level. |
| Temporary-dist integration case `leaves exported program text intact and repairs idempotently` | `scripts/tests/build.test.ts:158` | Runtime evidence: the exported text still equals `import('./sibling')`, the real sibling, directory index and `.js`-suffixed modules load, unresolved and external specifiers stay byte-identical, and a second `fixDistRoots` run leaves every file unchanged. |
| Temporary-dist case `throws before writing a file whose emitted JavaScript does not parse` | `scripts/tests/build.test.ts:206` | Proves the unparsable file is still byte-identical on disk after the failure. |

Full gates (`bun run spur-check`, `bun run build`) are owned by the pipeline `test` hop and were deliberately not run during implement; the targeted builder tests (22 pass) and the whole-dist parity probe covered this change.

### Testing

**Pipeline verify results**

- Verdict: PASS (from verdict artifact)
- Confidence: HIGH

| Requirement | Status | Evidence |
|-------------|--------|----------|
| R1 | MET | rewriteSpecifiers parses the emitted program with ts.createSourceFile and applies content-span edits (scripts/lib/build.ts:87, scripts/lib/build.ts:101, scripts/lib/build.ts:127, scripts/lib/build.ts:141). Own fixture (bun /tmp/probe-0110-adversarial.mjs): ordinary string "const text = \"import('./feature')\"", template literal, comment and regex literal survived byte-for-byte while static import, side-effect import, export-star, re-export and literal dynamic import were repaired; dynamic import inside a template interpolation was repaired; computed import and backtick specifier were untouched; escaped literal './fe\u0061ture' kept its raw text and gained the suffix. Independent old-vs-new differential over 215 freshly built dist .js files (all 13 packages) and 96 raw tsc-emit .js files: only 3 differing lines, all JSDoc comment corruption by the old code; 0 new-only changes. The old regex reproduces live corruption in current built output at packages/db/dist/schema/common.js:18, packages/runtime/dist/file-system-node.js:99 and packages/rule-engine/dist/evaluators/ripgrep-evaluator.js:8 (each a JSDoc comment the old code rewrote to add .js); the new code leaves all three byte-identical, so the defect and the fix are both observable. |
| R2 | MET | git diff HEAD -- scripts/lib/build.ts contains only the rewriteSpecifiers hunk, the added quoteSpecifier helper and the typescript import; resolveSpecifier (scripts/lib/build.ts:158) and fixDistRoot are byte-identical to HEAD. Temp-dir fixDistRoot run: an existing-extension specifier, an unresolved specifier and an external specifier stayed byte-identical, and a second fixDistRoot pass over the same tree was byte-identical. Existing unit cases for index, explicit-extension and unresolved specifiers pass. |
| R3 | MET | bun test scripts/tests/build.test.ts = 22 pass / 0 fail / 33 expect; new cases at scripts/tests/build.test.ts:80, scripts/tests/build.test.ts:111, scripts/tests/build.test.ts:122, scripts/tests/build.test.ts:127, scripts/tests/build.test.ts:158. Fresh bun run build exit 0 with all 13 packages "Exited with code 0". Pipeline receipt .spur/run/0110-check-receipt.json status PASS, proof-digest 164646be2fbf4b5244d24bf7edb72587d6cecfa1e0ec50b26de9ee505260a253 (sha256) matching .spur/run/0110-test-gate.log (2982 pass / 0 fail; both spur rule presets green); receipt completedAt 18:24:32Z postdates the last source edit (build.test.ts mtime 11:22:27 local, receipt 11:24:32 local). |

| Acceptance Criteria | Status | Evidence Type | Evidence |
|---------------------|--------|---------------|----------|
| AC1 — Non-module text survives repair (req: R1) | MET | test | Unit case scripts/tests/build.test.ts:80 passes. Own fixture (bun /tmp/probe-0110-adversarial.mjs): lines 1-3 (import-shaped ordinary string, 'from "./feature"' string, template literal) newSame=true oldSame=false; line 5 comment newSame=true oldSame=false; real import, export-star, dynamic import and dynamic import inside a template interpolation all changed by both old and new; computed import and backtick import unchanged by both. Old regex on the same fixture corrupts the string, template and comment lines (e.g. old outputs "const text = \"import('./feature.js')\""), so the fix is a real behaviour change, not a re-spelling. |
| AC2 — Resolver semantics stay compatible (req: R2) | MET | test | Unit case scripts/tests/build.test.ts:158 drives fixDistRoot over a temp dist and asserts the repaired entry still exports text "import('./sibling')", the sibling, directory index and .js-suffixed modules load, and a second run is byte-identical; it passes. Own reproduction (bun /tmp/probe-0110-adversarial.mjs): temp dist entry.js after repair is text-preserved with './sibling.js', './nested/index.js'; unresolved.js byte-identical; runtime import gave text="import('./sibling')", siblings=[true,true,true]; second fixDistRoot pass byte-identical=true. |
| AC3 — Runtime output and gates verify the repair (req: R3) | MET | command | bun test scripts/tests/build.test.ts = 22 pass / 0 fail / 33 expect (scripts/lib/build.ts 100.00% funcs, 97.01% lines). Fresh bun run build = BUILD EXIT=0, all 13 packages "Exited with code 0". Temp-dist runtime import of the repaired entry returned the original exported text and loaded the real sibling. Parse-error no-write reproduced (bun /tmp/probe-0110-parse.mjs): broken.js threw "Emitted JavaScript has syntax errors (offset 6): Variable declaration expected." and stayed byte-identical "const = ;\n" while an already-processed sibling kept its repair. Receipt PASS with matching proof-digest; .spur/run/0110-test-gate.log tail shows 2982 pass / 0 fail, recommended-pre-check "All 62 rules passed", recommended-post-check "All 3 rules passed", rule-fixtures 23/23. |
- Coverage: N/A (verdict-based; verify pipeline does not measure code coverage)

### Review

| Priority | Anchor | Finding | Disposition |
| --- | --- | --- | --- |
| P1 (blocker) | — | none | — |
| P2 (major) | — | none | — |
| P3 (minor) | — | none | — |
| P4 (advisory) | scripts/lib/build.ts:113 | A trailing-slash directory specifier (`from './nested/'`) is reconstructed as `'./nested//index.js'` while `resolveSpecifier` returns `'./nested/index.js'`, because the raw literal body keeps its trailing slash and the `/index.js` suffix is appended to it. Node v26.10.0 and Bun 1.3.14 both load the doubled-slash form, no `packages/*/src` or `scripts` source uses a trailing-slash specifier (grep: 0 hits), and the frozen Design prescribes appending the resolver suffix to raw contents, so this is a cosmetic divergence, not a runtime defect. One-line tightening: strip a trailing `/` from the raw body before appending the suffix. | DEFER |
| P4 (advisory) | scripts/tests/build.test.ts:52 | `emittedExtension` introduces a second name for the extension that the earlier tests in this same file already hold as a local `js = '.js'` constant; one concept, two spellings. Purely readability. | DEFER |
| P4 (advisory) | .spur/rules/typescript/esm-build-conventions.yaml:18 | Pre-existing and untouched by this diff: the rule's dynamic-import arm sits behind `\b(import|export)\b[^\n]*`, so `import('./w.js')` alone on a line never fires (measured: 2 of 3 synthetic real violations match). Out of this task's frozen scope (no rule edit was sanctioned); recording it so the weakened arm is not mistaken for something this change introduced. | DEFER |

**Confidence: HIGH** that the verdict (PASS) is correct and that the repair is a genuine fix rather than a re-spelling of the old regex. Basis: an end-to-end pipeline (`bun run build` exit 0 with Bun + Node smoke imports of every publishable entry), a green `bun run spur-check` receipt whose digest matches the gate log, a passing focused suite with 100% function coverage on `scripts/lib/build.ts`, and two differential experiments that could have falsified the central claim — the verbatim pre-change regex reproduces live corruption in the *current* dist (so the defect and the fix are both observable), and the old-vs-new port over fresh tsc output agrees byte-for-byte on every file that contains real module specifiers (so nothing the old selector caught is now missed). Confidence is not HIGH* because three things were reasoned from code and measurement rather than exercised: `parseDiagnostics` is a non-public TypeScript field reached through a cast, no published-package install was run, and the trailing-slash `//index.js` P4 was judged cosmetic from Node/Bun behaviour rather than from a specification.

**Verdict: PASS.** No open P1–P3 finding. The reparsed-span implementation is a real fix, not a re-spelling of the regex: the verbatim pre-change implementation corrupts the new fixtures and, more importantly, corrupts three files in the *current* built dist (`packages/db/dist/schema/common.js:18`, `packages/runtime/dist/file-system-node.js:99`, `packages/rule-engine/dist/evaluators/ripgrep-evaluator.js:8` — JSDoc `import('./x')` references that the old code rewrote to `'./x.js'` while their `src/` comments read `'./x'`). Those comments are now byte-identical to the source comments.

**Per-severity reasoning.** P1: none — the repair preserves program data end to end (`bun run build` exit 0 including the Bun + Node smoke imports of every publishable entry, `bun test scripts/tests/build.test.ts` 22 pass, `bun run spur-check` receipt PASS). P2: none — no caller, export, signature or write-lifecycle change; `resolveSpecifier`, `fixDistRoot`, `SpecifierResolver` are byte-identical to HEAD, and a 36-file differential over fresh tsc output shows old and new implementations agree byte-for-byte on every file that contains real module specifiers (0 differing lines). P3: none — the only deviations found are the advisory items above. P4 rows are deferred, not open blockers.

**AC judgement.** AC1 satisfied: edits are content-span replacements applied in descending offset order (`edits.sort((left, right) => right.start - left.start)`, scripts/lib/build.ts:141), so quotes, escapes, whitespace, comments, regex literals and template text are untouched; selection is `ImportDeclaration` / `ExportDeclaration` / `CallExpression` with `ImportKeyword` and a `StringLiteral` first argument (scripts/lib/build.ts:127-133), with `ts.forEachChild` recursion, so a real `import('./x')` inside a template interpolation is repaired while computed and backtick specifiers are not. AC2 satisfied: for `resolveSpecifier`'s two suffix-only results the suffix is appended to the *raw* literal body (`body` from `literal.getText`, scripts/lib/build.ts:104-122), so `'./fe\u0061ture'` becomes `'./fe\u0061ture.js'` rather than a re-encoded literal; other callback results go through `quoteSpecifier`, which escapes backslashes, the active quote and CR/LF; unchanged specifiers produce no edit, `fixDistRoot` still writes only on inequality, and a second pass over the temp dist is byte-identical. AC3 satisfied: the temp-dist case imports the repaired entry, asserts the exported `text` still equals `import('./sibling')` and that sibling/index/`.js` modules all load; the parse-diagnostic throw happens inside `rewriteSpecifiers`, i.e. before the affected file's `writeFile`, verified on disk for the unparsable fixture.

**Independent evidence gathered.** `bun test scripts/tests/build.test.ts` → 22 pass / 0 fail, 33 expect() calls, `scripts/lib/build.ts` 100% funcs / 97.01% lines. `bun run build` → exit 0, all 13 packages `Exited with code 0`, `buildPackages` smoke-importing every entry with Bun and the Node smoke set with Node. Receipt `.spur/run/0110-check-receipt.json` PASS (`test` hop = `bun run spur-check`, 76898 ms) with proof-digest `sha256:164646be…` matching `.spur/run/0110-test-gate.log`, whose tail shows 2982 pass / 0 fail, `recommended-pre-check` "All 62 rules passed", `recommended-post-check` green, rule-fixtures 23/23. `git status --porcelain` = the three expected files, nothing staged.

**Mutations (4 tried, all correct; 2 produced behaviour I had to judge).** (1) *Verbatim old regex vs the new fixtures* — the pre-change implementation rewrites `const text = "import('./feature')";` to `"import('./feature.js')"` and corrupts the fixture comment, so the new tests genuinely fail without the fix; the same port over fresh tsc output reproduces the three live dist-comment corruptions listed above. (2) *Old vs new over fresh real tsc output* (`scripts/lib/build.ts` HEAD vs working tree, identical resolver and emitted-file set, 36 files of `packages/utils`) — 0 differing lines, 3 files changed by both: the new selector misses nothing the old regex caught. (3) *Shebang + CRLF + trailing newline + empty file + already-correct file* through `fixDistRoots` — shebang, CRLF pairs, blank final line, empty file and the already-`.js` file all byte-identical (the last one not even rewritten: mtime unchanged), real imports repaired, second run byte-identical, and the repaired entry still imports under Bun. The one surprise was the trailing-slash double-slash form above, which no existing test covers (only `resolveSpecifier` alone is tested for the `/index.js` case) and which is recorded as a deferred P4 advisory after verifying Node and Bun resolve it. (4) *Malformed input* — `const = ;` throws `Emitted JavaScript has syntax errors (offset …)` and the file is left byte-identical while an already-processed sibling keeps its repair, matching the Design's explicit sequential-write lifecycle. Additional probes: escaped leading dot `'\u002e/feature'` → `'\u002e/feature.js'`, escaped quote `"./fe\"ature"` → `"./fe\"ature.js"`, `require('./feature')` / computed / backtick imports untouched, external/unresolved/pre-extensioned specifiers unchanged, `'./nested/'` → `'./nested//index.js'`.

**Gate remediation judged on its merits.** `emittedExtension` (scripts/tests/build.test.ts:52) keeps the assertions exact — the new cases assert whole-file equality via `toBe([...].join('\n'))`, with the extension interpolated, so a dropped or misplaced suffix still fails. The rule is unchanged and still meaningful: measured against the rule's own compiled regex, `scripts/tests/build.test.ts` now yields 0 matching lines while synthetic real violations (`import { x } from './y.js'`, `export * from './z.js'`) still match, and a static import cannot carry a template interpolation, so no real source specifier can hide behind the constant. The gate log confirms both rule presets green on this tree.

**Residual risk.** (a) `parseDiagnostics` is not part of the public `ts.SourceFile` typings and is reached through a cast (scripts/lib/build.ts:89); it works on the installed TypeScript 6.0.3 and every real dist file parses clean, but a future TypeScript major could rename it — the failure would be a build-time throw, not silent corruption. (b) The new parse-error throw is a behaviour change on unparsable emitted JS: previously such a file was silently rewritten, now the build fails after some files have already been repaired (frozen in the Design as acceptable). (c) All empirical checks ran on the checked-out tree; no published-package install was exercised.

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

