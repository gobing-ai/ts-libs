import { describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { blob, integer, numeric, primaryKey, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { standardColumns } from '../src/schema/common';
import { generateCreateTableSql } from '../src/schema/ddl';
import { defineTable } from '../src/schema/define-table';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SqliteConn = {
    run(sql: string): void;
    query(sql: string): { all(): unknown[] };
    close(): void;
};

function openMemory(): SqliteConn {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Database } = require('bun:sqlite') as { Database: new (url: string) => SqliteConn };
    return new Database(':memory:');
}

// ---------------------------------------------------------------------------
// generateCreateTableSql — unit tests
// ---------------------------------------------------------------------------

describe('generateCreateTableSql', () => {
    test('simple table with single column', () => {
        const t = sqliteTable('test_table', { id: integer('id') });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "test_table"');
        expect(ddl).toContain('"id" integer');
    });

    test('multiple columns with types', () => {
        const t = sqliteTable('multi', {
            id: integer('id'),
            name: text('name'),
            score: real('score'),
            data: blob('data'),
            amount: numeric('amount'),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('"id" integer');
        expect(ddl).toContain('"name" text');
        expect(ddl).toContain('"score" real');
        expect(ddl).toContain('"data" blob');
        expect(ddl).toContain('"amount" numeric');
    });

    test('NOT NULL constraint', () => {
        const t = sqliteTable('nn', {
            id: integer('id'),
            required: text('required').notNull(),
            optional: text('optional'),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('"required" text NOT NULL');
        expect(ddl).not.toContain('"optional" text NOT NULL');
    });

    test('DEFAULT — number', () => {
        const t = sqliteTable('defs', {
            id: integer('id'),
            count: integer('count').default(0),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('DEFAULT 0');
    });

    test('DEFAULT — string', () => {
        const t = sqliteTable('defs_str', {
            id: integer('id'),
            status: text('status').default('active'),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain("DEFAULT 'active'");
    });

    test('DEFAULT — boolean true', () => {
        const t = sqliteTable('defs_bool_true', {
            id: integer('id'),
            flag: integer('flag', { mode: 'boolean' }).default(true),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('DEFAULT 1');
    });

    test('DEFAULT — boolean false', () => {
        const t = sqliteTable('defs_bool_false', {
            id: integer('id'),
            flag: integer('flag', { mode: 'boolean' }).default(false),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('DEFAULT 0');
    });

    test('DEFAULT — boolean via SQL', () => {
        const t = sqliteTable('defs_bool', {
            id: integer('id'),
            flag: integer('flag').default(sql`1`),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('DEFAULT 1');
    });

    test('DEFAULT — null via SQL', () => {
        const t = sqliteTable('defs_null', {
            id: integer('id'),
            nullable: text('nullable').default(sql`NULL`),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('DEFAULT NULL');
    });

    test('DEFAULT — SQL expression', () => {
        const t = sqliteTable('defs_sql', {
            id: integer('id'),
            ts: integer('ts').default(sql`(strftime('%s','now') * 1000)`),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain("DEFAULT (strftime('%s','now') * 1000)");
    });

    test('$defaultFn does NOT produce DEFAULT (runtime only)', () => {
        const t = sqliteTable('defs_fn', {
            id: integer('id'),
            ts: integer('ts').$defaultFn(() => Date.now()),
        });
        const ddl = generateCreateTableSql(t);
        // $defaultFn sets hasDefault=true default=0 for integer, but getTableConfig columns
        // carry the builder default; we emit SQL-level DEFAULT only when column.default
        // is set AND is a real value (not effectively 0 from $defaultFn).
        // After checking: integer with $defaultFn gets default=0, but this IS a real default
        // in the drizzle sense. The test expectation: no DEFAULT in the DDL.
        // This test verifies we don't leak runtime-only defaults into DDL.
        expect(ddl).not.toContain('DEFAULT');
    });

    test('single-column PRIMARY KEY', () => {
        const t = sqliteTable('pk_single', {
            id: text('id').primaryKey(),
            name: text('name'),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('"id" text PRIMARY KEY NOT NULL');
    });

    test('UNIQUE constraint — single column', () => {
        const t = sqliteTable('uq_single', {
            id: integer('id').primaryKey(),
            email: text('email').unique(),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('UNIQUE');
    });

    test('FOREIGN KEY', () => {
        const parent = sqliteTable('parent', {
            id: integer('id').primaryKey(),
        });
        const child = sqliteTable('child', {
            id: integer('id').primaryKey(),
            parentId: integer('parent_id').references(() => parent.id),
        });
        const ddl = generateCreateTableSql(child);
        expect(ddl).toContain('FOREIGN KEY');
        expect(ddl).toContain('REFERENCES "parent"');
        expect(ddl).toContain('"parent_id"');
    });

    test('FOREIGN KEY with ON DELETE CASCADE', () => {
        const parent = sqliteTable('parent2', {
            id: integer('id').primaryKey(),
        });
        const child = sqliteTable('child2', {
            id: integer('id').primaryKey(),
            parentId: integer('parent_id').references(() => parent.id, { onDelete: 'cascade' }),
        });
        const ddl = generateCreateTableSql(child);
        expect(ddl).toContain('ON DELETE cascade');
    });

    test('deterministic output (same table → same DDL)', () => {
        const t = sqliteTable('det', {
            id: integer('id').primaryKey(),
            name: text('name').notNull().default('unnamed'),
        });
        const ddl1 = generateCreateTableSql(t);
        const ddl2 = generateCreateTableSql(t);
        expect(ddl1).toBe(ddl2);
    });

    test('composite PRIMARY KEY via table-level constraint', () => {
        const t = sqliteTable(
            'pk_comp',
            {
                a: integer('a').notNull(),
                b: integer('b').notNull(),
            },
            (table) => [primaryKey(table.a, table.b)],
        );
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('"a" integer NOT NULL');
        expect(ddl).toContain('"b" integer NOT NULL');
    });

    test('composite UNIQUE constraint', () => {
        const t = sqliteTable(
            'uq_comp',
            {
                id: integer('id').primaryKey(),
                a: integer('a').notNull(),
                b: integer('b').notNull(),
            },
            (table) => [unique().on(table.a, table.b)],
        );
        const ddl = generateCreateTableSql(t);
        // Should not duplicate UNIQUE at column level for composite
        expect(ddl).not.toMatch(/"a" integer NOT NULL UNIQUE/);
    });

    test('explicit numeric DEFAULT', () => {
        const t = sqliteTable('def_explicit', {
            id: integer('id'),
            count: integer('count').default(sql`42`),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('DEFAULT 42');
    });

    test('DEFAULT — string with single quote escaped', () => {
        const t = sqliteTable('def_quote', {
            id: integer('id'),
            name: text('name').default("O'Brien"),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain("DEFAULT 'O''Brien'");
    });

    test('FOREIGN KEY with ON UPDATE', () => {
        const parent = sqliteTable('parent3', {
            id: integer('id').primaryKey(),
        });
        const child = sqliteTable('child3', {
            id: integer('id').primaryKey(),
            parentId: integer('parent_id').references(() => parent.id, { onUpdate: 'cascade' }),
        });
        const ddl = generateCreateTableSql(child);
        expect(ddl).toContain('ON UPDATE cascade');
    });

    test('FOREIGN KEY with both ON DELETE and ON UPDATE', () => {
        const parent = sqliteTable('parent4', {
            id: integer('id').primaryKey(),
        });
        const child = sqliteTable('child4', {
            id: integer('id').primaryKey(),
            parentId: integer('parent_id').references(() => parent.id, {
                onDelete: 'cascade',
                onUpdate: 'set null',
            }),
        });
        const ddl = generateCreateTableSql(child);
        expect(ddl).toContain('ON DELETE cascade');
        expect(ddl).toContain('ON UPDATE set null');
    });

    test('identifier quoting — escaped double quote', () => {
        const t = sqliteTable('weird"name', {
            id: integer('id').primaryKey(),
        });
        const ddl = generateCreateTableSql(t);
        expect(ddl).toContain('"weird""name"');
    });

    test('schema equivalence — verify on :memory: SQLite', () => {
        const t = sqliteTable('test_table', {
            id: integer('id').primaryKey(),
            name: text('name').notNull(),
            email: text('email').unique(),
            score: integer('score').default(0),
        });
        const ddl = generateCreateTableSql(t);

        const conn = openMemory();
        conn.run(ddl);
        const info = conn.query('PRAGMA table_info("test_table")').all() as Array<{
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: unknown;
            pk: number;
        }>;
        conn.close();

        expect(info.length).toBe(4);

        const id = info.find((c) => c.name === 'id');
        expect(id).toBeDefined();
        if (!id) throw new Error('id not found');
        expect(id.type).toBe('INTEGER');
        expect(id.pk).toBe(1);

        const nameCol = info.find((c) => c.name === 'name');
        expect(nameCol).toBeDefined();
        if (!nameCol) throw new Error('nameCol not found');
        expect(nameCol.type).toBe('TEXT');
        expect(nameCol.notnull).toBe(1);

        const email = info.find((c) => c.name === 'email');
        expect(email).toBeDefined();
        if (!email) throw new Error('email not found');
        expect(email.type).toBe('TEXT');

        const score = info.find((c) => c.name === 'score');
        expect(score).toBeDefined();
        if (!score) throw new Error('score not found');
        expect(score.type).toBe('INTEGER');
        expect(score.dflt_value).toBe('0');
    });
});

// ---------------------------------------------------------------------------
// defineTable — createTableSql integration
// ---------------------------------------------------------------------------

describe('defineTable createTableSql', () => {
    const users = defineTable('users_ddl', {
        id: text('id').primaryKey(),
        email: text('email').notNull().unique(),
        ...standardColumns,
    });

    test('produces CREATE TABLE DDL', () => {
        const ddl = users.createTableSql;
        expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "users_ddl"');
        expect(ddl).toContain('"id" text PRIMARY KEY NOT NULL');
        expect(ddl).toContain('"email" text NOT NULL UNIQUE');
    });

    test('createTableSql is lazy and memoised', () => {
        const ddl1 = users.createTableSql;
        const ddl2 = users.createTableSql;
        expect(ddl1).toBe(ddl2);
    });

    test('DDL is schema-equivalent on SQLite', () => {
        const conn = openMemory();
        conn.run(users.createTableSql);

        const info = conn.query('PRAGMA table_info("users_ddl")').all() as Array<{
            cid: number;
            name: string;
            type: string;
            notnull: number;
            pk: number;
        }>;
        conn.close();

        expect(info.length).toBeGreaterThanOrEqual(4);
        const id = info.find((c) => c.name === 'id');
        expect(id).toBeDefined();
        if (!id) throw new Error('id not found');
        expect(id.pk).toBe(1);

        const email = info.find((c) => c.name === 'email');
        expect(email).toBeDefined();
        if (!email) throw new Error('email not found');
        expect(email.notnull).toBe(1);

        // standardColumns: created_at, updated_at
        expect(info.find((c) => c.name === 'created_at')).toBeDefined();
        expect(info.find((c) => c.name === 'updated_at')).toBeDefined();
    });
});
