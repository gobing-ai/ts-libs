---
wbs: "0013"
status: Backlog
title: "Extend ts-runtime path utilities and eliminate node:path exemptions"
modified_files: []
source_dir: packages/runtime
created_at: 2026-06-04
---

## Background

Task 0012 established the `no-direct-node-path` spur rule — `node:path` imports
are forbidden outside `packages/runtime`. 16 files were granted temporary
exemptions because `ts-runtime`'s path utilities (`path.ts`) don't yet expose
all the primitives they need:

| Missing primitive | Used by | What it does |
|-------------------|---------|-------------|
| `basename` | `ai-runner/agent-spec.ts`, `rule-engine/config/loader.ts`, `rule-engine/config/extensions.ts`, `dual-workflow-engine/extensions.ts` | Return filename from path |
| `dirname` | `rule-engine/config/loader.ts`, `rule-engine/config/extensions.ts`, `rule-engine/evaluators/file-utils.ts`, `dual-workflow-engine/extensions.ts` | Return parent directory |
| `sep` (path separator) | `rule-engine/config/loader.ts`, `rule-engine/config/extensions.ts`, `dual-workflow-engine/extensions.ts` | Platform-specific separator (`'/'` or `'\\'`) |
| `relative` | `rule-engine/config/loader.ts`, `rule-engine/evaluators/coverage-gate-evaluator.ts`, `rule-engine/evaluators/file-utils.ts`, `rule-engine/fixers/fixers.ts` | Compute relative path between two absolute paths |

Almost all usage falls into a single pattern: the extension adapter needs
`dirname`/`basename`/`sep` to decompose an absolute `ref.absPath` into
`{ baseDir: dirname(fp), path: ./basename(fp) }` for the shared loader
(ADR-010). `relative` is used by rule-engine evaluators to normalize
file paths in findings.

Once `ts-runtime` path utilities provide these four primitives, 4 of the
16 exemptions can be eliminated immediately (the extension adapters).
The remaining 12 use *combinations* of these primitives for rule discovery,
file scanning, and config loading — more involved but mechanically
straightforward migrations.

## Requirements

### R1 — Add `basename`, `dirname`, `sep`, `relative` to `packages/runtime/src/path.ts`

