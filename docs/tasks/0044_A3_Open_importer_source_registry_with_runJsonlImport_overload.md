---
schema_version: 1
name: "A3: Open importer source registry with runJsonlImport overload"
status: backlog
type: task
priority: P3
tags: [adr,llm-jsonl-importer,advisory]
dependencies: ["0041"]
created_at: 2026-07-11T06:07:57.882Z
updated_at: "2026-07-31T17:33:29.087Z"
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



### Plan
1. `src/types.ts` — widen `SourceDefinition.source`, `TransformContext.source`, `ImportResult.source` to `string`; update doc comments (built-in names remain the `LlmJsonlSource` union).
2. `src/sources.ts` — add `validateSourceDefinition(def): SourceDefinition` (fail-fast fence per Design); harden `getSourceDefinition` to throw `HistoryImportError` on unknown names.
3. `src/importer.ts` — change `runJsonlImport` first param to `LlmJsonlSource | SourceDefinition`; resolve/validate the definition before `applyHistoryImportSchema`; switch all downstream `source` uses to `definition.source`.
4. `tests/importer.test.ts` — add the R5 cases (a)–(d) using the existing in-memory DbAdapter fixture; assert AC scenarios R2/R2b/R3/R3b/R3c/R4.
5. `README.md` (package) — short "Custom source definition" example mirroring the overload.
6. Package `CHANGELOG.md` — Unreleased note: new overload + `string` widening of the three `source` fields (type-level break, no runtime change).
7. `bun run spur-check` clean.
### Review



### Testing



### Artifacts

| Type | Path | Agent | Date |
| ---- | ---- | ----- | ---- |

### References




### History

- Migrated from legacy format (2026-07-31)
