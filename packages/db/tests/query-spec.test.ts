import { describe, expect, test } from 'bun:test';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { BunSqliteAdapter } from '../src/adapters/bun-sqlite';
import { compileOrderBy, compilePredicate, type Predicate } from '../src/query-spec';

const rows = sqliteTable('rows', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    age: integer('age').notNull(),
    note: text('note'),
});

/** Build an in-memory db seeded with a fixed set of rows for predicate testing. */
function seededDb() {
    const adapter = new BunSqliteAdapter({ databaseUrl: ':memory:' });
    const db = adapter.getDrizzleDb();
    adapter.exec('CREATE TABLE rows (id TEXT PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, note TEXT)');
    adapter.exec(
        `INSERT INTO rows (id, name, age, note) VALUES
            ('1','alice',30,'x'),
            ('2','bob',25,NULL),
            ('3','carol',40,'y'),
            ('4','dave',25,'z')`,
    );
    return { adapter, db };
}

/** Run a where-predicate against the seeded table and return matched ids, sorted. */
async function idsWhere(predicate: Predicate): Promise<string[]> {
    const { adapter, db } = seededDb();
    const condition = compilePredicate(predicate);
    const result = (await (condition ? db.select().from(rows).where(condition) : db.select().from(rows))) as {
        id: string;
    }[];
    adapter.close();
    return result.map((r) => r.id).sort();
}

describe('compilePredicate', () => {
    test('eq matches exact value', async () => {
        expect(await idsWhere({ col: rows.name, op: 'eq', value: 'alice' })).toEqual(['1']);
    });

    test('ne excludes value', async () => {
        expect(await idsWhere({ col: rows.age, op: 'ne', value: 25 })).toEqual(['1', '3']);
    });

    test('gt / gte / lt / lte compare numerically', async () => {
        expect(await idsWhere({ col: rows.age, op: 'gt', value: 30 })).toEqual(['3']);
        expect(await idsWhere({ col: rows.age, op: 'gte', value: 30 })).toEqual(['1', '3']);
        expect(await idsWhere({ col: rows.age, op: 'lt', value: 30 })).toEqual(['2', '4']);
        expect(await idsWhere({ col: rows.age, op: 'lte', value: 25 })).toEqual(['2', '4']);
    });

    test('like matches pattern', async () => {
        expect(await idsWhere({ col: rows.name, op: 'like', value: '%a%' })).toEqual(['1', '3', '4']);
    });

    test('in matches any of the listed values', async () => {
        expect(await idsWhere({ col: rows.id, op: 'in', values: ['1', '3'] })).toEqual(['1', '3']);
    });

    test('isNull / isNotNull filter on nullability', async () => {
        expect(await idsWhere({ col: rows.note, op: 'isNull' })).toEqual(['2']);
        expect(await idsWhere({ col: rows.note, op: 'isNotNull' })).toEqual(['1', '3', '4']);
    });

    test('and combines conditions', async () => {
        expect(
            await idsWhere({
                and: [
                    { col: rows.age, op: 'eq', value: 25 },
                    { col: rows.note, op: 'isNotNull' },
                ],
            }),
        ).toEqual(['4']);
    });

    test('or unions conditions', async () => {
        expect(
            await idsWhere({
                or: [
                    { col: rows.name, op: 'eq', value: 'alice' },
                    { col: rows.name, op: 'eq', value: 'bob' },
                ],
            }),
        ).toEqual(['1', '2']);
    });

    test('empty and group compiles to undefined (no filter)', () => {
        expect(compilePredicate({ and: [] })).toBeUndefined();
    });

    test('empty or group compiles to undefined (no filter)', () => {
        expect(compilePredicate({ or: [] })).toBeUndefined();
    });

    test('nested and/or groups compose', async () => {
        expect(
            await idsWhere({
                or: [{ and: [{ col: rows.age, op: 'eq', value: 25 }] }, { col: rows.name, op: 'eq', value: 'carol' }],
            }),
        ).toEqual(['2', '3', '4']);
    });
});

describe('compileOrderBy', () => {
    test('asc by default, desc when specified', async () => {
        const { adapter, db } = seededDb();
        const ascClauses = compileOrderBy([{ col: rows.age }]);
        const descClauses = compileOrderBy([{ col: rows.age, dir: 'desc' }]);

        const ascAges = (
            (await db
                .select()
                .from(rows)
                .orderBy(...ascClauses)) as { age: number }[]
        ).map((r) => r.age);
        const descAges = (
            (await db
                .select()
                .from(rows)
                .orderBy(...descClauses)) as { age: number }[]
        ).map((r) => r.age);

        adapter.close();
        expect(ascAges).toEqual([25, 25, 30, 40]);
        expect(descAges).toEqual([40, 30, 25, 25]);
    });

    test('multi-column order applies in sequence', async () => {
        const { adapter, db } = seededDb();
        const clauses = compileOrderBy([{ col: rows.age }, { col: rows.name, dir: 'desc' }]);
        const ordered = (
            (await db
                .select()
                .from(rows)
                .orderBy(...clauses)) as { id: string }[]
        ).map((r) => r.id);
        adapter.close();
        // age asc: 25,25,30,40 — ties (bob=2, dave=4) broken by name desc → dave before bob
        expect(ordered).toEqual(['4', '2', '1', '3']);
    });
});