Pure string functions — no `node:*` imports. Must pass `spur-check` without
adding `path.ts` to the `no-direct-node-path` exemption list (it's already
exempt as the runtime's path module).

```ts
/** Return the last segment of a path (POSIX or Windows). */
export function basenamePath(p: string, ext?: string): string;

/** Return the parent directory of a path. Trailing separator is stripped. */
export function dirnamePath(p: string): string;

/** Platform-specific path segment separator. */
export const SEP: string;

/** Compute a relative path from `from` to `to`. Both must be absolute. */
export function relativePath(from: string, to: string): string;
```

Implementation notes:
- `basenamePath`: find last `/` or `\`, return substring after it. Optionally strip `ext` suffix.
- `dirnamePath`: find last `/` or `\` in a normalized path (excluding trailing separator).
- `SEP`: `'/'` on POSIX, `'\\'` on Windows. Detected at module level via `process.platform`.
- `relativePath`: resolve `..` segments; return shortest relative path. Edge case: same path → `'.'`.

### R2 — Migrate extension adapters (4 files, lowest effort)

Replace `node:path` imports with the new `ts-runtime` path utilities:

| File | Current imports | Replace with |
|------|----------------|--------------|
| `dual-workflow-engine/src/extensions.ts` | `basename, dirname, sep` | `basenamePath, dirnamePath, SEP` |
| `rule-engine/src/config/extensions.ts` | `basename, dirname, resolve, sep` | `basenamePath, dirnamePath, resolvePath, SEP` |
| `rule-engine/src/config/loader.ts` | `basename, dirname, join, relative, resolve, sep` | `basenamePath, dirnamePath, joinPath, relativePath, resolvePath, SEP` |
| `packages/llm-jsonl-importer/src/importer.ts` | `resolve` | `resolvePath` |

After migration, remove these 4 files from the `no-direct-node-path` exemption
list in `.spur/rules/typescript/runtime-boundaries.yaml`.

### R3 — Migrate evaluator/fixer files (8 files, medium effort)

These use `node:path` for file scanning, path normalization, and finding
resolution:

| File | Current imports | Notes |
|------|----------------|-------|
| `rule-engine/evaluators/file-utils.ts` | `dirname, relative, resolve` | `relativeToWorkdir()` and `relativeParent()` — replace with `relativePath` + `dirnamePath` |
| `rule-engine/evaluators/coverage-gate-evaluator.ts` | `isAbsolute, relative, resolve` | Lcov `SF:` path normalization — replace with `isAbsolutePath` + `relativePath` + `resolvePath` |
| `rule-engine/fixers/fixers.ts` | `isAbsolute, join, relative, resolve` | Test-stub path resolution — replace with `isAbsolutePath` + `joinPath` + `relativePath` + `resolvePath` |
| `rule-engine/fixers/test-stub-fixer.ts` | `isAbsolute, join` | Test fixture paths — replace with `isAbsolutePath` + `joinPath` |
| `packages/db/src/migrate.ts` | `resolve` | Migration folder resolution — replace with `resolvePath` |
| `packages/db/src/adapters/bun-sqlite.ts` | `isAbsolute, resolve` | DB path resolution — replace with `isAbsolutePath` + `resolvePath` |
| `packages/ai-runner/src/agent-spec.ts` | `basename, join` | Agent spec file naming — replace with `basenamePath` + `joinPath` |
| `packages/ai-runner/src/doctor-runner.ts` | `join` (from `node:path`) + `homedir` (from `node:os`) | Agent config detection — `join` → `joinPath`; `homedir` → inline or add to runtime |

After migration, remove all 8 from the `no-direct-node-path` exemption list
(plus `no-direct-node-os` for `doctor-runner.ts`).

### R4 — Tests for new path utilities

Add `packages/runtime/tests/path-utilities.test.ts` covering:

- `basenamePath` with POSIX and Windows paths, with and without extension stripping
- `dirnamePath` with POSIX and Windows paths, root paths, trailing separators
- `SEP` value on the current platform
- `relativePath` — same directory, child directory, parent traversal, cross-drive (Windows), edge cases

### R5 — `no-direct-node-path` exemption cleanup

After R2+R3 migrations, the `no-direct-node-path` exclusion list in
`.spur/rules/typescript/runtime-boundaries.yaml` should shrink from 16 to 0.
Run `bun run spur-check` to verify no regressions.

### R6 — `no-direct-node-os` exemption cleanup

After migrating `doctor-runner.ts`'s `homedir()` call:
- Either: add `homedir` to `packages/runtime/src/path.ts` (or a new `os.ts` module)
- Or: inline `process.env.HOME || process.env.USERPROFILE || ''` in `doctor-runner.ts`

Remove the exemption from `no-direct-node-os` in `runtime-boundaries.yaml`.

### R7 — `no-direct-bun-platform` exemption check

`ai-runner/identity.ts` uses `Bun.which('git')` for git detection. This is
genuinely Bun-specific — there's no cross-platform `which` in Node.js stdlib.
Options:
1. Keep the exemption — `Bun.which` is the right tool for the job
2. Add `which` to `ts-runtime` process utilities
3. Replace with execa's `execa('which', ['git'])` pattern (works cross-platform)

### R8 — `no-direct-node-url` exemption cleanup

`rule-engine/config/extensions.ts` uses `fileURLToPath` for ESM-compatible
`__dirname` equivalent. Options:
1. Replace with `import.meta.dirname` (Bun-native, Node 21+)
2. Add `fileURLToPath` to `ts-runtime` path utilities
3. Keep exemption

## Solution

### Implementation order

1. Phase 1: Add `basenamePath`, `dirnamePath`, `SEP`, `relativePath` to `path.ts`
2. Phase 2: Add tests for new utilities
3. Phase 3: Migrate extension adapters (R2 — 4 files)
4. Phase 4: Migrate evaluator/fixer files (R3 — 8 files)
5. Phase 5: Clean up `no-direct-node-path` exemptions (R5)
6. Phase 6: Clean up `no-direct-node-os` exemption (R6)
7. Phase 7: Re-evaluate `no-direct-bun-platform` + `no-direct-node-url` exemptions (R7+R8)
8. Phase 8: Gates — `bun run spur-check`; target: 0 exemptions in `no-direct-node-path`

### Key design decisions

1. **`SEP` as a constant, not a function**. `process.platform` is checked once at
   module load. No runtime overhead per call.

2. **`relativePath` is pure string math**. No filesystem access. It computes
   the relative path purely from the string arguments. This matches `node:path.relative`
   behavior.

3. **`basenamePath` naming**. The `Path` suffix distinguishes from `node:path.basename`.
   Once `node:path` exemptions are eliminated, a future major can rename to `basename`.

## Acceptance criteria

- [ ] `basenamePath`, `dirnamePath`, `SEP`, `relativePath` added to `path.ts`
- [ ] All 5 new functions have unit tests
- [ ] 16 `node:path` exempted files migrated; all 16 removed from exclusion list
- [ ] `no-direct-node-path` has **0 exemptions** outside `packages/runtime/src/`
- [ ] `no-direct-node-os` exemption removed (or justified)
- [ ] `bun run spur-check` passes
- [ ] 1022+ tests pass (no regression)
- [ ] `git status` shows only intentional changes

## Review

Not started.

## Testing

Not started.

## Artifacts

| Type | Path | Agent | Date |
|------|------|-------|------|
| Task | `docs/tasks/0013_extend_path_utilities_eliminate_node_path_exemptions.md` | — | 2026-06-04 |

## References

- `.spur/rules/typescript/runtime-boundaries.yaml` — current exemptions (16 `node:path` + 1 `node:os` + 1 `node:url` + 1 `Bun.which`)
- `packages/runtime/src/path.ts` — existing path utilities to extend
- `packages/runtime/src/file-system-node.ts` — `findProjectRoot()` (reference for separation logic)
- `packages/rule-engine/src/config/extensions.ts` — primary consumer of `basename`/`dirname`/`sep`
- Task 0012 — upstream (completed), established the factory + runtime boundaries
