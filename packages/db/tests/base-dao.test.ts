import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DbAdapter } from '../src/adapter';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { BaseDao, type TxHandle } from '../src/base-dao';

class TestDao extends BaseDao {
    constructor(adapter: DbAdapter) {
        super(adapter);
    }
    getNow(): number {
        return this.now();
    }

    async runInTransaction(fn: (tx: TxHandle) => Promise<string>): Promise<string> {
        return this.tx(fn);
    }
}

let adapter: BunSqliteAdapter;
let dao: TestDao;

beforeAll(() => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
    dao = new TestDao(adapter);
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

    test('tx executes callback within a transaction', async () => {
        await adapter.exec('CREATE TABLE test_tx (id INTEGER PRIMARY KEY, val TEXT)');

        const result = await dao.runInTransaction(async (_tx) => {
            await adapter.run('INSERT INTO test_tx VALUES (?, ?)', 1, 'tx-test');
            return 'committed';
        });

        expect(result).toBe('committed');
        const row = await adapter.queryFirst<{ val: string }>('SELECT val FROM test_tx WHERE id = ?', 1);
        expect(row?.val).toBe('tx-test');
    });

    test('tx propagates error from callback', async () => {
        await adapter.exec('CREATE TABLE test_tx2 (id INTEGER PRIMARY KEY, val TEXT)');

        await expect(
            dao.runInTransaction(async (_tx) => {
                throw new Error('test rollback');
            }),
        ).rejects.toThrow('test rollback');
    });
});

const widgets = sqliteTable('widgets', {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    rank: integer('rank').notNull(),
});

class WidgetRawDao extends BaseDao {
    constructor(adapter: DbAdapter) {
        super(adapter);
    }
    all(spec: Parameters<WidgetRawDao['query']>[1]) {
        return this.query<{ id: string; kind: string; rank: number }>(widgets, spec);
    }
    first(where: Parameters<WidgetRawDao['one']>[1]) {
        return this.one<{ id: string; kind: string; rank: number }>(widgets, where);
    }
}

describe('BaseDao — raw tier (query/one)', () => {
    let adapter2: BunSqliteAdapter;
    let dao2: WidgetRawDao;

    beforeAll(async () => {
        adapter2 = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        await adapter2.exec('CREATE TABLE widgets (id TEXT PRIMARY KEY, kind TEXT NOT NULL, rank INTEGER NOT NULL)');
        await adapter2.run('INSERT INTO widgets VALUES (?,?,?)', 'w1', 'a', 3);
        await adapter2.run('INSERT INTO widgets VALUES (?,?,?)', 'w2', 'a', 1);
        await adapter2.run('INSERT INTO widgets VALUES (?,?,?)', 'w3', 'b', 2);
        dao2 = new WidgetRawDao(adapter2);
    });

    afterAll(() => adapter2.close());

    test('query with no spec returns all rows', async () => {
        expect(await dao2.all({})).toHaveLength(3);
    });

    test('query applies where + orderBy + limit + offset', async () => {
        const rows = await dao2.all({
            where: { col: widgets.kind, op: 'eq', value: 'a' },
            orderBy: [{ col: widgets.rank, dir: 'asc' }],
            limit: 1,
            offset: 1,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.id).toBe('w1'); // kind 'a' sorted by rank asc: w2(1), w1(3) → offset 1 → w1
    });

    test('one returns first match or undefined', async () => {
        expect((await dao2.first({ col: widgets.id, op: 'eq', value: 'w3' }))?.kind).toBe('b');
        expect(await dao2.first({ col: widgets.id, op: 'eq', value: 'nope' })).toBeUndefined();
    });
});
