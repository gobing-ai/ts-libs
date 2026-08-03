import { beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { HistoryImportError } from '../src';
import {
    applyHistoryImportSchema,
    ETL_TABLE_DDL,
    insertLedger,
    insertRecord,
    ledgerExists,
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
        expect(JSON.parse(rows[0]!.payload_json)).toEqual({ content: 'hello' });
    });

    test('is idempotent on duplicate record_hash', async () => {
        await insertRecord(db, 'history_etl_codex', 'hash1', '/tmp/f.json', 1, 0, { content: 'a' }, undefined);
        await insertRecord(db, 'history_etl_codex', 'hash1', '/tmp/f.json', 1, 0, { content: 'b' }, undefined);

        const rows = await db.queryAll<{ payload_json: string }>('SELECT payload_json FROM history_etl_codex');
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0]!.payload_json)).toEqual({ content: 'a' });
    });
});
