import { beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { HistoryImportError } from '../src';
import {
    applyHistoryImportSchema,
    ETL_TABLE_DDL,
    insertLedger,
    insertRecord,
    ledgerExists,
    normalizeSourceFilePaths,
    readCheckpoint,
    resetCheckpoints,
    targetTableFor,
    writeCheckpoint,
} from '../src/jsonl-importer-dao';

let db: DbAdapter;

beforeEach(async () => {
    db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
});

describe('applyHistoryImportSchema', () => {
    test('creates checkpoint, ledger, and built-in ETL tables', async () => {
        await applyHistoryImportSchema(db);

        const tables = await db.queryAll<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        );
        const names = tables.map((t) => t.name);
        expect(names).toContain('history_import_checkpoint');
        expect(names).toContain('history_import_ledger');
        expect(names).toContain('history_etl_claude');
        expect(names).toContain('history_etl_codex');
    });

    test('is idempotent when called twice', async () => {
        await applyHistoryImportSchema(db);
        await applyHistoryImportSchema(db);

        const tables = await db.queryAll<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        );
        expect(tables.length).toBeGreaterThan(0);
    });
});

describe('ETL_TABLE_DDL', () => {
    test('generates CREATE TABLE IF NOT EXISTS for the given table name', () => {
        const sql = ETL_TABLE_DDL('history_etl_test');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS history_etl_test');
        expect(sql).toContain('record_hash TEXT PRIMARY KEY');
    });
});

describe('targetTableFor', () => {
    test('returns the table name when it matches VALID_TABLE_NAME', () => {
        expect(targetTableFor('history_etl_test')).toBe('history_etl_test');
    });

    test('throws HistoryImportError for invalid table names', () => {
        expect(() => targetTableFor('users')).toThrow(HistoryImportError);
        expect(() => targetTableFor('DROP TABLE users')).toThrow(HistoryImportError);
    });
});

describe('checkpoint operations', () => {
    const source = 'test-source';
    const sourceFile = '/tmp/test.jsonl';

    beforeEach(async () => {
        await applyHistoryImportSchema(db);
    });

    test('readCheckpoint returns 0 when no checkpoint exists', async () => {
        const line = await readCheckpoint(db, source, sourceFile);
        expect(line).toBe(0);
    });

    test('writeCheckpoint then readCheckpoint round-trips', async () => {
        await writeCheckpoint(db, source, sourceFile, 42, undefined);
        const line = await readCheckpoint(db, source, sourceFile);
        expect(line).toBe(42);
    });

    test('writeCheckpoint updates existing checkpoint', async () => {
        await writeCheckpoint(db, source, sourceFile, 10, undefined);
        await writeCheckpoint(db, source, sourceFile, 25, undefined);
        const line = await readCheckpoint(db, source, sourceFile);
        expect(line).toBe(25);
    });

    test('resetCheckpoints deletes checkpoints for the given files', async () => {
        await writeCheckpoint(db, source, sourceFile, 42, undefined);
        await resetCheckpoints(db, source, [sourceFile]);
        const line = await readCheckpoint(db, source, sourceFile);
        expect(line).toBe(0);
    });
});

describe('ledger operations', () => {
    const recordHash = 'abc123def456';

    beforeEach(async () => {
        await applyHistoryImportSchema(db);
    });

    test('ledgerExists returns false for unknown hash', async () => {
        const exists = await ledgerExists(db, 'unknown');
        expect(exists).toBe(false);
    });

    test('insertLedger then ledgerExists returns true', async () => {
        await insertLedger(db, recordHash, 'test-source', '/tmp/f.json', 1, 0, 'history_etl_test', undefined);
        const exists = await ledgerExists(db, recordHash);
        expect(exists).toBe(true);
    });
});

