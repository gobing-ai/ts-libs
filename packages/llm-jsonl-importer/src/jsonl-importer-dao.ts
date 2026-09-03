import type { DbAdapter, DbBatchOp } from '@gobing-ai/ts-db';
import { HistoryImportError } from './errors';
import { HISTORY_IMPORT_SCHEMA_SQL } from './schema-sql';
import { VALID_TABLE_NAME } from './sources';
import type { ImportOptions, JsonObject, ReconcileSummary, SourceDefinition } from './types';

interface CheckpointRow {
    readonly last_imported_line: number;
    readonly source_size?: number | null;
    readonly source_mtime_ms?: number | null;
}

/** File identity + line for one checkpoint row (0675 R1/R5). */
export interface SourceCheckpoint {
    readonly line: number;
    readonly size: number | null;
    readonly mtimeMs: number | null;
}

/** Column allowlist per typed contract table; order is the INSERT column order. */
const TYPED_TABLE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
    history_message: [
        'record_hash',
        'source',
        'source_file',
        'source_line',
        'session_id',
        'seq',
        'turn_index',
        'role',
        'record_type',
        'disposition',
        'ts',
        'duration_ms',
        'model',
        'input_tokens',
        'output_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'cost_usd',
        'content_text',
        'cwd',
        'provenance',
        'run_id',
        'task_wbs',
        'request_id',
        'imported_at',
    ],
    history_tool_call: [
        'record_hash',
        'message_hash',
        'source',
        'source_file',
        'source_line',
        'session_id',
        'seq',
        'tool_name',
        'call_id',
        'args_digest',
        'args_raw',
        'status',
        'started_at',
        'completed_at',
        'duration_ms',
        'result_bytes',
        'error_text',
        'imported_at',
    ],
    history_skill_call: [
        'record_hash',
        'message_hash',
        'source',
        'source_file',
        'source_line',
        'session_id',
        'seq',
        'skill_name',
        'invocation_kind',
        'skill_path',
        'args_raw',
        'args_digest',
        'call_id',
        'status',
        'started_at',
        'completed_at',
        'duration_ms',
        'imported_at',
    ],
};

/** Keys that a typed table mapper may produce that are not columns. */
const TYPED_IGNORED_KEYS = new Set<string>(['_meta', 'split_index']);

function targetTableFor(table: string): string {
    if (!VALID_TABLE_NAME.test(table)) {
        throw new HistoryImportError(`Invalid history ETL target table: ${table}`, { table });
    }
    return table;
}

function timestamp(now: ImportOptions['now']): string {
    return (now?.() ?? new Date()).toISOString();
}

function ETL_TABLE_DDL(table: string): string {
    return `CREATE TABLE IF NOT EXISTS ${table} (
    record_hash TEXT PRIMARY KEY,
    source_file TEXT NOT NULL,
    source_line INTEGER NOT NULL,
    split_index INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    imported_at TEXT NOT NULL
);`;
}

/**
 * Apply importer-owned schema to the target database.
 *
 * Creates the checkpoint, ledger, and typed contract tables from the static SQL.
 * Generic ETL tables are created lazily with the first accepted row, so applying
 * the schema or scanning an empty source never leaves vestigial empty tables.
 */
export async function applyHistoryImportSchema(db: ImportOptions['db']): Promise<void> {
    for (const statement of HISTORY_IMPORT_SCHEMA_SQL.split(';')) {
        const sql = statement.trim();
        if (sql.length > 0) {
            await db.exec(sql);
        }
    }
}

/** Ensure one accepted record's target exists; typed targets come from the static schema. */
async function ensureTargetTable(db: ImportOptions['db'], targetTable: string): Promise<void> {
    const table = targetTableFor(targetTable);
    if (TYPED_TABLE_COLUMNS[table] === undefined) await db.exec(ETL_TABLE_DDL(table));
}

/**
 * Ensure the ETL table(s) for a source definition exist.
 *
 * WHY: the static {@link HISTORY_IMPORT_SCHEMA_SQL} creates only the checkpoint, ledger, and
 * typed contract tables. Callers that explicitly request a definition's generic targets use this
 * helper; the import pipeline instead creates only targets reached by accepted rows. The
 * table name is already gated by
 * {@link VALID_TABLE_NAME} in {@link validateSourceDefinition} / {@link targetTableFor},
 * so it is safe to interpolate into DDL. `CREATE TABLE IF NOT EXISTS` is
 * idempotent, so apply-then-import and a second apply are both safe.
 */
