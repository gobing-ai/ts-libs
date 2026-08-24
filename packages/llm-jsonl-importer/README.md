# @gobing-ai/ts-llm-jsonl-importer

Generic JSONL import pipeline for AI-agent history-style files: discover files, parse rows, normalize source fields, redact sensitive values, deduplicate by ledger hash, and persist ETL rows.

## What It Provides

`ts-llm-jsonl-importer` is a common JSONL importer. It is intentionally not a conversation-history domain model. Built-in source definitions cover common agent file shapes, but downstream systems consume normalized ETL rows and ledger metadata.

| Export | Purpose |
|--------|---------|
| `runJsonlImport()` | Runs discovery, parsing, validation, redaction, dedupe, and persistence. Accepts a built-in source string **or** a custom `SourceDefinition`. |
| `applyHistoryImportSchema()` | Installs importer-owned checkpoint, ledger, and typed contract tables |
| `SOURCE_DEFINITIONS` | Built-in source definitions |
| `getSourceDefinition()` | Returns one built-in definition by key (throws `HistoryImportError` for unknown keys) |
| `resolveSourceDefinition()` | Resolves a `string \| SourceDefinition` into a validated definition |
| `validateSourceDefinition()` | Validates a custom definition (target-table names, required fields) before pipeline entry |
| `VALID_TABLE_NAME` | Regex governing every importer-owned ETL table name |
| `redactRecord()` / `redactValue()` | Applies redaction rules before persistence |
| `sha256()` / `stableJson()` | Stable hash helpers used by the ledger |
| `HISTORY_IMPORT_SCHEMA_SQL` | SQL schema string for explicit migration flows |

Built-in source keys are `claude`, `codex`, `gemini`, `pi`, `opencode`, `antigravity`, `openclaw`, `omp`, `grok`, and `agy`.

## Installation

```bash
bun add @gobing-ai/ts-llm-jsonl-importer @gobing-ai/ts-db
```

The importer expects a `DbAdapter`-compatible object from `@gobing-ai/ts-db`.

## Basic Import

```ts
import { createDbAdapter } from '@gobing-ai/ts-db';
import { runJsonlImport } from '@gobing-ai/ts-llm-jsonl-importer';

const db = await createDbAdapter({ driver: 'bun-sqlite', url: './history-import.db' });

const result = await runJsonlImport('codex', {
    db,
    roots: ['./agent-history'],
    mode: 'incremental',
});

result.importedRecords;
result.skippedDuplicates;
```

`runJsonlImport()` applies the package-owned schema automatically before processing. Use `applyHistoryImportSchema(db)` directly when your application has an explicit migration step.

## Import Modes

| Mode | Behavior |
|------|----------|
| `incremental` | Reads each file from the last imported line checkpoint |
| `full` | Clears checkpoints for selected files, scans all lines, and still deduplicates by ledger hash |
| `force-file` | Scans selected files without using the checkpoint, while preserving ledger-based duplicate protection |

All modes preserve parse and validation issues in the returned `ImportResult`; malformed rows are not inserted.

## Streaming

The importer uses `FileSystem.readFileStream` when available (ADR-021), reading one line at a time
for **O(line) memory usage** — enabling multi-MB or multi-GB LLM history files without buffering
the entire file. Behavior is identical to the previous `readFile` + split approach (same `source_line`
values, same `ImportResult`).

When `readFileStream` is unavailable (e.g. Cloudflare Workers), the importer falls back to
`readFile` + split transparently.

## Import Specific Files

```ts
const result = await runJsonlImport('pi', {
    db,
    files: ['/tmp/session-1.jsonl', '/tmp/session-2.jsonl'],
    mode: 'full',
    now: () => new Date(),
});
```

When `files` is provided, roots are ignored. When roots are provided, the importer walks each root and selects files matching the source definition's patterns.

## Redaction

Redaction runs before hashing and persistence, so the ledger hash represents the persisted redacted payload.