describe('insertRecord', () => {
    beforeEach(async () => {
        await applyHistoryImportSchema(db);
    });

    test('inserts a record into the target ETL table', async () => {
        await insertRecord(db, 'history_etl_codex', 'hash1', '/tmp/f.json', 1, 0, { content: 'hello' }, undefined);

        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_codex');
        expect(rows).toHaveLength(1);
        const row = rows[0] as { payload_json: string };
        expect(JSON.parse(row.payload_json)).toEqual({ content: 'hello' });
    });

    test('is idempotent on duplicate record_hash', async () => {
        await insertRecord(db, 'history_etl_codex', 'hash1', '/tmp/f.json', 1, 0, { content: 'a' }, undefined);
        await insertRecord(db, 'history_etl_codex', 'hash1', '/tmp/f.json', 1, 0, { content: 'b' }, undefined);

        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_codex');
        expect(rows).toHaveLength(1);
        const row = rows[0] as { payload_json: string };
        expect(JSON.parse(row.payload_json)).toEqual({ content: 'a' });
    });
});

/**
 * normalizeSourceFilePaths migration (task 0465 R4).
 *
 * Pins:
 *  - checkpoint duplicate rows collapse per (source, realpath), keeping the highest
 *    last_imported_line so an incremental resume does not re-import seen content.
 *  - ledger and contract tables have their source_file column rewritten.
 *  - record_hash is NOT touched (pre-migration rows are grandfathered).
 *  - the migration is idempotent (running twice = running once).
 */
