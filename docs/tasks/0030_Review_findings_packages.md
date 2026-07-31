---
schema_version: 1
name: "Review findings: packages"
status: done
type: task
profile: simple
created_at: 2026-06-09T16:30:20.915Z
updated_at: 2026-06-09T16:31:37.634Z
---

## 0030. "Review findings: packages"

### Background

Code review findings for packages with focus all and --fix all --auto


### Requirements

See Review section


### Q&A



### Design

Run `rd3-dev-review` as a source-oriented package review:

- Architecture pass against ADR constraints and package seams.
- SECU pass using targeted static searches plus focused file inspection.
- Auto-fix all mechanical findings.
- Verify with the repository's canonical gates.


### Solution

Fixed the only mechanical package-source finding:

- Replaced direct `Bun.which('git')` in `packages/ai-runner/src/identity.ts` with execution through the injected `SyncProcessExecutor`.
- Added a regression test for the unavailable-git path using a fake executor.
- Removed the stale `packages/ai-runner/src/identity.ts` exception from `.spur/rules/typescript/runtime-boundaries.yaml`.


### Plan

1. Read ADR and architecture constraints.
2. Run targeted static searches for platform boundary, DB facade, injection, secrets, error handling, type-safety, and skipped-test risks.
3. Patch mechanical findings.
4. Record findings and architecture candidates.
5. Run `bun run lint`, `bun run spur-check`, and `bun run build`.



### Review

## Review — 2026-06-09

**Status:** 1 finding fixed
**Scope:** `packages`
**Focus:** security, efficiency, correctness, usability, architecture
**Mode:** source
**Channel:** current
**Gate:** `bun run spur-check` pass; `bun run build` pass

### P1 — Blockers

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

### P2 — Warnings

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|
| 1 | Direct Bun platform lookup in published package source | Correctness / Architecture | `packages/ai-runner/src/identity.ts:72` | Fixed: route git probing through the injected `SyncProcessExecutor`; removed the stale `.spur` exception so `no-direct-bun-platform` enforces the boundary. |

### P3 — Info

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

### P4 — Suggestions

| # | Title | Dimension | Location | Recommendation |
|---|-------|-----------|----------|----------------|

### Architecture Candidates

1. **Runtime sync process compatibility seam** — `packages/runtime/src/process-executor.ts`, `packages/ai-runner/src/identity.ts`
   `BunSyncProcessExecutor` is deprecated but still used as the default for synchronous git context. The module is earning its keep as compatibility, but new callers should prefer async `ProcessExecutor`; consider an async `getGitContext` variant before adding more sync probes.

2. **Importer schema/table-name locality** — `packages/llm-jsonl-importer/src/importer.ts`, `packages/llm-jsonl-importer/src/schema-sql.ts`, `packages/llm-jsonl-importer/src/sources.ts`
   The importer has a small but real SQL identifier seam: table DDL, source definitions, and runtime validation are split across files. It is currently safe due to `targetTableFor()` and tests; if source definitions become user-extensible, concentrate target-table ownership behind one schema module.

3. **Extension loading path adaptation** — `packages/rule-engine/src/config/extensions.ts`, `packages/runtime/src/extension/*`
   Rule-engine adapts absolute extension refs into the shared runtime extension loader. The current exception is explicitly documented in `.spur`; if workflow-engine adds similar adaptation logic, extract a runtime-owned file-URL/path adapter instead of duplicating the exception.



### Testing

`bun run lint` passed.
`bun run spur-check` passed: 36 pre-check rules, 1267 tests, coverage gate, TSDoc export rule.
`bun run build` passed for all packages.



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References


### History

- Migrated from legacy format (2026-07-31)