async function ensureTargetTables(db: ImportOptions['db'], definition: SourceDefinition): Promise<void> {
    const tables = new Set<string>([targetTableFor(definition.targetTable)]);
    if (definition.splitConfig.mode !== 'one-to-one' && definition.splitConfig.targetTable !== undefined) {
        tables.add(targetTableFor(definition.splitConfig.targetTable));
    }
    for (const table of tables) {
        await ensureTargetTable(db, table);
    }
}

async function readCheckpoint(db: ImportOptions['db'], source: string, sourceFile: string): Promise<number> {
    const row = await db.queryFirst<CheckpointRow>(
        'SELECT last_imported_line FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
        source,
        sourceFile,
    );
    return row?.last_imported_line ?? 0;
}

/**
 * One query per source (0675 R5): all checkpoint rows for `source` keyed by file,
 * replacing the per-file SELECT in the import loop.
 *
 * Fails open when the identity columns are missing (0678): a database created through a
 * migration path that has not yet applied 0675's ALTERs would otherwise hard-fail every
 * import. Line-level behavior degrades to pre-identity semantics — the short-circuit
 * and identity stamping no-op until the columns exist.
 */
export async function loadSourceCheckpoints(
    db: ImportOptions['db'],
    source: string,
): Promise<Map<string, SourceCheckpoint>> {
    let rows: Array<CheckpointRow & { source_file: string }>;
    try {
        rows = await db.queryAll<CheckpointRow & { source_file: string }>(
            'SELECT source_file, last_imported_line, source_size, source_mtime_ms FROM history_import_checkpoint WHERE source = ?',
            source,
        );
    } catch (err) {
        if (!/no such column|source_size|source_mtime_ms/i.test((err as Error).message)) throw err;
        rows = (await db.queryAll<{ source_file: string; last_imported_line: number }>(
            'SELECT source_file, last_imported_line FROM history_import_checkpoint WHERE source = ?',
            source,
        )) as Array<CheckpointRow & { source_file: string }>;
        return new Map(
            rows.map((row) => [row.source_file, { line: row.last_imported_line, size: null, mtimeMs: null }]),
        );
    }
    const map = new Map<string, SourceCheckpoint>();
    for (const row of rows) {
        map.set(row.source_file, {
            line: row.last_imported_line,
            size: row.source_size ?? null,
            mtimeMs: row.source_mtime_ms ?? null,
        });
    }
    return map;
}

async function resetCheckpoints(db: ImportOptions['db'], source: string, files: readonly string[]): Promise<void> {
    for (const file of files) {
        await db.run('DELETE FROM history_import_checkpoint WHERE source = ? AND source_file = ?', source, file);
    }
}

async function writeCheckpoint(
    db: ImportOptions['db'],
    source: string,
    sourceFile: string,
    line: number,
    now: ImportOptions['now'],
): Promise<void> {
    await db.run(
        `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(source, source_file) DO UPDATE SET
            last_imported_line = excluded.last_imported_line,
            updated_at = excluded.updated_at`,
        source,
        sourceFile,
        line,
        timestamp(now),
    );
}

async function ledgerExists(db: ImportOptions['db'], recordHash: string): Promise<boolean> {
    const row = await db.queryFirst<{ record_hash: string }>(
        'SELECT record_hash FROM history_import_ledger WHERE record_hash = ?',
        recordHash,
    );
    return row !== undefined && row !== null;
}

/**
 * INSERT op for one accepted record row (task 0060 F9). Pure builder so the
 * per-record batch path and the single-write `insertRecord` can never drift.
 * Typed tables validate unknown keys here; the caller must have ensured the
 * target table exists (the import loop ensures accepted targets before batching).
 */
