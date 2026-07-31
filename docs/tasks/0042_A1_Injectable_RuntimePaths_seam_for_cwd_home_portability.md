---
schema_version: 1
name: "A1: Injectable RuntimePaths seam for cwd/home portability"
status: done
type: task
priority: P2
tags: [adr,runtime,portability,advisory]
dependencies: ["0041"]
created_at: 2026-07-11T06:07:44.535Z
updated_at: "2026-07-31T17:48:56.967Z"
---

## 0042. "A1: Injectable RuntimePaths seam for cwd/home portability"

### Background

ADR-023 advisory candidate A1 from codex review (task 0041). ts-runtime currently anchors to ambient cwd/home via process.cwd()/os.homedir(). Make RuntimePaths injectable so consumers stop reaching for ambient state and the importer roots resolve against home consistently.


### Requirements
R1. **Define an injectable `RuntimePaths` value type in `@gobing-ai/ts-runtime`.** Shape `{ readonly cwd: string; readonly home: string }`, plus an `ambientRuntimePaths()` factory capturing the current ambient values (`getProcessCwd()` at `packages/runtime/src/path.ts:137`, `getHomeDir()` at `packages/runtime/src/config.ts:103`). Both exported from the package barrel with TSDoc (the `every-export-has-tsdoc` post-check rule gates this).

R2. **`createNodeFileSystem` and `NodeProcessExecutor` accept `RuntimePaths` via optional DI.** Where each currently falls back to ambient state — `createNodeFileSystem` at `packages/runtime/src/file-system-node.ts:38` (`root ?? findProjectRoot(process.cwd())`), and any executor run with no explicit `cwd` (execa then defaults to the ambient process cwd) — an injected `paths.cwd` / `paths.home` takes precedence. With no injection the behavior is byte-identical to today.

R3. **Importer registry `defaultRoots` resolve against `RuntimePaths.home`, not ambient cwd.** The `SOURCE_DEFINITIONS` roots (`.claude/projects`, `.codex/sessions`, … — `packages/llm-jsonl-importer/src/sources.ts:99-105`) are home-relative by intent, but `importer.ts:219` passes them to `resolvePath`, which anchors relative segments to `getProcessCwd()` (`packages/runtime/src/path.ts:114-118`). Any invocation from a cwd ≠ `$HOME` therefore resolves them to nonexistent paths and silently skips every source (`importer.ts:222` `continue`). `runJsonlImport(source, options)` (`importer.ts:39`) gains an optional paths seam; registry `defaultRoots` resolve against `paths.home`. Explicit caller-supplied `options.roots` keep cwd semantics — CLI convention (`--roots ./data` means the invocation directory), and changing that would be a breaking behavior change, not a fix.

R4. **Additive only — no breaking changes.** Every new parameter is optional and defaults to ambient; no existing public signature narrows, reorders, or changes behavior under default arguments. Proof mechanism: the untouched call sites typecheck unchanged under the per-package `tsc --noEmit` gate.

R5. **Tests pin both directions.** Injected paths are observed (a fake home/cwd is what each seam actually uses — asserted, not inferred), defaults assert ambient behavior, and the importer suite covers the cwd ≠ `$HOME` case that today silently discovers zero files.
### Acceptance Criteria

Scenario-to-requirement map: interface→R1 · di-seams→R2 · home-roots→R3 · explicit-roots→R3 · additive→R4 · tests→R5.

```gherkin
Feature: Injectable RuntimePaths seam for cwd/home portability

  Scenario: The ambient factory captures the process environment
    Given no injected RuntimePaths
    When ambientRuntimePaths() is called
    Then cwd equals the process working directory
    And home equals the user home directory

  Scenario: Injected paths flow into the runtime seams
    Given a RuntimePaths carrying a fake cwd and home
    When the node file system and process executor are constructed with it
    Then their ambient fallbacks resolve against the injected values
    And the process environment is not consulted for those fallbacks

  Scenario: The importer finds sources when the working directory is not home
    Given a fixture home containing a .claude/projects history tree
    And a process working directory outside that home
    When an import runs for the claude source with no explicit roots
    Then the fixture history files are discovered

  Scenario: Explicit relative roots keep working-directory semantics
    Given a caller-supplied relative root
    When an import runs from a known working directory
    Then that root resolves against the working directory, not home

  Scenario: Existing call sites are unaffected
    Given the public API surface before this change
    When the change lands
    Then every existing call site typechecks without modification
    And every previously passing test still passes

  Scenario: Injected and ambient behavior are both pinned by tests
    Given the extended ts-runtime and importer suites
    When they run
    Then injected-path assertions pass
    And ambient-default parity assertions pass
```

