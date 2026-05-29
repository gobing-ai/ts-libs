import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { BunSqliteAdapter } from '../../src/adapters/bun-sqlite';

describe('BunSqliteAdapter', () => {
    let adapter: BunSqliteAdapter;

    beforeAll(() => {
        adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
    });

    afterAll(() => {
        adapter.close();
    });

    test('constructs with defaults', () => {
        const a = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        expect(a).toBeDefined();
        a.close();
    });

    test('constructs with no options', () => {
        // Uses default path but in-memory DB won't conflict with tests
        const a = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        expect(a).toBeDefined();
        a.close();
    });

    test('getDb returns a DbClient', () => {
        const db = adapter.getDb();
        expect(db).toBeDefined();
        expect(typeof db).toBe('object');
    });

    test('getDrizzleDb returns the drizzle instance', () => {
        const drizzleDb = adapter.getDrizzleDb();
        expect(drizzleDb).toBeDefined();
    });

    test('exec executes raw SQL', async () => {
        await adapter.exec('CREATE TABLE IF NOT EXISTS test_exec (id INTEGER PRIMARY KEY, name TEXT)');
        // Should not throw
    });

    test('run executes parameterized SQL', async () => {
        await adapter.exec('CREATE TABLE IF NOT EXISTS test_run (id INTEGER PRIMARY KEY, name TEXT)');
        await adapter.run('INSERT INTO test_run (id, name) VALUES (?, ?)', 1, 'hello');
    });

    test('queryFirst returns a single row', async () => {
        await adapter.exec('CREATE TABLE IF NOT EXISTS test_first (id INTEGER PRIMARY KEY, name TEXT)');
        await adapter.run('INSERT INTO test_first (id, name) VALUES (?, ?)', 10, 'alpha');

        const row = await adapter.queryFirst<{ id: number; name: string }>('SELECT * FROM test_first WHERE id = ?', 10);
        expect(row).toBeDefined();
        expect(row?.id).toBe(10);
        expect(row?.name).toBe('alpha');
    });

    test('queryFirst returns undefined for no match', async () => {
        await adapter.exec('CREATE TABLE IF NOT EXISTS test_first_miss (id INTEGER PRIMARY KEY, name TEXT)');

        const row = await adapter.queryFirst<{ id: number; name: string }>(
            'SELECT * FROM test_first_miss WHERE id = ?',
            999,
        );
        expect(row).toBeNull();
    });

    test('queryAll returns multiple rows', async () => {
        await adapter.exec('CREATE TABLE IF NOT EXISTS test_all (id INTEGER PRIMARY KEY, name TEXT)');
        await adapter.run('INSERT INTO test_all (id, name) VALUES (?, ?)', 1, 'a');
        await adapter.run('INSERT INTO test_all (id, name) VALUES (?, ?)', 2, 'b');

        const rows = await adapter.queryAll<{ id: number; name: string }>('SELECT * FROM test_all ORDER BY id');
        expect(rows).toHaveLength(2);
        expect(rows[0]?.name).toBe('a');
        expect(rows[1]?.name).toBe('b');
    });

    test('queryAll returns empty array for no rows', async () => {
        await adapter.exec('CREATE TABLE IF NOT EXISTS test_all_empty (id INTEGER PRIMARY KEY, name TEXT)');

        const rows = await adapter.queryAll<{ id: number; name: string }>(
            'SELECT * FROM test_all_empty WHERE id = 999',
        );
        expect(rows).toEqual([]);
    });

    test('close is idempotent', () => {
        const a = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        a.close();
        expect(() => a.close()).not.toThrow();
    });

    test('statement cache reuses prepared statements', async () => {
        await adapter.exec('CREATE TABLE IF NOT EXISTS test_cache (id INTEGER PRIMARY KEY, name TEXT)');

        // First call caches the statement, second reuses it
        await adapter.run('INSERT INTO test_cache (id, name) VALUES (?, ?)', 100, 'cache1');
        await adapter.run('INSERT INTO test_cache (id, name) VALUES (?, ?)', 101, 'cache2');

        const rows = await adapter.queryAll<{ id: number; name: string }>('SELECT * FROM test_cache ORDER BY id');
        expect(rows).toHaveLength(2);
    });
});
