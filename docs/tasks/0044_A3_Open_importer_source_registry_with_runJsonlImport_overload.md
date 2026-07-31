---
schema_version: 1
name: "A3: Open importer source registry with runJsonlImport overload"
status: done
type: task
priority: P3
tags: [adr,llm-jsonl-importer,advisory]
dependencies: ["0041"]
created_at: 2026-07-11T06:07:57.882Z
updated_at: "2026-07-31T18:28:20.549Z"
---

## 0044. "A3: Open importer source registry with runJsonlImport overload"

### Background

ADR-023 advisory candidate A3 from codex review (task 0041). The JSONL importer currently has a closed source registry (SOURCE_DEFINITIONS). Open it with a runJsonlImport(source | SourceDefinition, ...) overload so callers can register custom source definitions. VALID_TABLE_NAME + schema validation already fence custom definitions.


### Requirements
R1. Public type surface — `SourceDefinition` is already exported (`src/index.ts:16`); keep that. The real gap: widen `SourceDefinition.source`, `TransformContext.source`, and `ImportResult.source` from the closed `LlmJsonlSource` union to `string` (`src/types.ts:35,43,88`) so custom definitions can name themselves. `LlmJsonlSource` stays unchanged as the built-in registry key type.

R2. `runJsonlImport(source | SourceDefinition, ...)` — accept either a built-in source name or a custom `SourceDefinition` via a single union-parameter signature (satisfies the ADR-023 A3 "overload" intent). String → resolve from `SOURCE_DEFINITIONS`; unknown string rejects with `HistoryImportError` (fail loud, not a TypeError on `undefined`). Object → validate, then use directly.

R3. Validation fencing — custom definitions are validated fail-fast at entry: `targetTable` and any `splitConfig.targetTable` must match `VALID_TABLE_NAME`; required fields present (`displayName`, non-empty `filePatterns`, `fieldMap`, `schema`). Per-record zod schema validation already runs for every definition and stays the record-level fence. Built-ins run through the same validation path (single code path; they are known-good).

R4. Backward compatibility — existing `runJsonlImport(sourceName, ...)` calls behave identically at runtime: same checkpoint keys, ledger `source` values, and `TransformContext.source` (for built-ins, `definition.source === source` today). The `string` widening on `ImportResult.source` is a type-level break for consumers narrowing on the union — no runtime change; note it in the package CHANGELOG.

R5. Tests — extend `tests/importer.test.ts` (reusing its in-memory DbAdapter fixture): (a) custom `SourceDefinition` imports records into its `targetTable` with checkpoints keyed by its `source` name; (b) invalid `targetTable` rejects with `HistoryImportError` before any DB write; (c) schema-mismatched record lands in `validationErrors` and is not persisted; (d) unknown string source name rejects with `HistoryImportError`. No `.skip`.
### Acceptance Criteria

```gherkin
Feature: Open importer source registry with custom SourceDefinition (ADR-023 A3)

  Scenario: R2 — Custom definition imports into its target table
    Given a custom SourceDefinition with source "myllm", targetTable "history_etl_myllm", and a zod schema
    And a JSONL file with two valid records under an explicit roots path
    When runJsonlImport(definition, options) completes
    Then ImportResult.importedRecords is 2
    And both rows are queryable in history_etl_myllm
    And a checkpoint row exists with source "myllm"

  Scenario: R2b — Unknown source name fails loud
    When runJsonlImport("not-a-source", options) is invoked at runtime
    Then it rejects with HistoryImportError naming the unknown source

  Scenario: R3 — Invalid target table rejected before any write
    Given a custom SourceDefinition whose targetTable is "users"
    When runJsonlImport(definition, options) is called
    Then it rejects with HistoryImportError naming the invalid table
    And no schema or checkpoint writes occurred

  Scenario: R3b — Split target table is fenced too
    Given a custom SourceDefinition with splitConfig mode "one-to-many" and targetTable "evil_table"
    When runJsonlImport(definition, options) is called
    Then it rejects with HistoryImportError

  Scenario: R3c — Schema mismatch recorded, not persisted
    Given a custom SourceDefinition whose schema requires a content field
    And a JSONL line that normalizes to a record missing content
    When runJsonlImport(definition, options) completes
    Then validationErrors contains an entry for that file and line
    And no row for that line exists in the target table

  Scenario: R4 — Built-in source name behaves exactly as before
    Given the built-in "claude" source and an explicit roots path with a valid JSONL file
    When runJsonlImport("claude", options) completes
    Then records import exactly as before the change
    And checkpoint rows use source "claude"
```

