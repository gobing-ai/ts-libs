import { integer } from 'drizzle-orm/sqlite-core';

/**
 * Returns the current timestamp in milliseconds.
 * Extracted for testability and V8 coverage tracking.
 */
export function nowTimestamp(): number {
    return Date.now();
}

/**
 * Standard columns shared across all entity tables.
 *
 * Uses plain `integer` (returns `number`) to match the existing codebase
 * convention where `nowMs()` returns `number` and all timestamp comparisons
 * use numeric operators.
 *
 * Usage in schema definitions:
 * ```ts
 * import { standardColumns } from './common';
 *
 * export const myTable = sqliteTable('my_table', {
 *     id: text('id').primaryKey(),
 *     name: text('name').notNull(),
 *     ...standardColumns,
 * });
 * ```
 */
export function buildStandardColumns() {
    return {
        createdAt: integer('created_at').notNull().$defaultFn(nowTimestamp).default(0),
        updatedAt: integer('updated_at').notNull().$defaultFn(nowTimestamp).default(0),
    };
}

/**
 * Standard columns (createdAt, updatedAt) for use in Drizzle table definitions via spread.
 */
export const standardColumns = buildStandardColumns();

/**
 * Standard columns with soft-delete support.
 *
 * Adds an `inUsed` column (1 = active, 0 = soft-deleted).
 * EntityDao automatically filters by `inUsed = 1` when the table has this column.
 */
export function buildStandardColumnsWithSoftDelete() {
    return {
        ...buildStandardColumns(),
        inUsed: integer('in_used').notNull().default(1),
    };
}

/**
 * Standard columns with soft-delete `inUsed` flag for use in Drizzle table definitions via spread.
 */
export const standardColumnsWithSoftDelete = buildStandardColumnsWithSoftDelete();

/**
 * Type helper for tables that use standard columns.
 * Provides the `inUsed`, `updatedAt`, `createdAt` column types.
 */
export type StandardColumns = typeof standardColumns;

/**
 * Type helper for tables that use standard columns with soft delete.
 */
export type StandardColumnsWithSoftDelete = typeof standardColumnsWithSoftDelete;

/**
 * Build append-only columns (createdAt only, no updatedAt).
 *
 * Enforces D-013 at the schema level: tables using this helper
 * cannot support update operations because there is no `updatedAt`
 * column to track mutations.
 */
export function buildAppendOnlyColumns() {
    return {
        createdAt: integer('created_at').notNull().$defaultFn(nowTimestamp).default(0),
    };
}

/**
 * Append-only columns for Drizzle table definitions via spread.
 *
 * Usage:
 * ```ts
 * export const runEvents = sqliteTable('run_event', {
 *     id: text('id').primaryKey(),
 *     ...appendOnlyColumns,
 * });
 * ```
 */
export const appendOnlyColumns = buildAppendOnlyColumns();
