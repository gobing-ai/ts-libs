import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DbClient } from '../src/adapter';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { BaseDao } from '../src/base-dao';

class TestDao extends BaseDao {
    constructor(db: DbClient) {
        super(db);
    }
    getNow(): number {
        return this.now();
    }

    async runInTransaction(fn: (tx: DbClient) => Promise<string>): Promise<string> {
        return this.withTransaction(fn);
    }
}

let adapter: BunSqliteAdapter;
let dao: TestDao;

beforeAll(() => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
    dao = new TestDao(adapter.getDb());
});

afterAll(() => {
    adapter.close();
});

describe('BaseDao', () => {
    test('now() returns a timestamp', () => {
        const ts = dao.getNow();
        expect(ts).toBeGreaterThan(0);
        expect(typeof ts).toBe('number');
    });

    test('now() returns monotonically increasing values', () => {
        const a = dao.getNow();
        const b = dao.getNow();
        expect(b).toBeGreaterThanOrEqual(a);
    });

    test('withTransaction executes callback within a transaction', async () => {
        await adapter.exec('CREATE TABLE test_tx (id INTEGER PRIMARY KEY, val TEXT)');

        const result = await dao.runInTransaction(async (_tx) => {
            await adapter.run('INSERT INTO test_tx VALUES (?, ?)', 1, 'tx-test');
            return 'committed';
        });

        expect(result).toBe('committed');
        const row = await adapter.queryFirst<{ val: string }>('SELECT val FROM test_tx WHERE id = ?', 1);
        expect(row?.val).toBe('tx-test');
    });

    test('withTransaction propagates error from callback', async () => {
        await adapter.exec('CREATE TABLE test_tx2 (id INTEGER PRIMARY KEY, val TEXT)');

        await expect(
            dao.runInTransaction(async (_tx) => {
                throw new Error('test rollback');
            }),
        ).rejects.toThrow('test rollback');
    });
});