export function recordInsertOp(
    targetTable: string,
    recordHash: string,
    sourceFile: string,
    sourceLine: number,
    splitIndex: number,
    payload: JsonObject,
    now: ImportOptions['now'],
): DbBatchOp {
    const table = targetTableFor(targetTable);
    const typedColumns = TYPED_TABLE_COLUMNS[table];
    if (typedColumns !== undefined) {
        // Typed insert path: map each column from the payload, assert no unknown keys.
        const unknownKeys = Object.keys(payload).filter((k) => !typedColumns.includes(k) && !TYPED_IGNORED_KEYS.has(k));
        if (unknownKeys.length > 0) {
            throw new HistoryImportError(
                `Typed table "${table}" has unknown columns: ${unknownKeys.join(', ')}. ` +
                    `Expected one of: ${typedColumns.join(', ')}.`,
                { table, unknownKeys, knownColumns: typedColumns },
            );
        }
        // record_hash and imported_at come from the function parameters, not the payload.
        const ts = timestamp(now);
        const values = typedColumns.map((col) => {
            if (col === 'record_hash') return recordHash;
            if (col === 'imported_at') return ts;
            const v = payload[col];
            return v === undefined ? null : v;
        });
        return {
            sql: `INSERT INTO ${table} (${typedColumns.join(', ')})
                 VALUES (${typedColumns.map(() => '?').join(', ')})
                 ON CONFLICT(record_hash) DO NOTHING`,
            params: values,
        };
    }
    // Generic ETL insert path: store as payload_json blob.
    return {
        sql: `INSERT INTO ${table} (record_hash, source_file, source_line, split_index, payload_json, imported_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(record_hash) DO NOTHING`,
        params: [recordHash, sourceFile, sourceLine, splitIndex, JSON.stringify(payload), timestamp(now)],
    };
}