```ts
import { DEFAULT_REDACTION_RULES, runJsonlImport } from '@gobing-ai/ts-llm-jsonl-importer';

await runJsonlImport('openclaw', {
    db,
    roots: ['./history'],
    redactionRules: [
        ...DEFAULT_REDACTION_RULES,
        { name: 'account-id', pattern: /acct_[a-z0-9]+/gi, replacement: '[REDACTED:account]' },
    ],
});
```

Rules are applied recursively to string fields in the normalized record.

## Result Shape

```ts
interface ImportResult {
    source: string;
    mode: 'incremental' | 'full' | 'force-file';
    scannedFiles: number;
    processedLines: number;
    importedRecords: number;
    skippedDuplicates: number;
    parseErrors: ImportIssue[];
    validationErrors: ImportIssue[];
    checkpointUpdates: number;
}
```

Use `parseErrors` for invalid JSON or non-object rows. Use `validationErrors` for source rows that parse but fail the source definition schema.

## Stored Tables

The schema contains:

| Table | Purpose |
|-------|---------|
| `history_import_checkpoint` | Per-source/per-file last imported line |
| `history_import_ledger` | Stable hash ledger for dedupe and provenance |
| `history_message` | Typed normalized messages from built-in forensic mappers |
| `history_tool_call` | Typed normalized tool calls from built-in forensic mappers |
| `history_etl_<source>` | Redacted payloads for generic/custom definitions; created only after an accepted row targets one |

Generic ETL tables store normalized payload JSON plus source file, source line, split index, hash, and timestamps.
Schema setup, empty scans, validation failures, and dry runs do not create empty ETL tables.
Claude tool results copy native `toolUseResult.durationMs` or `durationSeconds` into `duration_ms`; absent timing
stays `NULL` and is never inferred from message timestamps.

## Split Records

A source can split one JSONL row into several typed or generic records. Built-in source mappers normalize supported records into `history_message` and `history_tool_call`; custom definitions may target a generic ETL table.

```ts
const result = await runJsonlImport('pi', { db, files: ['session.jsonl'], mode: 'full' });
```

Downstream consumers should treat `source_file`, `source_line`, and `split_index` as the stable provenance tuple.

## Custom Source Definitions

Beyond the built-in source keys, `runJsonlImport()` accepts a fully-specified `SourceDefinition`
for any custom agent history format. Unknown strings throw `HistoryImportError`; custom definitions
are validated before any I/O (target-table names must match `VALID_TABLE_NAME` = `/^history_[a-z_]+$/`,
covering `history_etl_*` blob tables and the typed `history_message` / `history_tool_call` tables,
and required fields must be present).

```ts
import { z } from 'zod';
import { createDbAdapter } from '@gobing-ai/ts-db';
import { runJsonlImport, type SourceDefinition } from '@gobing-ai/ts-llm-jsonl-importer';

const acme: SourceDefinition = {
    source: 'acme',
    displayName: 'Acme Assistant',
    defaultRoots: ['.acme'],
    filePatterns: ['*.jsonl'],
    targetTable: 'history_etl_acme',
    splitConfig: { mode: 'one-to-one' },
    fieldMap: { id: 'source_record_id', timestamp: 'created_at', content: 'content' },
    fieldTransforms: {},
    schema: z.object({
        source_record_id: z.string().min(1),
        created_at: z.string().min(1),
        content: z.string().min(1),
    }),
};

const db = await createDbAdapter({ driver: 'bun-sqlite', url: './history.db' });
const result = await runJsonlImport(acme, { db, roots: ['~/.acme'], mode: 'incremental' });
```

The custom `source` name flows through checkpoints, the ledger, and `ImportResult.source` exactly
like a built-in key. The importer creates the target ETL table on demand if it does not exist
(idempotent `CREATE TABLE IF NOT EXISTS`), so built-in tables are unaffected.

## Boundary Notes

- This package imports JSONL files and writes importer-owned tables; it does not model conversations, turns, tool calls, or analytics semantics.
- Source definitions are the normalization boundary. Downstream applications own domain-specific interpretation of ETL rows.
- The importer never stores raw malformed rows. Parse and validation failures are reported in memory through `ImportResult`.
