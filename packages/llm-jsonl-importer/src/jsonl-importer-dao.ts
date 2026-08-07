import { HistoryImportError } from './errors';
import { HISTORY_IMPORT_SCHEMA_SQL } from './schema-sql';
import { VALID_TABLE_NAME } from './sources';
import type { ImportOptions, JsonObject, SourceDefinition } from './types';

interface CheckpointRow {
    readonly last_imported_line: number;
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
        'args_digest',
        'status',
        'started_at',
        'completed_at',
        'duration_ms',
        'result_bytes',
        'error_text',
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

/** Apply importer-owned schema to the target database. */
export async function applyHistoryImportSchema(db: ImportOptions['db']): Promise<void> {
    for (const statement of HISTORY_IMPORT_SCHEMA_SQL.split(';')) {
        const sql = statement.trim();
        if (sql.length > 0) {
            await db.exec(sql);
        }
    }
}

/**
 * Ensure the ETL table(s) for a source definition exist.
 *
 * WHY: the static {@link HISTORY_IMPORT_SCHEMA_SQL} only creates the built-in
 * `history_etl_*` tables and the typed contract tables. Custom source definitions
 * (and built-in definitions with a `splitConfig.targetTable` override) need their
 * target table(s) created on demand. The table name is already gated by
 * {@link VALID_TABLE_NAME} in {@link validateSourceDefinition} / {@link targetTableFor},
 * so it is safe to interpolate into DDL. `CREATE TABLE IF NOT EXISTS` makes this
 * idempotent for built-in tables that the static schema already created.
 */
async function ensureTargetTables(db: ImportOptions['db'], definition: SourceDefinition): Promise<void> {
    const tables = new Set<string>([targetTableFor(definition.targetTable)]);
    if (definition.splitConfig.mode !== 'one-to-one' && definition.splitConfig.targetTable !== undefined) {
        tables.add(targetTableFor(definition.splitConfig.targetTable));
    }
    for (const table of tables) {
        // Typed tables are created by the static schema; use ETL DDL for custom tables.
        if (TYPED_TABLE_COLUMNS[table] !== undefined) continue;
        await db.exec(ETL_TABLE_DDL(table));
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

const _ensuredTables = new Set<string>();

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
        if (!_ensuredTables.has(table)) {
            // Typed tables are created by the static schema in applyHistoryImportSchema.
            _ensuredTables.add(table);
        }
        await db.run(
            `INSERT INTO ${table} (${typedColumns.join(', ')})
             VALUES (${typedColumns.map(() => '?').join(', ')})
             ON CONFLICT(record_hash) DO NOTHING`,
            ...values,
        );
    } else {
        // Generic ETL insert path: store as payload_json blob.
        if (!_ensuredTables.has(table)) {
            await db.exec(ETL_TABLE_DDL(table));
            _ensuredTables.add(table);
        }
        await db.run(
            `INSERT INTO ${table} (record_hash, source_file, source_line, split_index, payload_json, imported_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(record_hash) DO NOTHING`,
            recordHash,
            sourceFile,
            sourceLine,
            splitIndex,
            JSON.stringify(payload),
            timestamp(now),
        );
    }
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

export type { CheckpointRow };
export {
    ETL_TABLE_DDL,
    ensureTargetTables,
    insertLedger,
    insertRecord,
    ledgerExists,
    readCheckpoint,
    resetCheckpoints,
    targetTableFor,
    timestamp,
    writeCheckpoint,
};