### Q&A



### Design
**The change, in one sentence:** introduce a two-field `RuntimePaths` value in ts-runtime, thread it as an optional options-bag parameter through the three places that currently read ambient cwd/home, and flip the importer's registry roots to anchor on `paths.home`.

**New module** — `packages/runtime/src/runtime-paths.ts`:

```ts
/** Injectable cwd/home anchor for runtime seams; defaults to the ambient process environment. */
export interface RuntimePaths {
    readonly cwd: string;
    readonly home: string;
}

/** Capture the current ambient RuntimePaths (process cwd + user home). */
export function ambientRuntimePaths(): RuntimePaths {
    return { cwd: getProcessCwd(), home: getHomeDir() ?? getProcessCwd() };
}
```

A new small module rather than extending `path.ts`: `RuntimePaths` composes `getProcessCwd()` (`path.ts`) and `getHomeDir()` (`config.ts`), so a third module keeps both owners focused. Home fallback is cwd (matching the `getProcessCwd()` `/`-fallback philosophy — a degraded but absolute anchor) so the type's fields stay non-optional `string`.

**DI seams (all optional, all default ambient)**

- `createNodeFileSystem(root?: string, paths?: RuntimePaths)` — second optional positional; the root computation becomes `root ?? findProjectRoot(paths?.cwd ?? getProcessCwd())`. No options-bag conversion (would churn every existing call for zero gain).
- `ProcessExecutorConfig` gains `paths?: RuntimePaths` (`process-executor.ts:11` — the existing options bag). `NodeProcessExecutor` stores `paths?.cwd` and applies it only when a run carries no explicit `cwd`: `...(opts.cwd !== undefined ? { cwd: opts.cwd } : injectedCwd !== undefined ? { cwd: injectedCwd } : {})`. Explicit-per-call cwd wins; injected default second; ambient last — precedence is explicit and total.
- `ImportOptions` gains `paths?: RuntimePaths`. Root resolution at `importer.ts:219` splits by provenance: registry `defaultRoots` → `resolvePath(paths.home, root)`; explicit `options.roots` → unchanged `resolvePath(root)` (cwd semantics). The split is the design: registry roots are home-relative by intent (they name per-tool config dirs), explicit roots are caller intent anchored to the invocation directory.

**Why this is the whole fix.** The observed defect is silent source-skipping: cwd ≠ $HOME → defaultRoots resolve to nonexistent paths → `importer.ts:222` `continue` → empty import. Anchoring defaultRoots to home removes the ambient dependency; the DI seams remove the same class of ambient read from the two other ADR-023 A1 call sites. No other behavior changes.

**Rejected**

- **`~` expansion in `resolvePath`** — no registry root uses `~`; adding shell expansion semantics to a pure path util for a hypothetical caller is speculative (YAGNI; revisit if a source registry ever needs it).
- **Resolving explicit roots against home too** — breaks the CLI convention that relative paths mean the invocation directory; a breaking behavior change disguised as consistency.
- **Threading `RuntimePaths` through `walkDir` / every `FileSystem` method** — A1 names the cwd/home anchor seams only; deep plumbing would touch every consumer for no observed defect.
- **`home?: string` optional field** — an absent home would reintroduce per-call-site fallback branching; mandatory-with-ambient-default keeps one code path.

**R4 proof** — additive-only is enforced mechanically, not by inspection: existing call sites pass no new arguments, and the per-package `tsc --noEmit` gate plus the full existing suite (1666 tests at last gate) must pass unchanged.
### Solution
Implemented as designed (R1–R5; ADR-023 A1). All five requirements landed; the full gate (`bun run spur-check` + `bun run build`) is green.


