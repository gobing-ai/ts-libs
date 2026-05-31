import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { DbAdapter } from '../src/adapter';
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
    constructor(adapter: DbAdapter) {
        super(adapter, users, [users.id], 'users');
    }
}

class ItemsDao extends EntityDao<typeof items, typeof items.id> {
    constructor(adapter: DbAdapter) {
        super(adapter, items, [items.id], 'items');
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
    usersDao = new UsersDao(adapter);
    itemsDao = new ItemsDao(adapter);
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
        const result = await usersDao.list({ where: { col: users.name, op: 'eq', value: 'Alice Updated' } });
        expect(result).toHaveLength(1);
    });

    test('count returns total records', async () => {
        const c = await usersDao.count();
        expect(c).toBeGreaterThanOrEqual(3);
    });

    test('count with where clause', async () => {
        const c = await usersDao.count({ col: users.name, op: 'eq', value: 'Alice Updated' });
        expect(c).toBe(1);
    });
});

describe('EntityDao — soft delete', () => {
    test('create soft-deletable record returns the DB-defaulted inUsed via RETURNING', async () => {
        const item = await itemsDao.create({ id: 'i1', label: 'Item 1' });
        // create() now uses INSERT ... RETURNING, so the row reflects the DB
        // default (inUsed = 1) rather than only the JS-supplied fields.
        expect(item.inUsed).toBe(1);
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

// ── New facade capabilities (upsert, createMany, cursor, composite PK) ──

const events = sqliteTable('events', {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    seq: integer('seq').notNull(),
    createdAt: integer('created_at').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(0),
});

class EventsDao extends EntityDao<typeof events, typeof events.id> {
    constructor(adapter: DbAdapter) {
        super(adapter, events, [events.id], 'events');
    }
    upsertByName(id: string, name: string, seq: number) {
        return this.upsert({ id, name, seq }, [events.name]);
    }
}

const checkpoints = sqliteTable('checkpoints', {
    source: text('source').notNull(),
    sourceFile: text('source_file').notNull(),
    lastLine: integer('last_line').notNull(),
    createdAt: integer('created_at').notNull().default(0),
    updatedAt: integer('updated_at').notNull().default(0),
});

class CheckpointDao extends EntityDao<typeof checkpoints, typeof checkpoints.source> {
    constructor(adapter: DbAdapter) {
        super(adapter, checkpoints, [checkpoints.source, checkpoints.sourceFile], 'checkpoints');
    }
}

describe('EntityDao — facade capabilities', () => {
    let cap: BunSqliteAdapter;
    let eventsDao: EventsDao;
    let checkpointDao: CheckpointDao;

    beforeAll(async () => {
        cap = new BunSqliteAdapter({ databaseUrl: ':memory:' });
        await cap.exec(
            'CREATE TABLE events (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, seq INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)',
        );
        await cap.exec(
            'CREATE TABLE checkpoints (source TEXT NOT NULL, source_file TEXT NOT NULL, last_line INTEGER NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source, source_file))',
        );
        eventsDao = new EventsDao(cap);
        checkpointDao = new CheckpointDao(cap);
    });

    afterAll(() => cap.close());

    test('createMany inserts a batch and returns rows', async () => {
        const rows = await eventsDao.createMany([
            { id: 'e1', name: 'first', seq: 1 },
            { id: 'e2', name: 'second', seq: 2 },
            { id: 'e3', name: 'third', seq: 3 },
        ]);
        expect(rows).toHaveLength(3);
        expect(rows.map((r) => r.id).sort()).toEqual(['e1', 'e2', 'e3']);
        expect(await eventsDao.count()).toBe(3);
    });

    test('createMany with empty array is a no-op', async () => {
        expect(await eventsDao.createMany([])).toEqual([]);
    });

    test('upsert inserts when no conflict', async () => {
        const row = await eventsDao.upsertByName('e4', 'fourth', 4);
        expect(row.id).toBe('e4');
        expect(row.seq).toBe(4);
    });

    test('upsert updates the existing row on conflict (by unique name)', async () => {
        const before = await eventsDao.findBy(events.name, 'first');
        expect(before).toBeDefined();
        const updated = await eventsDao.upsertByName('e1-dup', 'first', 99);
        // conflict on name → original row updated in place; id (e1) is preserved
        expect(updated.id).toBe(before?.id ?? '');
        expect(updated.id).toBe('e1');
        expect(updated.seq).toBe(99);
        expect(await eventsDao.count()).toBe(4);
    });

    test('list with predicate + orderBy', async () => {
        const rows = await eventsDao.list({
            where: { col: events.seq, op: 'gte', value: 2 },
            orderBy: [{ col: events.seq, dir: 'desc' }],
        });
        expect(rows.map((r) => r.seq)).toEqual([99, 4, 3, 2]);
    });

    test('listByCursor walks pages by keyset', async () => {
        const page1 = await eventsDao.listByCursor({ cursorColumn: events.id, limit: 2 });
        expect(page1.rows).toHaveLength(2);
        expect(page1.nextCursor).toBeDefined();

        const page2 = await eventsDao.listByCursor({
            cursorColumn: events.id,
            limit: 2,
            cursor: page1.nextCursor,
        });
        expect(page2.rows).toHaveLength(2);
        const ids1 = page1.rows.map((r) => r.id);
        const ids2 = page2.rows.map((r) => r.id);
        expect(ids1.some((id) => ids2.includes(id))).toBeFalse();
    });

    test('listByCursor last page has no nextCursor', async () => {
        const all = await eventsDao.listByCursor({ cursorColumn: events.id, limit: 100 });
        expect(all.nextCursor).toBeUndefined();
    });

    test('composite primary key: create, findById, update, delete', async () => {
        await checkpointDao.create({ source: 'pi', sourceFile: 'a.jsonl', lastLine: 10 });
        await checkpointDao.create({ source: 'pi', sourceFile: 'b.jsonl', lastLine: 20 });

        const a = await checkpointDao.findById(['pi', 'a.jsonl']);
        expect(a?.lastLine).toBe(10);

        const updated = await checkpointDao.update(['pi', 'a.jsonl'], { lastLine: 15 });
        expect(updated?.lastLine).toBe(15);

        await checkpointDao.delete(['pi', 'a.jsonl']);
        expect(await checkpointDao.findById(['pi', 'a.jsonl'])).toBeUndefined();
        expect(await checkpointDao.findById(['pi', 'b.jsonl'])).toBeDefined();
    });

    test('composite primary key rejects wrong arity', async () => {
        await expect(checkpointDao.findById('pi')).rejects.toThrow('expects 2 value(s)');
    });
});
