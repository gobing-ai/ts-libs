import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DbClient } from '../src/adapter';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { EntityDao } from '../src/entity-dao';

// Test table with standard columns
const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    createdAt: integer('created_at').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(0),
});

// Test table with soft delete
const items = sqliteTable('items', {
    id: text('id').primaryKey(),
    label: text('label').notNull(),
    createdAt: integer('created_at').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(0),
    inUsed: integer('in_used').notNull().default(1),
});

class UsersDao extends EntityDao<typeof users, typeof users.id> {
    constructor(db: DbClient) {
        super(db, users, users.id, 'users');
    }
}

class ItemsDao extends EntityDao<typeof items, typeof items.id> {
    constructor(db: DbClient) {
        super(db, items, items.id, 'items');
    }

    /** Expose protected member for testing. */
    override get hasSoftDelete(): boolean {
        return super.hasSoftDelete;
    }

    /** Expose protected member for testing. */
    override get activeCondition() {
        return super.activeCondition;
    }
}

let adapter: BunSqliteAdapter;
let usersDao: UsersDao;
let itemsDao: ItemsDao;

beforeAll(async () => {
    adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
    await adapter.exec(
        'CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)',
    );
    await adapter.exec(
        'CREATE TABLE items (id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, in_used INTEGER NOT NULL DEFAULT 1)',
    );
    usersDao = new UsersDao(adapter.getDb());
    itemsDao = new ItemsDao(adapter.getDb());
});

afterAll(() => {
    adapter.close();
});

describe('EntityDao — CRUD (no soft delete)', () => {
    test('create inserts a record with auto-filled timestamps', async () => {
        const user = await usersDao.create({ id: 'u1', name: 'Alice', email: 'alice@test.com' });
        expect(user.id).toBe('u1');
        expect(user.name).toBe('Alice');
        expect(user.createdAt).toBeGreaterThan(0);
        expect(user.updatedAt).toBeGreaterThan(0);
    });

    test('create accepts explicit timestamps', async () => {
        const ts = 1000;
        const user = await usersDao.create({
            id: 'u2',
            name: 'Bob',
            email: 'bob@test.com',
            createdAt: ts,
            updatedAt: ts,
        });
        expect(user.createdAt).toBe(ts);
        expect(user.updatedAt).toBe(ts);
    });

    test('findById returns record', async () => {
        const user = await usersDao.findById('u1');
        expect(user?.name).toBe('Alice');
    });

    test('findById returns undefined for missing id', async () => {
        const user = await usersDao.findById('nonexistent');
        expect(user).toBeUndefined();
    });

    test('findAll returns all records', async () => {
        const all = await usersDao.findAll();
        expect(all).toHaveLength(2);
    });

    test('update modifies a record', async () => {
        const updated = await usersDao.update('u1', { name: 'Alice Updated' });
        expect(updated?.name).toBe('Alice Updated');
        expect(updated?.updatedAt).toBeGreaterThan(0);
    });

    test('update returns undefined for missing id', async () => {
        const result = await usersDao.update('nonexistent', { name: 'X' });
        expect(result).toBeUndefined();
    });

    test('delete hard-deletes a record (no soft delete)', async () => {
        await usersDao.delete('u2');
        const user = await usersDao.findById('u2');
        expect(user).toBeUndefined();
    });

    test('findBy returns matching record', async () => {
        const user = await usersDao.findBy(users.email, 'alice@test.com');
        expect(user?.id).toBe('u1');
    });

    test('findBy returns undefined for no match', async () => {
        const user = await usersDao.findBy(users.email, 'no@match.com');
        expect(user).toBeUndefined();
    });

    test('findAllBy returns all matching records', async () => {
        await usersDao.create({ id: 'u3', name: 'Charlie', email: 'charlie@test.com' });
        await usersDao.create({ id: 'u4', name: 'Dana', email: 'charlie@test.com' });
        const matches = await usersDao.findAllBy(users.email, 'charlie@test.com');
        expect(matches).toHaveLength(2);
    });

    test('list with pagination', async () => {
        const page = await usersDao.list({ limit: 1, offset: 0 });
        expect(page).toHaveLength(1);
    });

    test('list with where clause', async () => {
        const { eq } = await import('drizzle-orm');
        const result = await usersDao.list({ where: eq(users.name, 'Alice Updated') });
        expect(result).toHaveLength(1);
    });

    test('count returns total records', async () => {
        const c = await usersDao.count();
        expect(c).toBeGreaterThanOrEqual(3);
    });

    test('count with where clause', async () => {
        const { eq } = await import('drizzle-orm');
        const c = await usersDao.count(eq(users.name, 'Alice Updated'));
        expect(c).toBe(1);
    });
});

describe('EntityDao — soft delete', () => {
    test('create soft-deletable record', async () => {
        const item = await itemsDao.create({ id: 'i1', label: 'Item 1' });
        expect(item.inUsed).toBeUndefined(); // inUsed is defaulted by DB
    });

    test('findAll excludes soft-deleted by default', async () => {
        await itemsDao.create({ id: 'i2', label: 'Item 2' });
        await itemsDao.delete('i1'); // soft delete
        const all = await itemsDao.findAll();
        expect(all.map((i) => i.id)).not.toContain('i1');
        expect(all.map((i) => i.id)).toContain('i2');
    });

    test('findAll includeDeleted returns all', async () => {
        const all = await itemsDao.findAll(true);
        expect(all.map((i) => i.id)).toContain('i1');
        expect(all.map((i) => i.id)).toContain('i2');
    });

    test('findById excludes soft-deleted by default', async () => {
        const item = await itemsDao.findById('i1');
        expect(item).toBeUndefined();
    });

    test('findById includeDeleted returns soft-deleted', async () => {
        const item = await itemsDao.findById('i1', true);
        expect(item?.id).toBe('i1');
    });

    test('delete with soft=false hard-deletes', async () => {
        await itemsDao.delete('i2', false);
        const item = await itemsDao.findById('i2', true);
        expect(item).toBeUndefined();
    });

    test('hasSoftDelete returns true', () => {
        expect(itemsDao.hasSoftDelete).toBeTrue();
    });

    test('activeCondition returns condition', () => {
        expect(itemsDao.activeCondition).toBeDefined();
    });
});
