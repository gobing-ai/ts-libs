---
schema_version: 1
name: "A1: Injectable RuntimePaths seam for cwd/home portability"
status: backlog
type: task
priority: P2
tags: [adr,runtime,portability,advisory]
dependencies: ["0041"]
created_at: 2026-07-11T06:07:44.535Z
updated_at: "2026-07-31T15:55:35.938Z"
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



### Plan
1. Add `packages/runtime/src/runtime-paths.ts` (`RuntimePaths`, `ambientRuntimePaths()`), export from the barrel with TSDoc (R1).
2. Wire the optional `paths` parameter into `createNodeFileSystem` and `ProcessExecutorConfig` / `NodeProcessExecutor` with the documented precedence (explicit > injected > ambient) (R2).
3. Thread `paths` through `ImportOptions` and split root resolution by provenance at `importer.ts:219` — registry `defaultRoots` against `paths.home`, explicit `roots` unchanged (R3).
4. Tests (R5): ambient-factory parity; injected-path assertions for both runtime seams; importer fixture with fake home + foreign cwd proving discovery; explicit-relative-root case proving cwd semantics survive.
5. Gate: `bun run spur-check` (biome + per-package tsc proving R4, full suite, both rule presets) and `bun run build`.
### Review



### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References




### History

- Migrated from legacy format (2026-07-31)
