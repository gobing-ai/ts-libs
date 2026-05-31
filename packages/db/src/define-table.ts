import { type SQLiteColumnBuilderBase, sqliteTable } from 'drizzle-orm/sqlite-core';
import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import type { ZodType } from 'zod';

/**
 * A table definition bundled with its drizzle-zod validation schemas.
 *
 * The single source of truth (G2): one table authored once yields the drizzle
 * table (for queries/migrations) plus insert/select zod schemas (for boundary
 * validation), with no parallel re-authoring.
 *
 * The zod schemas are derived lazily — only materialised the first time they are
 * read — so a consumer that only needs the table pays nothing extra.
 *
 * `defineTable`, `insertSchema`, and `selectSchema` require the optional peers
 * `zod` and `drizzle-zod`. Consumers that never validate need not install them
 * and simply use `createDbAdapter` + raw `sqliteTable` + the column helpers.
 */
export interface DefinedTable<TTable> {
    /** The underlying drizzle table — pass to DAOs, migrations, queries. */
    readonly table: TTable;
    /** Zod schema validating a row for insertion. */
    readonly insertSchema: ZodType;
    /** Zod schema validating a selected row. */
    readonly selectSchema: ZodType;
}

/**
 * Define a SQLite table and derive its validation schemas in one place (G2).
 *
 * @example
 * ```ts
 * export const users = defineTable('users', {
 *     id: text('id').primaryKey(),
 *     email: text('email').notNull().unique(),
 *     ...standardColumns,
 * });
 * users.table          // drizzle table for DAOs/migrations
 * users.insertSchema   // zod schema derived from the table
 * ```
 */
export function defineTable<TName extends string, TColumns extends Record<string, SQLiteColumnBuilderBase>>(
    name: TName,
    columns: TColumns,
): DefinedTable<ReturnType<typeof sqliteTable<TName, TColumns>>> {
    const table = sqliteTable(name, columns);

    let insert: ZodType | undefined;
    let select: ZodType | undefined;

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
    };
}
