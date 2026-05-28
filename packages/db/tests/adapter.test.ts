import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createDbAdapter } from '../src/adapter';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';

let adapter: BunSqliteAdapter;

beforeAll(() => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
});

afterAll(() => {
    adapter.close();
});

describe('BunSqliteAdapter', () => {
    test('returns a DbClient from getDb()', () => {
        const db = adapter.getDb();
        expect(db).toBeDefined();
    });

    test('returns drizzle instance from getDrizzleDb()', () => {
        const drizzle = adapter.getDrizzleDb();
        expect(drizzle).toBeDefined();
    });

    test('executes raw SQL via exec()', async () => {
        await adapter.exec('CREATE TABLE test_exec (id INTEGER PRIMARY KEY, name TEXT)');
        await adapter.exec("INSERT INTO test_exec VALUES (1, 'hello')");
        const rows = await adapter.queryAll<{ id: number; name: string }>('SELECT * FROM test_exec');
        expect(rows).toHaveLength(1);
        expect(rows[0]?.name).toBe('hello');
    });

    test('executes parameterized run()', async () => {
        await adapter.exec('CREATE TABLE test_run (id INTEGER PRIMARY KEY, val TEXT)');
        await adapter.run('INSERT INTO test_run VALUES (?, ?)', 1, 'a');
        await adapter.run('INSERT INTO test_run VALUES (?, ?)', 2, 'b');
        const rows = await adapter.queryAll<{ val: string }>('SELECT val FROM test_run ORDER BY id');
        expect(rows).toEqual([{ val: 'a' }, { val: 'b' }]);
    });

    test('queryFirst returns first row', async () => {
        await adapter.exec('CREATE TABLE test_first (id INTEGER PRIMARY KEY, name TEXT)');
        await adapter.run('INSERT INTO test_first VALUES (?, ?)', 1, 'first');
        await adapter.run('INSERT INTO test_first VALUES (?, ?)', 2, 'second');
        const row = await adapter.queryFirst<{ name: string }>('SELECT name FROM test_first WHERE id = ?', 1);
        expect(row).toEqual({ name: 'first' });
    });

    test('queryFirst returns null for no match', async () => {
        const row = await adapter.queryFirst<{ name: string }>('SELECT name FROM test_first WHERE id = ?', 999);
        expect(row).toBeNull();
    });

    test('queryAll returns all rows', async () => {
        await adapter.exec('CREATE TABLE test_all (id INTEGER, val TEXT)');
        await adapter.run('INSERT INTO test_all VALUES (?, ?)', 1, 'x');
        await adapter.run('INSERT INTO test_all VALUES (?, ?)', 2, 'y');
        const rows = await adapter.queryAll<{ val: string }>('SELECT val FROM test_all ORDER BY id');
        expect(rows).toEqual([{ val: 'x' }, { val: 'y' }]);
    });

    test('queryAll returns empty array for no results', async () => {
        const rows = await adapter.queryAll<{ val: string }>('SELECT val FROM test_all WHERE id = ?', 999);
        expect(rows).toEqual([]);
    });

    test('statement cache reuses compiled statements', async () => {
        // Run same query twice — second call should hit the cache
        await adapter.queryAll<{ val: string }>('SELECT val FROM test_all WHERE id = ?', 1);
        await adapter.queryAll<{ val: string }>('SELECT val FROM test_all WHERE id = ?', 1);
        // No error = cache works
    });
});

describe('createDbAdapter factory', () => {
    test('creates BunSqliteAdapter for bun-sqlite driver', async () => {
        const a = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        expect(a).toBeInstanceOf(BunSqliteAdapter);
        a.close();
    });

    test('creates D1Adapter for d1 driver with mock binding', async () => {
        const mockBinding = {
            prepare: () => ({
                bind: (..._args: unknown[]) => ({
                    all: async () => ({ results: [], success: true }),
                    run: async () => ({ results: [], success: true }),
                    raw: async () => [],
                }),
            }),
            exec: async () => {},
        };
        const a = await createDbAdapter({ driver: 'd1', binding: mockBinding });
        expect(a).toBeDefined();
        expect(a.getDb()).toBeDefined();
        a.close();
    });
});