describe('normalizeSourceFilePaths', () => {
    beforeEach(async () => {
        await applyHistoryImportSchema(db);
    });

    function resolveRealPath(path: string): string {
        // Stable fake: rewrite /symlink-root/... to /real-root/...
        return path.replace('/symlink-root/', '/real-root/');
    }

    test('collapses checkpoint duplicates per (source, realpath) keeping the highest line', async () => {
        // Pre-normalization state: one physical file imported via two path
        // representations (symlinked + real). Each (source, source_file) pair is
        // unique under the checkpoint UNIQUE constraint, so seed via separate inserts.
        await db.run(
            `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, updated_at)
             VALUES ('gemini', '/symlink-root/a.jsonl', 50, '2026-01-01T00:00:00.000Z')`,
        );
        await db.run(
            `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, updated_at)
             VALUES ('gemini', '/real-root/a.jsonl', 100, '2026-01-02T00:00:00.000Z')`,
        );

        await normalizeSourceFilePaths(db, resolveRealPath);

        const rows = await db.queryAll<{ source: string; source_file: string; last_imported_line: number }>(
            'SELECT source, source_file, last_imported_line FROM history_import_checkpoint ORDER BY last_imported_line',
        );
        expect(rows).toEqual([{ source: 'gemini', source_file: '/real-root/a.jsonl', last_imported_line: 100 }]);
    });

    test('rewrites source_file in the ledger table', async () => {
        const table = 'history_etl_gemini';
        await db.exec(ETL_TABLE_DDL(table));
        // Seed ledger + ETL row via direct SQL to exercise the column rewrite path
        // without coupling to insertLedger/insertRecord positional signatures.
        await db.run(
            `INSERT INTO history_import_ledger (record_hash, source, source_file, source_line, split_index, target_table, imported_at)
             VALUES ('hash-1', 'gemini', '/symlink-root/a.jsonl', 1, 0, ?, '2026-01-01T00:00:00.000Z')`,
            table,
        );
        await db.run(
            `INSERT INTO ${table} (record_hash, source_file, source_line, split_index, payload_json, imported_at)
             VALUES ('hash-1', '/symlink-root/a.jsonl', 1, 0, '{}', '2026-01-01T00:00:00.000Z')`,
        );

        await normalizeSourceFilePaths(db, resolveRealPath);

        const ledgerRows = await db.queryAll<{ source_file: string }>('SELECT source_file FROM history_import_ledger');
        expect(ledgerRows).toEqual([{ source_file: '/real-root/a.jsonl' }]);
        const etlRows = await db.queryAll<{ source_file: string }>(`SELECT source_file FROM ${table}`);
        expect(etlRows).toEqual([{ source_file: '/real-root/a.jsonl' }]);
    });

    test('rewrites source_file in the history_message and history_tool_call contract tables', async () => {
        // The static schema creates these typed contract tables with many NOT NULL
        // columns. Drop and recreate with a minimal schema so we can seed rows that
        // only exercise the source_file column rewrite — the migration discovers
        // tables dynamically via sqlite_master, so a minimal schema is a faithful test.
        await db.exec('DROP TABLE IF EXISTS history_message');
        await db.exec('DROP TABLE IF EXISTS history_tool_call');
        await db.exec('CREATE TABLE history_message (id TEXT PRIMARY KEY, source TEXT, source_file TEXT)');
        await db.exec('CREATE TABLE history_tool_call (id TEXT PRIMARY KEY, source TEXT, source_file TEXT)');
        await db.run(
            `INSERT INTO history_message (id, source, source_file) VALUES
                ('m1', 'gemini', '/symlink-root/a.jsonl'),
                ('m2', 'gemini', '/real-root/b.jsonl')`,
        );
        await db.run(
            `INSERT INTO history_tool_call (id, source, source_file) VALUES
                ('t1', 'gemini', '/symlink-root/a.jsonl')`,
        );

        await normalizeSourceFilePaths(db, resolveRealPath);

        const messages = await db.queryAll<{ id: string; source_file: string }>(
            'SELECT id, source_file FROM history_message ORDER BY id',
        );
        expect(messages).toEqual([
            { id: 'm1', source_file: '/real-root/a.jsonl' },
            { id: 'm2', source_file: '/real-root/b.jsonl' },
        ]);
        const calls = await db.queryAll<{ id: string; source_file: string }>(
            'SELECT id, source_file FROM history_tool_call ORDER BY id',
        );
        expect(calls).toEqual([{ id: 't1', source_file: '/real-root/a.jsonl' }]);
    });

    test('does not touch record_hash in the ledger', async () => {
        await db.run(
            `INSERT INTO history_import_ledger (record_hash, source, source_file, source_line, split_index, target_table, imported_at)
             VALUES ('preserved-hash', 'gemini', '/symlink-root/a.jsonl', 1, 0, 'history_etl_gemini', '2026-01-01T00:00:00.000Z')`,
        );
        // record_hash in the ledger is part of the table; the migration must leave it.
        await db.run(
            `UPDATE history_import_ledger SET record_hash = 'preserved-hash' WHERE source_file = '/symlink-root/a.jsonl'`,
        );

        await normalizeSourceFilePaths(db, resolveRealPath);

        const rows = await db.queryAll<{ record_hash: string }>('SELECT record_hash FROM history_import_ledger');
        expect(rows).toEqual([{ record_hash: 'preserved-hash' }]);
    });

    test('is idempotent — running twice produces the same state as running once', async () => {
        await db.run(
            `INSERT INTO history_import_checkpoint (source, source_file, last_imported_line, updated_at)
             VALUES ('gemini', '/symlink-root/a.jsonl', 50, '2026-01-01T00:00:00.000Z')`,
        );
        await db.run(
            `INSERT INTO history_import_ledger (record_hash, source, source_file, source_line, split_index, target_table, imported_at)
             VALUES ('hash-1', 'gemini', '/symlink-root/a.jsonl', 1, 0, 'history_etl_gemini', '2026-01-01T00:00:00.000Z')`,
        );
        await normalizeSourceFilePaths(db, resolveRealPath);
        const firstCheckpoint = await db.queryAll('SELECT * FROM history_import_checkpoint');
        const firstLedger = await db.queryAll('SELECT * FROM history_import_ledger');

        await normalizeSourceFilePaths(db, resolveRealPath);
        const secondCheckpoint = await db.queryAll('SELECT * FROM history_import_checkpoint');
        const secondLedger = await db.queryAll('SELECT * FROM history_import_ledger');

        expect(secondCheckpoint).toEqual(firstCheckpoint);
        expect(secondLedger).toEqual(firstLedger);
    });
});