/** INSERT op for one ledger row (task 0060 F9). */
export function ledgerInsertOp(
    recordHash: string,
    source: string,
    sourceFile: string,
    sourceLine: number,
    splitIndex: number,
    targetTable: string,
    now: ImportOptions['now'],
): DbBatchOp {
    return {
        sql: `INSERT INTO history_import_ledger (record_hash, source, source_file, source_line, split_index, target_table, imported_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [recordHash, source, sourceFile, sourceLine, splitIndex, targetTable, timestamp(now)],
    };
}

/** UPSERT op for one checkpoint row (task 0060 F9: checkpoint joins the record batch). */
export function checkpointUpsertOp(
    source: string,
    sourceFile: string,
    line: number,
    now: ImportOptions['now'],
    identity?: { readonly size: number | null; readonly mtimeMs: number | null },
): DbBatchOp {
    return {
        sql: `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, source_size, source_mtime_ms, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(source, source_file) DO UPDATE SET
                last_imported_line = excluded.last_imported_line,
                source_size = excluded.source_size,
                source_mtime_ms = excluded.source_mtime_ms,
                updated_at = excluded.updated_at`,
        params: [source, sourceFile, line, identity?.size ?? null, identity?.mtimeMs ?? null, timestamp(now)],
    };
}

/**
 * Targeted UPDATE op attaching a tool duration to a previously-inserted
 * `history_tool_call` row (task 0564 R1). Keyed by `record_hash` (PK), never an
 * unindexed predicate. Idempotent: re-imports write the same values.
 *
 * Bounds are written alongside a FALLBACK duration so the figure is auditable;
 * a wallTimeMs-derived duration keeps `started_at`/`completed_at` NULL so the
 * two measurement paths stay distinguishable.
 */
function toolCallDurationUpdateOp(
    recordHash: string,
    startedAt: string | null,
    completedAt: string | null,
    durationMs: number | null,
): DbBatchOp {
    return {
        sql: `UPDATE history_tool_call
              SET started_at = ?, completed_at = ?, duration_ms = ?
              WHERE record_hash = ?`,
        params: [startedAt, completedAt, durationMs, recordHash],
    };
}

/**
 * Targeted UPDATE op attaching a result size to a previously-inserted
 * `history_tool_call` row (task 0624 R2). Keyed by `record_hash` (PK). Idempotent.
 */
function toolCallResultBytesUpdateOp(recordHash: string, resultBytes: number): DbBatchOp {
    return {
        sql: `UPDATE history_tool_call
              SET result_bytes = ?
              WHERE record_hash = ?`,
        params: [resultBytes, recordHash],
    };
}

/** Targeted UPDATE op attributing a codex usage-carrier row's token counts to the
 *  latest assistant message of its session (task 0678 R3). Keyed by `record_hash` (PK). */
export function codexUsageAttributionUpdateOp(
    recordHash: string,
    tokens: { readonly input: number | null; readonly output: number | null; readonly cacheRead: number | null },
): DbBatchOp {
    return {
        sql: `UPDATE history_message
              SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?
              WHERE record_hash = ?`,
        params: [tokens.input, tokens.output, tokens.cacheRead, recordHash],
    };
}

/**
 * Query which of the given hashes already exist in the ledger, in chunks of at
 * most 200 per `IN (...)` (task 0060 F9 — replaces the per-record SELECT loop).
 */
export async function ledgerExistingHashes(db: ImportOptions['db'], hashes: readonly string[]): Promise<Set<string>> {
    const existing = new Set<string>();
    for (let i = 0; i < hashes.length; i += 200) {
        const chunk = hashes.slice(i, i + 200);
        const placeholders = chunk.map(() => '?').join(', ');
        const rows = await db.queryAll<{ record_hash: string }>(
            `SELECT record_hash FROM history_import_ledger WHERE record_hash IN (${placeholders})`,
            ...chunk,
        );
        for (const row of rows) existing.add(row.record_hash);
    }
    return existing;
}

async function insertRecord(
    db: ImportOptions['db'],
    targetTable: string,
    recordHash: string,
    sourceFile: string,
    sourceLine: number,
    splitIndex: number,
    payload: JsonObject,
    now: ImportOptions['now'],
): Promise<void> {
    const op = recordInsertOp(targetTable, recordHash, sourceFile, sourceLine, splitIndex, payload, now);
    await ensureTargetTable(db, targetTable);
    await db.run(op.sql, ...op.params);
}

async function insertLedger(
    db: ImportOptions['db'],
    recordHash: string,
    source: string,
    sourceFile: string,
    sourceLine: number,
    splitIndex: number,
    targetTable: string,
    now: ImportOptions['now'],
): Promise<void> {
    await db.run(
        `INSERT INTO history_import_ledger (record_hash, source, source_file, source_line, split_index, target_table, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        recordHash,
        source,
        sourceFile,
        sourceLine,
        splitIndex,
        targetTable,
        timestamp(now),
    );
}

/**
 * Idempotent migration that rewrites `source_file` to its realpath across the checkpoint,
 * ledger, and any contract table present (R4).
 *
 * WHY: `record_hash` is `sha256({source, sourceFile, sourceLine, splitIndex, record})`, so
 * `sourceFile` is inside the hash. Normalizing its representation at discovery (R1) changes
 * every future hash; pre-normalization rows carry unnormalized paths and their old hashes
 * remain valid as dedupe keys. This migration rewrites the `source_file` *column* so old and
 * new rows agree on path identity, and collapses duplicate checkpoint rows produced when one
 * physical file was imported via both a symlinked and a real path — keeping the highest
 * `last_imported_line` so an incremental resume does not re-import already-seen content.
 *
 * `record_hash` is intentionally NOT touched: it is path-representation dependent by
 * construction, pre-migration rows are grandfathered, and recomputing it would require the
 * original record payload that the ledger does not store.
 *
 * @param resolveRealPath - resolves a `source_file` to its canonical real path. Falls back to
 *   the original value when it returns null/undefined or throws. Decouples the DAO from the
 *   runtime `FileSystem` seam.
 */
export async function normalizeSourceFilePaths(
    db: ImportOptions['db'],
    resolveRealPath: (sourceFile: string) => string | null | undefined,
): Promise<void> {
    await normalizeCheckpointPaths(db, resolveRealPath);
    await normalizeColumnPaths(db, resolveRealPath, 'history_import_ledger');
    for (const table of TYPED_TABLE_COLUMNS_SOURCE_FILE) {
        if (await tableExists(db, table)) {
            await normalizeColumnPaths(db, resolveRealPath, table);
        }
    }
    for (const table of await listEtlTables(db)) {
        await normalizeColumnPaths(db, resolveRealPath, table);
    }
}

/** Typed contract tables that carry a `source_file` column (0466 forensic contract). */
const TYPED_TABLE_COLUMNS_SOURCE_FILE = ['history_message', 'history_tool_call', 'history_skill_call'] as const;

async function tableExists(db: ImportOptions['db'], table: string): Promise<boolean> {
    const row = await db.queryFirst<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        table,
    );
    return row !== undefined && row !== null;
}