**R1 — `RuntimePaths` type + `ambientRuntimePaths()` factory** (`packages/runtime/src/runtime-paths.ts`, new)
- `RuntimePaths` interface `{ readonly cwd: string; readonly home: string }` and `ambientRuntimePaths()` returning `{ cwd: getProcessCwd(), home: getHomeDir() ?? getProcessCwd() }`.
- Home falls back to cwd when `getHomeDir()` is undefined (e.g. Cloudflare Workers) — keeps both fields non-optional `string`, mirroring the `getProcessCwd()` `/`-fallback philosophy.
- Exported from `packages/runtime/src/index.ts` barrel with TSDoc (passes the `every-export-has-tsdoc` post-check rule).

**R2 — DI seams in ts-runtime** (explicit > injected > ambient precedence)
- `createNodeFileSystem(root?, paths?)` (`packages/runtime/src/file-system-node.ts`): root computation is now `root ?? findProjectRoot(paths?.cwd ?? getProcessCwd())`. Second optional positional, no options-bag churn.
- `ProcessExecutorConfig.paths?: RuntimePaths` + `NodeProcessExecutor` (`packages/runtime/src/process-executor.ts`): stores `paths?.cwd`; `runUntraced` applies `cwd: options.cwd ?? this.config.paths?.cwd`. Explicit per-call cwd wins; injected default second; ambient last.

**R3 — Importer home-relative registry roots** (`packages/llm-jsonl-importer/src/importer.ts` + `types.ts`)
- `ImportOptions.paths?: RuntimePaths` added.
- `discoverFiles` splits root resolution by provenance:
  - registry `defaultRoots` → `resolvePath(ambient.home, root)` (home-relative — the core bug fix),
  - explicit caller `roots` → `resolvePath(ambient.cwd, root)` (cwd semantics preserved),
  - where `ambient = paths ?? ambientRuntimePaths()`.
- Note: explicit roots anchor on `paths.cwd` when injected, else ambient cwd. Default behavior (no `paths`) is byte-identical to the pre-change `resolvePath(root)` because `resolvePath(getProcessCwd(), root) ≡ resolvePath(root)` for both relative and absolute roots (verified against `packages/runtime/src/path.ts:113-134`).

**R4 — Additive-only proof**
- Every new parameter is optional; no existing public signature narrowed, reordered, or behaviorally changed under default args.
- Mechanical proof: `bun run spur-check` ran the full existing suite (1686 tests, was 1666 at design time) with zero modifications to existing call sites, plus per-package `tsc --noEmit` clean across all 8 packages.

**R5 — Tests** (12 new tests, all passing)
- `packages/runtime/tests/runtime-paths.test.ts` (10 tests): ambient-factory parity (cwd, home-with-fallback, readonly shape), `createNodeFileSystem` DI (injected seeds root walk, explicit root wins, default = ambient), `NodeProcessExecutor` DI (injected cwd applied, explicit per-call cwd wins, default = ambient, `cwd: undefined` lets injected flow through). macOS `/var` → `/private/var` normalized via `realpathSync`.
- `packages/llm-jsonl-importer/tests/importer.test.ts` (+2 tests in new `runJsonlImport paths injection (ADR-023 A1)` describe): (1) `defaultRoots` resolve against `paths.home` when cwd is outside home — builds a fake `~/.claude/projects/...` tree, runs from a foreign cwd, asserts `scannedFiles === 1` and the discovered `source_file` equals the fixture path; (2) explicit relative `roots` keep cwd semantics — fixture under cwd is imported, decoy under home is not.


