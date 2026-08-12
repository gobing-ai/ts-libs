import { type SQLiteColumnBuilderBase, sqliteTable } from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import type { ZodType } from 'zod';
import { generateCreateTableSql } from './ddl';

/**
 * A table definition bundled with its drizzle-zod validation schemas and DDL.
 *
 * The single source of truth (G2): one table authored once yields the drizzle
 * table (for queries/migrations), insert/select zod schemas (for boundary
 * validation), and CREATE TABLE DDL (for migrations) — with no parallel
 * re-authoring.
 *
 * The zod schemas and DDL are derived lazily — only materialised the first
 * time they are read — so a consumer that only needs the table pays nothing
 * extra.
 *
 * The `/schema` subpath requires the optional peers `zod` and `drizzle-zod`.
 * Consumers using only the main facade do not need them.
 */
export interface DefinedTable<TTable> {
    /** The underlying drizzle table — pass to DAOs, migrations, queries. */
    readonly table: TTable;
    /** Zod schema validating a row for insertion. */
    readonly insertSchema: ZodType;
    /** Zod schema validating a selected row. */
    readonly selectSchema: ZodType;
    /** `CREATE TABLE IF NOT EXISTS` DDL generated from the table definition (lazy). */
    readonly createTableSql: string;
}

/**
 * Define a SQLite table and derive its validation schemas and DDL in one place (G2).
 *
 * @example
 * ```ts
 * import { defineTable, standardColumns, text } from '@gobing-ai/ts-db/schema';
 *
 * export const users = defineTable('users', {
 *     id: text('id').primaryKey(),
 *     email: text('email').notNull().unique(),
 *     ...standardColumns,
 * });
 * users.table          // drizzle table for DAOs/migrations
 * users.insertSchema   // zod schema derived from the table
 * users.createTableSql // CREATE TABLE IF NOT EXISTS "users" (...)
 * ```
 */
export function defineTable<TName extends string, TColumns extends Record<string, SQLiteColumnBuilderBase>>(
    name: TName,
    columns: TColumns,
): DefinedTable<ReturnType<typeof sqliteTable<TName, TColumns>>> {
    const table = sqliteTable(name, columns);

    let insert: ZodType | undefined;
    let select: ZodType | undefined;
    let ddl: string | undefined;

    return {
        table,
        get insertSchema(): ZodType {
            if (insert === undefined) {
                insert = createInsertSchema(table) as unknown as ZodType;
            }
            return insert;
        },
        get selectSchema(): ZodType {
            if (select === undefined) {
                select = createSelectSchema(table) as unknown as ZodType;
            }
            return select;
        },
        get createTableSql(): string {
            if (ddl === undefined) {
                ddl = generateCreateTableSql(table);
            }
            return ddl;
        },
    };
}
