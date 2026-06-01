import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { text } from 'drizzle-orm/sqlite-core';
import type { DbAdapter } from '../src/adapter';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { EntityDao } from '../src/entity-dao';
import { standardColumns } from '../src/schema/common';
import { defineTable } from '../src/schema/define-table';

const accounts = defineTable('accounts', {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    ...standardColumns,
});

class AccountsDao extends EntityDao<typeof accounts.table, typeof accounts.table.id> {
    constructor(adapter: DbAdapter) {
        super(adapter, accounts.table, [accounts.table.id], 'accounts', {
            insertSchema: accounts.insertSchema,
            validateOn: ['create'],
        });
    }
}

describe('defineTable (single source of truth)', () => {
    test('derives insert and select zod schemas from the table', () => {
        expect(typeof accounts.insertSchema.parse).toBe('function');
        expect(typeof accounts.selectSchema.parse).toBe('function');
        // schemas are memoised (same reference on second read)
        expect(accounts.insertSchema).toBe(accounts.insertSchema);
    });

    test('insertSchema accepts a valid row and rejects a malformed one', () => {
        expect(() =>
            accounts.insertSchema.parse({ id: 'a1', email: 'x@y.z', createdAt: 1, updatedAt: 1 }),
        ).not.toThrow();
        expect(() => accounts.insertSchema.parse({ id: 'a1' })).toThrow();
    });
});

describe('EntityDao validation option', () => {
    let adapter: BunSqliteAdapter;
    let dao: AccountsDao;

    beforeAll(async () => {
        adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        await adapter.exec(
            'CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)',
        );
        dao = new AccountsDao(adapter);
    });

    afterAll(() => adapter.close());

    test('create passes validation for a valid row', async () => {
        const row = await dao.create({ id: 'a1', email: 'alice@test.com' });
        expect(row.email).toBe('alice@test.com');
    });

    test('create rejects an invalid row before hitting the DB', async () => {
        // email is required + notNull; omit it → schema parse throws
        await expect(dao.create({ id: 'a2' } as unknown as { id: string; email: string })).rejects.toThrow();
        // nothing was written
        expect(await dao.findById('a2')).toBeUndefined();
    });

    test('update is not validated (no updateSchema configured)', async () => {
        // partial update with only email — should succeed (update validation requires explicit updateSchema)
        const updated = await dao.update('a1', { email: 'alice2@test.com' });
        expect(updated?.email).toBe('alice2@test.com');
    });
});
