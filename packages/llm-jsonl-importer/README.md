# @gobing-ai/ts-llm-jsonl-importer

Generic JSONL import pipeline for AI-agent history-style files: discover files, parse rows, normalize source fields, redact sensitive values, deduplicate by ledger hash, and persist ETL rows.

## What It Provides

`ts-llm-jsonl-importer` is a common JSONL importer. It is intentionally not a conversation-history domain model. Built-in source definitions cover common agent file shapes, but downstream systems consume normalized ETL rows and ledger metadata.

| Export | Purpose |
|--------|---------|
| `runJsonlImport()` | Runs discovery, parsing, validation, redaction, dedupe, and persistence |
| `applyHistoryImportSchema()` | Installs importer-owned checkpoint, ledger, and ETL tables |
| `SOURCE_DEFINITIONS` | Built-in source definitions |
| `getSourceDefinition()` | Returns one source definition by key |
| `redactRecord()` / `redactValue()` | Applies redaction rules before persistence |
| `sha256()` / `stableJson()` | Stable hash helpers used by the ledger |
| `HISTORY_IMPORT_SCHEMA_SQL` | SQL schema string for explicit migration flows |

Built-in source keys are `claude`, `codex`, `gemini`, `pi`, `opencode`, `antigravity`, and `openclaw`.

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

console.log(result.importedRecords, result.skippedDuplicates);
```

`runJsonlImport()` applies the package-owned schema automatically before processing. Use `applyHistoryImportSchema(db)` directly when your application has an explicit migration step.

## Import Modes

| Mode | Behavior |
|------|----------|
| `incremental` | Reads each file from the last imported line checkpoint |
| `full` | Clears checkpoints for selected files, scans all lines, and still deduplicates by ledger hash |
| `force-file` | Scans selected files without using the checkpoint, while preserving ledger-based duplicate protection |

All modes preserve parse and validation issues in the returned `ImportResult`; malformed rows are not inserted.

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
| `history_etl_<source>` | Redacted normalized payloads for each built-in source |

ETL tables store the normalized payload JSON plus source file, source line, split index, hash, and timestamps.

## Split Records

Most sources are one input row to one ETL row. A source can also split one JSONL row into multiple ETL records. The built-in `pi` definition splits nested `messages` into one row per message when present.

```ts
const result = await runJsonlImport('pi', { db, files: ['session.jsonl'], mode: 'full' });
```

Downstream consumers should treat `source_file`, `source_line`, and `split_index` as the stable provenance tuple.

## Boundary Notes

- This package imports JSONL files and writes importer-owned tables; it does not model conversations, turns, tool calls, or analytics semantics.
- Source definitions are the normalization boundary. Downstream applications own domain-specific interpretation of ETL rows.
- The importer never stores raw malformed rows. Parse and validation failures are reported in memory through `ImportResult`.