- `bun run spur-check`: **PASS** — biome clean, per-package `tsc --noEmit` clean, 1686/1686 tests pass, both spur rule presets (`recommended-pre-check`, `recommended-post-check` incl. `coverage-gate` + `every-export-has-tsdoc`) pass, all `--fail-on warning`.
- `bun run build`: **PASS** — all 8 packages build; `dist/runtime-paths.{js,d.ts}` emitted and re-exported; importer `dist/importer.js` contains the new resolution logic.
- No skipped/commented tests; no new `biome-ignore`; no breaking changes to existing call sites.
### Plan
1. Add `packages/runtime/src/runtime-paths.ts` (`RuntimePaths`, `ambientRuntimePaths()`), export from the barrel with TSDoc (R1).
2. Wire the optional `paths` parameter into `createNodeFileSystem` and `ProcessExecutorConfig` / `NodeProcessExecutor` with the documented precedence (explicit > injected > ambient) (R2).
3. Thread `paths` through `ImportOptions` and split root resolution by provenance at `importer.ts:219` — registry `defaultRoots` against `paths.home`, explicit `roots` unchanged (R3).
4. Tests (R5): ambient-factory parity; injected-path assertions for both runtime seams; importer fixture with fake home + foreign cwd proving discovery; explicit-relative-root case proving cwd semantics survive.
5. Gate: `bun run spur-check` (biome + per-package tsc proving R4, full suite, both rule presets) and `bun run build`.
### Review
Reviewed 2026-07-31 alongside `/sp:dev-verify 0042` (diff scope: working-tree change set for ADR-023 A1 — `packages/runtime/src/{runtime-paths.ts,index.ts,file-system-node.ts,process-executor.ts}`, `packages/llm-jsonl-importer/src/{importer.ts,types.ts}`, +2 test files).

**Functional traceability** — 5/5 requirements MET with fresh evidence (see Testing table): R1 type+factory, R2 both DI seams with total precedence, R3 provenance split fixing the cwd≠$HOME silent-skip defect, R4 additive-only proven by tsc 8/8 + 1686/1686 suite, R5 12 new tests pinning injected and ambient directions.

**SECUA** — Security: no new input-trust boundary; injected paths are config values, no shell exposure (executor passes `cwd` to execa as before). Efficiency: `ambientRuntimePaths()` called once per `discoverFiles`; no per-line work added. Correctness: `??` precedence chains verified; default-parity equivalence `resolvePath(getProcessCwd(), root) ≡ resolvePath(root)` confirmed against `path.ts:113-134`. Usability: TSDoc on all new exports; precedence documented at each seam. Architecture below.