async function listEtlTables(db: ImportOptions['db']): Promise<string[]> {
    const rows = await db.queryAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'history_etl_%'",
    );
    return rows.map((row) => row.name);
}

/**
 * Normalize `source_file` in the checkpoint table, collapsing duplicate rows per
 * `(source, realpath)` by keeping the highest `last_imported_line`.
 */
async function normalizeCheckpointPaths(
    db: ImportOptions['db'],
    resolveRealPath: (sourceFile: string) => string | null | undefined,
): Promise<void> {
    const rows = await db.queryAll<{
        source: string;
        source_file: string;
        last_imported_line: number;
        source_size: number | null;
        source_mtime_ms: number | null;
        updated_at: string;
    }>(
        'SELECT source, source_file, last_imported_line, source_size, source_mtime_ms, updated_at FROM history_import_checkpoint',
    );
    // Collapse per (source, realPath) keeping the highest last_imported_line.
    const collapsed = new Map<
        string,
        {
            source: string;
            source_file: string;
            last_imported_line: number;
            source_size: number | null;
            source_mtime_ms: number | null;
            updated_at: string;
        }
    >();
    for (const row of rows) {
        const canonical = resolveWithFallback(resolveRealPath, row.source_file);
        const key = `${row.source}\u0000${canonical}`;
        const existing = collapsed.get(key);
        if (existing === undefined || row.last_imported_line > existing.last_imported_line) {
            collapsed.set(key, {
                source: row.source,
                source_file: canonical,
                last_imported_line: row.last_imported_line,
                source_size: row.source_size,
                source_mtime_ms: row.source_mtime_ms,
                updated_at: row.updated_at,
            });
        }
    }
    await db.exec('DELETE FROM history_import_checkpoint');
    for (const row of collapsed.values()) {
        await db.run(
            `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, source_size, source_mtime_ms, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            row.source,
            row.source_file,
            row.last_imported_line,
            row.source_size,
            row.source_mtime_ms,
            row.updated_at,
        );
    }
}

/** Normalize `source_file` in a table that stores it as a plain column. */
async function normalizeColumnPaths(
    db: ImportOptions['db'],
    resolveRealPath: (sourceFile: string) => string | null | undefined,
    table: string,
): Promise<void> {
    const rows = await db.queryAll<{ rowid: number; source_file: string }>(
        `SELECT rowid AS rowid, source_file FROM ${table} WHERE source_file IS NOT NULL`,
    );
    for (const row of rows) {
        const canonical = resolveWithFallback(resolveRealPath, row.source_file);
        if (canonical !== row.source_file) {
            await db.run(`UPDATE ${table} SET source_file = ? WHERE rowid = ?`, canonical, row.rowid);
        }
    }
}

function resolveWithFallback(
    resolveRealPath: (sourceFile: string) => string | null | undefined,
    sourceFile: string,
): string {
    try {
        return resolveRealPath(sourceFile) ?? sourceFile;
    } catch {
        return sourceFile;
    }
}

/**
 * Reconcile a source's persisted derived rows against the desired set produced by a full
 * import (task 0504 R1). Rows whose `record_hash` is no longer reproduced by current source
 * data or mapper output are stale: their target rows (typed contract tables — including tool
 * calls — and ETL tables), ledger rows, and checkpoints for vanished source files are removed
 * in ONE source-scoped batch (atomic). Dry-run returns the exact same counts without mutating
 * the database, so `--dry-run` is a safe preview and a second full write reports zero changes.
 *
 * Deletes are keyed by `record_hash` (PK) and checkpoint `(source, source_file)` (PK) — never
 * by an unindexed ledger predicate — so reconciliation cost scales with the stale count, not
 * with ledger size.
 */
async function reconcileFullImport(
    db: ImportOptions['db'],
    source: string,
    desiredHashes: ReadonlySet<string>,
    discoveredFiles: readonly string[],
    dryRun: boolean,
): Promise<ReconcileSummary> {
    const ledgerRows = await db.queryAll<{ record_hash: string; target_table: string }>(
        'SELECT record_hash, target_table FROM history_import_ledger WHERE source = ?',
        source,
    );
    const stale: { record_hash: string; target_table: string }[] = [];
    for (const row of ledgerRows) {
        if (!desiredHashes.has(row.record_hash)) stale.push(row);
    }

    const checkpointRows = await db.queryAll<{ source_file: string }>(
        'SELECT source_file FROM history_import_checkpoint WHERE source = ?',
        source,
    );
    const discovered = new Set(discoveredFiles);
    const staleCheckpoints = checkpointRows
        .map((row) => row.source_file)
        .filter((sourceFile) => !discovered.has(sourceFile));

    const summary: ReconcileSummary = {
        staleTargetRows: stale.length,
        staleLedgerRows: stale.length,
        staleCheckpointRows: staleCheckpoints.length,
    };
    if (dryRun || (stale.length === 0 && staleCheckpoints.length === 0)) return summary;

    const operations: DbBatchOp[] = [];
    for (const row of stale) {
        operations.push({
            sql: `DELETE FROM ${targetTableFor(row.target_table)} WHERE record_hash = ?`,
            params: [row.record_hash],
        });
        operations.push({
            sql: 'DELETE FROM history_import_ledger WHERE record_hash = ?',
            params: [row.record_hash],
        });
    }
    for (const sourceFile of staleCheckpoints) {
        operations.push({
            sql: 'DELETE FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
            params: [source, sourceFile],
        });
    }
    await db.batch(operations);
    return summary;
}

const OPENCODE_SOURCE = 'opencode';

/** OpenCode message row projected from its SQLite store. */
export interface OpenCodeMessageRow {
    id: string;
    session_id: string;
    time_created: number;
    data: string;
    directory: string;
}

/** OpenCode message-part row projected from its SQLite store. */
export interface OpenCodePartRow {
    id: string;
    message_id: string;
    time_created: number;
    data: string;
}

/** Previously imported OpenCode ledger entry. */
export interface OpenCodeExistingEntry {
    record_hash: string;
    target_table: string;
}

/** Normalized OpenCode entry awaiting a history-table write. */
export interface OpenCodeQueuedEntry {
    targetTable: 'history_message' | 'history_tool_call' | 'history_skill_call';
    splitIndex: number;
    record: JsonObject;
    recordHash: string;
    sourceFile: string;
}

/** Read one ordered page of OpenCode messages after the supplied cursor. */
export async function readOpenCodeMessages(
    db: DbAdapter,
    lastTime: number,
    lastId: string,
    limit: number,
): Promise<OpenCodeMessageRow[]> {
    return db.queryAll<OpenCodeMessageRow>(
        `SELECT m.id, m.session_id, m.time_created, m.data, s.directory
         FROM message m
         JOIN session s ON s.id = m.session_id
         WHERE m.time_created > ? OR (m.time_created = ? AND m.id > ?)
         ORDER BY m.time_created, m.id
         LIMIT ?`,
        lastTime,
        lastTime,
        lastId,
        limit,
    );
}

/** Read all parts belonging to the supplied OpenCode message IDs. */
export async function readOpenCodeParts(db: DbAdapter, messageIds: readonly string[]): Promise<OpenCodePartRow[]> {
    if (messageIds.length === 0) return [];
    return db.queryAll<OpenCodePartRow>(
        `SELECT id, message_id, time_created, data
         FROM part
         WHERE message_id IN (${messageIds.map(() => '?').join(', ')})
         ORDER BY time_created, id`,
        ...messageIds,
    );
}

/** Load existing OpenCode ledger entries grouped by source message ID. */
export async function readOpenCodeExistingEntries(db: DbAdapter): Promise<Map<string, OpenCodeExistingEntry[]>> {
    const rows = await db.queryAll<OpenCodeExistingEntry & { source_file: string }>(
        'SELECT source_file, record_hash, target_table FROM history_import_ledger WHERE source = ?',
        OPENCODE_SOURCE,
    );
    const bySourceFile = new Map<string, OpenCodeExistingEntry[]>();
    for (const row of rows) {
        const entries = bySourceFile.get(row.source_file) ?? [];
        entries.push({ record_hash: row.record_hash, target_table: row.target_table });
        bySourceFile.set(row.source_file, entries);
    }
    return bySourceFile;
}

/** Build deletion operations for records superseded by a forced import. */
export function openCodeDeleteOperations(entries: readonly OpenCodeExistingEntry[]): DbBatchOp[] {
    return entries.flatMap((entry) => [
        {
            sql: `DELETE FROM ${targetTableFor(entry.target_table)} WHERE record_hash = ?`,
            params: [entry.record_hash],
        },
        {
            sql: 'DELETE FROM history_import_ledger WHERE record_hash = ?',
            params: [entry.record_hash],
        },
    ]);
}

/** Build checkpoint deletion operation for a source file. */
export function deleteCheckpointOperation(source: string, sourceFile: string): DbBatchOp {
    return {
        sql: 'DELETE FROM history_import_checkpoint WHERE source = ? AND source_file = ?',
        params: [source, sourceFile],
    };
}

/** Build batched history, ledger, and checkpoint writes for OpenCode entries. */
export function openCodeBulkWriteOperations(
    entries: readonly OpenCodeQueuedEntry[],
    checkpointFiles: readonly string[],
    now: ImportOptions['now'],
): DbBatchOp[] {
    const importedAt = timestamp(now);
    const operations: DbBatchOp[] = [];
    for (const table of ['history_message', 'history_tool_call', 'history_skill_call'] as const) {
        const tableEntries = entries.filter((entry) => entry.targetTable === table);
        for (let offset = 0; offset < tableEntries.length; offset += 100) {
            const chunk = tableEntries.slice(offset, offset + 100);
            const columns = TYPED_TABLE_COLUMNS[table] ?? [];
            operations.push({
                sql: `WITH input(record_hash, payload_json, imported_at) AS (
                    VALUES ${chunk.map(() => '(?, ?, ?)').join(', ')}
                )
                INSERT INTO ${table} (${columns.join(', ')})
                SELECT ${columns
                    .map((column) =>
                        column === 'record_hash'
                            ? 'record_hash'
                            : column === 'imported_at'
                              ? 'imported_at'
                              : `json_extract(payload_json, '$.${column}')`,
                    )
                    .join(', ')}
                FROM input
                WHERE true
                ON CONFLICT(record_hash) DO NOTHING`,
                params: chunk.flatMap((entry) => [entry.recordHash, JSON.stringify(entry.record), importedAt]),
            });
        }
    }
    for (let offset = 0; offset < entries.length; offset += 200) {
        const chunk = entries.slice(offset, offset + 200);
        operations.push({
            sql: `INSERT INTO history_import_ledger
                (record_hash, source, source_file, source_line, split_index, target_table, imported_at)
                VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
            params: chunk.flatMap((entry) => [
                entry.recordHash,
                OPENCODE_SOURCE,
                entry.sourceFile,
                1,
                entry.splitIndex,
                entry.targetTable,
                importedAt,
            ]),
        });
    }
    for (let offset = 0; offset < checkpointFiles.length; offset += 200) {
        const chunk = checkpointFiles.slice(offset, offset + 200);
        operations.push({
            sql: `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, updated_at)
                VALUES ${chunk.map(() => '(?, ?, ?, ?)').join(', ')}
                ON CONFLICT(source, source_file) DO UPDATE SET
                    last_imported_line = excluded.last_imported_line,
                    updated_at = excluded.updated_at`,
            params: chunk.flatMap((sourceFile) => [OPENCODE_SOURCE, sourceFile, 1, importedAt]),
        });
    }
    return operations;
}

export type { CheckpointRow };
export {
    ETL_TABLE_DDL,
    ensureTargetTable,
    ensureTargetTables,
    insertLedger,
    insertRecord,
    ledgerExists,
    readCheckpoint,
    reconcileFullImport,
    resetCheckpoints,
    targetTableFor,
    timestamp,
    toolCallDurationUpdateOp,
    toolCallResultBytesUpdateOp,
    writeCheckpoint,
};