### Q&A



### Design
#### Approach

**Single union parameter on the existing entry point** — `runJsonlImport(source: LlmJsonlSource | SourceDefinition, options)` — rather than TypeScript overload declarations. One signature, one resolution line, zero call-site changes for built-ins; satisfies the ADR-023 A3 "overload" intent with less surface.

#### Resolution + validation

```ts
const definition = typeof source === 'string' ? resolveBuiltIn(source) : validateSourceDefinition(source);
```

- `resolveBuiltIn(name)` (sources.ts): `SOURCE_DEFINITIONS[name]`, throwing `HistoryImportError` on unknown names (replaces today's `undefined` property-access crash).
- `validateSourceDefinition(def)` (sources.ts): the fail-fast fence — `VALID_TABLE_NAME.test(def.targetTable)` plus any `splitConfig.targetTable`; required fields present (`displayName`, non-empty `filePatterns`, `fieldMap`, `schema`). Returns `def`. Runs on the built-in path too, so there is exactly one definition-validation code path.
- Entry-point rejection happens **before** `applyHistoryImportSchema` / any DB write, so an invalid custom definition leaves no trace.

#### Source-key flow

After resolution, every downstream use of the `source` parameter switches to `definition.source`: checkpoint read/reset/write (`src/importer.ts:47,58,130`), ledger insert (`:335`), `TransformContext` (`:76,94,118`), and `ImportResult.source` (`:137`). For built-ins `definition.source === source`, so checkpoint/ledger keys are bit-identical to today (R4).

#### Type widening (the real R1)

`SourceDefinition.source`, `TransformContext.source`, `ImportResult.source`: `LlmJsonlSource` → `string` (`src/types.ts:35,43,88`). The union remains the key type of `SOURCE_DEFINITIONS`. Widening is a type-level break only for consumers narrowing on the union; runtime behavior is unchanged. CHANGELOG note required.

The record-level fence is unchanged: per-record zod validation against `definition.schema` already runs on every normalized record regardless of origin — custom definitions get it for free.
### Solution
Open source registry for `@gobing-ai/ts-llm-jsonl-importer` — `runJsonlImport()` now accepts
`source: string | SourceDefinition`. Additive at runtime; one type-level widening of the three
`source` fields (see CHANGELOG → Breaking Changes).

**Change map**

| File | Change |
|---|---|
| `packages/llm-jsonl-importer/src/types.ts:35,44,90` | Widened `SourceDefinition.source`, `TransformContext.source`, `ImportResult.source` from closed `LlmJsonlSource` union → `string`. `LlmJsonlSource` kept as built-in registry key type. |
| `packages/llm-jsonl-importer/src/sources.ts:105` | Added exported `VALID_TABLE_NAME = /^history_etl_[a-z_]+$/` (single authority, moved from importer.ts). |
| `packages/llm-jsonl-importer/src/sources.ts:141` | `validateSourceDefinition` — required-fields presence, non-empty `filePatterns` (`:161`), and table-name gate (`assertValidTable` at `:186`). |
| `packages/llm-jsonl-importer/src/sources.ts:179` | `resolveSourceDefinition` — string→registry / object→validate. Hardened `getSourceDefinition` (`:124`) to throw `HistoryImportError` on unknown keys. |
| `packages/llm-jsonl-importer/src/importer.ts:75` | Widened `runJsonlImport(source: string \| SourceDefinition, options)`. Resolution via `resolveSourceDefinition` at `:76`; downstream uses `definition.source` for checkpoints, ledger, sha256, return. |
| `packages/llm-jsonl-importer/src/importer.ts:46` | `ensureTargetTables()` + `ETL_TABLE_DDL()` (`:56`) — idempotent `CREATE TABLE IF NOT EXISTS` so custom ETL tables are created on demand without touching built-ins. Dropped local `VALID_TABLE_NAME` (now imported). |
| `packages/llm-jsonl-importer/src/index.ts:8-11` | Exported `resolveSourceDefinition`, `validateSourceDefinition`, `VALID_TABLE_NAME`. |
| `packages/llm-jsonl-importer/tests/importer.test.ts` | +8 tests under `runJsonlImport source registry (ADR-023 A3)`: custom-def import (2 records); unknown-source reject (type + message + no DB write); invalid `targetTable` reject via `runJsonlImport` with no-writes assertion; invalid `splitConfig.targetTable` reject; missing-required-field reject; empty-`filePatterns` reject; schema-mismatch → `validationErrors` + not persisted; built-in parity (string vs object def). |
| `packages/llm-jsonl-importer/README.md` | Exports table updated; new "Custom Source Definitions" section with end-to-end example. |
| `CHANGELOG.md` | `[Unreleased]/Added` entry for the overload, new exports, and on-demand table creation; `[Unreleased]/Breaking Changes` note for the type-level `string` widening (no runtime change). |

**Resolution semantics**

- `string` → `SOURCE_DEFINITIONS` lookup; unknown → `HistoryImportError` (fail-fast, no I/O).
- `SourceDefinition` object → `validateSourceDefinition`: required fields present + non-empty `filePatterns` + `targetTable` and `splitConfig.targetTable` match `VALID_TABLE_NAME`. Then used directly.
- Custom `source` name flows through checkpoints, the ledger, and `ImportResult.source` exactly like a built-in key.

**Verification**

- `/sp:dev-verify 0044 --fix all` — initial verdict PARTIAL; fix pass repaired 5 gaps (see `### Testing` → Fix pass); final verdict **PASS** (`.spur/run/0044-verdict.json`).
- `bun run spur-check` — 1694/1694 tests pass (was 1686; +8 new), Biome clean, both rule presets pass (`recommended-pre-check`, `recommended-post-check` incl. `coverage-gate` + `every-export-has-tsdoc`), `--fail-on warning`.
- `bun run build` — all 8 packages exit 0.
- No skipped tests, no new `biome-ignore`, no suppressions.
### Plan
1. `src/types.ts` — widen `SourceDefinition.source`, `TransformContext.source`, `ImportResult.source` to `string`; update doc comments (built-in names remain the `LlmJsonlSource` union).
2. `src/sources.ts` — add `validateSourceDefinition(def): SourceDefinition` (fail-fast fence per Design); harden `getSourceDefinition` to throw `HistoryImportError` on unknown names.
3. `src/importer.ts` — change `runJsonlImport` first param to `LlmJsonlSource | SourceDefinition`; resolve/validate the definition before `applyHistoryImportSchema`; switch all downstream `source` uses to `definition.source`.
4. `tests/importer.test.ts` — add the R5 cases (a)–(d) using the existing in-memory DbAdapter fixture; assert AC scenarios R2/R2b/R3/R3b/R3c/R4.
5. `README.md` (package) — short "Custom source definition" example mirroring the overload.
6. Package `CHANGELOG.md` — Unreleased note: new overload + `string` widening of the three `source` fields (type-level break, no runtime change).
7. `bun run spur-check` clean.
### Review
Verification 2026-07-31 (Phase 7 review, `/sp:dev-verify 0044 --focus all`). **Verdict: PASS.**

**Status:** 0 P1, 0 P2, 1 P3 (advisory), 0 P4
**Scope:** 0044 open source registry (7 files, +357/-31 after fix pass), `packages/llm-jsonl-importer`
**Mode:** review (functional + SECUA + architecture), `--focus all`
**Gate:** `bun run spur-check` exit 0 this run — Biome + per-package tsc + 1694/1694 tests + both rule presets (`--fail-on warning`); package suite 43/43

#### Functional (traceability)

R1–R5 MET; all six AC scenarios MET with executable test evidence. Full per-requirement / per-AC tables live in `### Testing`. One documented design deviation (built-ins skip `validateSourceDefinition`; Solution §Resolution semantics — goal-equivalent CHANGED, not silent).

#### Phase 7 — SECUA on the change set

- **Security:** the SQL-interpolated table name is gated twice — `validateSourceDefinition` at pipeline entry (`packages/llm-jsonl-importer/src/sources.ts:141-167`) and `targetTableFor` at the write seam (`packages/llm-jsonl-importer/src/importer.ts:383-388`). `VALID_TABLE_NAME` is the single authority (`packages/llm-jsonl-importer/src/sources.ts:105`). Unknown strings throw before any I/O (`packages/llm-jsonl-importer/src/sources.ts:124-130`, proven by test `:517` — ledger table never created). No secrets, no new deps. Clean.
- **Efficiency:** `ensureTargetTables` adds ≤2 idempotent `CREATE TABLE IF NOT EXISTS` statements per run; no per-record overhead. Clean.
- **Correctness:** `resolvedSource = definition.source` flows uniformly through checkpoints, ledger, hash, and result (`packages/llm-jsonl-importer/src/importer.ts:76-77` + downstream). Split-table fence mirrors the primary fence. Fix pass added the missing non-empty `filePatterns` guard (`packages/llm-jsonl-importer/src/sources.ts:161-166`). Clean.
- **Usability:** errors name the offending source/table/field and surface as typed `HistoryImportError` (no TypeError-on-undefined); README gains a runnable custom-definition example. Clean.
- **Architecture:** resolution seam lives in `sources.ts` next to the registry; DDL creation isolated in `importer.ts`; single validation path for custom definitions (built-ins validated by construction — documented deviation). No scope creep: every hunk maps to R1–R5 / Plan items.

#### P3 — Info

| # | Priority | Title | Dimension | Location | Recommendation |
|---|----------|-------|-----------|----------|----------------|
| 1 | P3 | Custom definition may reuse a built-in `source` name and share its checkpoint/ledger namespace | Architecture | `packages/llm-jsonl-importer/src/sources.ts:179-184`, `packages/llm-jsonl-importer/src/importer.ts:76-77` | Caller-chosen and consistent with the open-registry design (`definition.source` is the provenance key). If a collision ever bites, add an opt-in warning when a custom definition's `source` matches a built-in key — not worth the surface now. |

#### Verdict

**PASS.** 0 blockers, 0 majors. The fix pass repaired five initial gaps (see `### Testing` → Fix pass); all re-verified green this run.
### Testing
Verified 2026-07-31 via `/sp:dev-verify 0044 --auto --force --focus all --fix all`. Initial verdict PARTIAL; fix pass repaired all findings; final verdict **PASS**.

**Requirements Traceability**

| Req | Status | Evidence |
|-----|--------|----------|
| R1 — widen three `source` fields to `string` | MET | `packages/llm-jsonl-importer/src/types.ts:35` (`TransformContext.source`), `packages/llm-jsonl-importer/src/types.ts:44` (`SourceDefinition.source`), `packages/llm-jsonl-importer/src/types.ts:90` (`ImportResult.source`) — all re-read this run; `LlmJsonlSource` kept as `SOURCE_DEFINITIONS` key type |
| R2 — `runJsonlImport(source \| SourceDefinition, …)` | MET | `packages/llm-jsonl-importer/src/importer.ts:75-76` (union param + resolution before any I/O); `packages/llm-jsonl-importer/src/sources.ts:179-184` (`resolveSourceDefinition`); `packages/llm-jsonl-importer/src/sources.ts:124-130` (unknown string → `HistoryImportError`); test `packages/llm-jsonl-importer/tests/importer.test.ts:517` |
| R3 — validation fencing | MET | `packages/llm-jsonl-importer/src/sources.ts:141-167` (`validateSourceDefinition`: required fields, non-empty `filePatterns` at `:161`, `targetTable` + `splitConfig.targetTable` vs `VALID_TABLE_NAME`); second fence at write seam `packages/llm-jsonl-importer/src/importer.ts:383-388` (`targetTableFor`); per-record zod fence unchanged; tests `:531, :545, :554, :560` |
| R4 — backward compatibility + CHANGELOG | MET | Pre-existing built-in tests unchanged and green — claude incremental checkpoint resume (`packages/llm-jsonl-importer/tests/importer.test.ts:41-72`) proves checkpoint keys bit-identical; parity test `:589` (string vs object def, identical throughput); root `CHANGELOG.md` `[Unreleased]/Added` entry (repo convention: single lockstep CHANGELOG; no package-level file exists) |
| R5 — tests (a)–(d), no `.skip` | MET | (a) `:480`, (b) `:531`, (c) `:565`, (d) `:517`; `rg "skip\("` over `packages/llm-jsonl-importer/tests/` → no matches |

**Acceptance Criteria Verification**

| AC | Status | Evidence Type | Evidence |
|----|--------|---------------|----------|
| R2 — Custom definition imports into its target table | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:480` — 2 records → `importedRecords` 2, both rows in `history_etl_acme`, ledger + checkpoint rows keyed `source: 'acme'` |
| R2b — Unknown source name fails loud | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:517` — rejects `HistoryImportError`, message names `'not-a-real-source'`; ledger table never created |
| R3 — Invalid target table rejected before any write | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:531` — rejects through `runJsonlImport` naming `'droptable_users'`; `history_import_ledger` never created (no schema/checkpoint writes) |
| R3b — Split target table is fenced too | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:545` — split override rejected by `validateSourceDefinition` (uses `'history_etl_'`; scenario's `'evil_table'` fails the same prefix gate) |
| R3c — Schema mismatch recorded, not persisted | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:565` — `validationErrors[0]` names the file + line 2; only the valid row persisted |
| R4 — Built-in source name behaves exactly as before | MET | test | `packages/llm-jsonl-importer/tests/importer.test.ts:41-72` (pre-existing claude incremental resume) + `:589` (built-in string vs mirrored object def → identical counts/errors) |

**Checks**

| Check | Status | Evidence |
|-------|--------|----------|
| design-conformance | pass | 6/7 claims DONE; 1 CHANGED — built-ins skip `validateSourceDefinition` (documented in Solution §Resolution semantics; goal-equivalent: built-ins are known-good by construction) |
| spur-check | pass | exit 0 this run: Biome + per-package `tsc --noEmit` + 1694/1694 tests + `recommended-pre-check` + `recommended-post-check` (coverage-gate, every-export-has-tsdoc), all `--fail-on warning` |
| package suite | pass | 43/43 tests in `packages/llm-jsonl-importer/tests/` (bun test, this run) |
| scope-creep | pass | every diff hunk maps to R1–R5 / Plan items (4 source files + tests + README + CHANGELOG) |

**Fix pass (`--fix all`)** — repairs applied after the initial PARTIAL, each re-verified by the suites above:

- AC R3c was UNMET (no custom-definition schema-mismatch test) → added `packages/llm-jsonl-importer/tests/importer.test.ts:565`.
- AC R3 was tested only at `validateSourceDefinition` level → rewrote `:531` to reject through `runJsonlImport` with a no-writes assertion.
- AC R2 letter (two records / `importedRecords` 2) → `:480` now imports 2 records and asserts both rows.
- AC R2b letter (error names the source) → `:517` asserts message `/not-a-real-source/`.
- R3 "non-empty `filePatterns`" was unchecked → `packages/llm-jsonl-importer/src/sources.ts:161-166` + test `:560`.
- Gitignored artifacts touched: `.spur/run/0044-verdict.json` (written this run, final verdict only).

**SECUA summary** — no blocker/major findings. Table names are gated at entry (`validateSourceDefinition`) and again at the write seam (`targetTableFor`); no injection surface, no secrets, no new deps. Minor (advisory): a custom definition may reuse a built-in `source` name and thereby share its checkpoint namespace — caller-chosen, consistent with the open-registry design. Coverage: measured — `coverage-gate` rule PASS (runtime code path added).
### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References




### History

- Migrated from legacy format (2026-07-31)
- 2026-07-31T17:56:01.397Z backlog → todo (system)
- 2026-07-31T17:56:01.529Z todo → wip (system)
- 2026-07-31T18:03:05.102Z wip → testing (system)
- 2026-07-31T18:22:17.067Z testing → done (system)