**Architecture** — New `runtime-paths.ts` composes `path.ts` + `config.ts` without deepening either owner (matches Design's module rationale). Platform-API ownership stays in ts-runtime per ADR-011/014; the importer consumes the seam through the public barrel — no boundary violations. Optional DI adds no coupling; rejected alternatives (`~` expansion, deep threading) correctly stayed out.

**Findings**

| Severity | File | Finding | Recommendation |
|----------|------|---------|----------------|
| P3 | `docs/tasks/0042_….md` (Solution §R5) | Claims "26 new tests"; actual new tests are 12 (26 is the 2-file run total; 14 importer tests pre-existed) | Correct the count when the task file is next touched; cosmetic only |
| P4 | `packages/runtime/src/runtime-paths.ts:15-20` | `RuntimePaths` fields documented as absolute anchors but not validated; degenerate empty-string injection flows through | Accept as-is (YAGNI at this seam); revisit only if a caller validates untrusted input into it |

No P1/P2 findings. No scope-creep: every diff hunk maps to R1–R5 or their tests.
### Testing
Verified 2026-07-31 via `/sp:dev-verify 0042 --auto --force --focus all --fix all`. Verdict: **PASS**.

**Per-Requirement Traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 | MET | `packages/runtime/src/runtime-paths.ts:15-31` (`RuntimePaths` + `ambientRuntimePaths()`, TSDoc on both); barrel exports `packages/runtime/src/index.ts:50-51`; tests `packages/runtime/tests/runtime-paths.test.ts:29,34,40` |
| R2 | MET | `packages/runtime/src/file-system-node.ts:38-39` (`root ?? findProjectRoot(paths?.cwd ?? process.cwd())`); `packages/runtime/src/process-executor.ts:24-29,204` (`config.paths?`, `options.cwd ?? this.config.paths?.cwd`); tests `packages/runtime/tests/runtime-paths.test.ts:49,62,74,82,95,109,116` |
| R3 | MET | `packages/llm-jsonl-importer/src/importer.ts:52,225-232` (provenance split: registry `defaultRoots` → `resolvePath(ambient.home, root)`, explicit roots → `resolvePath(ambient.cwd, root)`); `packages/llm-jsonl-importer/src/types.ts:71-76` (`ImportOptions.paths`); test `packages/llm-jsonl-importer/tests/importer.test.ts:383` (cwd ≠ $HOME discovery) |
| R4 | MET | `bun run lint` exit 0 (biome + per-package `tsc --noEmit` clean, all 8 packages); full suite `bun test`: 1686/1686 pass, 0 fail; default-parity equivalence `resolvePath(getProcessCwd(), root) ≡ resolvePath(root)` verified against `packages/runtime/src/path.ts:113-134` |
| R5 | MET | 12 new tests, all green this run: 10 in `packages/runtime/tests/runtime-paths.test.ts` (ambient parity + both DI seams, injected and default directions) + 2 in `packages/llm-jsonl-importer/tests/importer.test.ts:382-449` (`runJsonlImport paths injection (ADR-023 A1)`) |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| Scenario: The ambient factory captures the process environment | MET | test | `packages/runtime/tests/runtime-paths.test.ts:29,34` — `bun test` green (26 pass across the 2 touched test files) |
| Scenario: Injected paths flow into the runtime seams | MET | test | `packages/runtime/tests/runtime-paths.test.ts:49,82,95,116` — injected cwd observed at both seams, ambient not consulted |
| Scenario: The importer finds sources when the working directory is not home | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:383` — fake `~/.claude/projects` tree discovered from foreign cwd, `scannedFiles === 1` |
| Scenario: Explicit relative roots keep working-directory semantics | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:421` — cwd fixture imported, home decoy ignored |
| Scenario: Existing call sites are unaffected | MET | command | `bun run lint` exit 0 (tsc all 8 packages); `bun test` 1686/1686 pass |
| Scenario: Injected and ambient behavior are both pinned by tests | MET | test | 12 new tests cover both directions; full suite green |

**Design Conformance**

| Check | Status | Evidence |
|-------|--------|----------|
| design-conformance | pass | 5 claims DONE (new module, home→cwd fallback, `createNodeFileSystem` seam, `ImportOptions.paths` provenance split, explicit-roots cwd semantics); 1 CHANGED — executor precedence implemented as `options.cwd ?? this.config.paths?.cwd` instead of the design's conditional-spread; goal-equivalent (ambient last via execa default), documented in Solution §R2 |

**SECUA Review (focus: all)**

No blocker or major findings.

- minor (docs): Solution §R5 originally claimed "26 new tests" — actual new tests are 12 (26 was the 2-file run total). Corrected in Solution on 2026-07-31.
- advisory (usability): `RuntimePaths` fields are documented as absolute anchors but not validated; a degenerate empty-string injection would flow through. YAGNI at this seam; note only.

**Gate Evidence (fresh this run)**

- `bun test packages/runtime/tests/runtime-paths.test.ts packages/llm-jsonl-importer/tests/importer.test.ts` → 26 pass, 0 fail, 69 expects.
- `bun run lint` → exit 0 (biome + per-package `tsc --noEmit`, 8/8 packages).
- `bun test` (full suite) → 1686 pass, 0 fail, 3760 expects, 172 files.
- Coverage (`bun test --coverage`): `packages/runtime/src/runtime-paths.ts` 100% lines / 100% funcs; `packages/runtime/src/file-system-node.ts` 100% / 100%; `packages/runtime/src/process-executor.ts` 95.74% lines / 100% funcs; `packages/llm-jsonl-importer/src/importer.ts` 97.06% lines / 97.56% funcs; repo total 99.45% lines.
- Verdict artifact: `.spur/run/0042-verdict.json` (written after verdict finalization; rows R1–R5 MET, 6/6 AC MET).
### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References




### History

- Migrated from legacy format (2026-07-31)
- 2026-07-31T17:27:22.793Z backlog → todo (system)
- 2026-07-31T17:27:22.923Z todo → wip (system)
- 2026-07-31T17:34:16.662Z wip → testing (system)
- 2026-07-31T17:43:58.323Z testing → done (system)
