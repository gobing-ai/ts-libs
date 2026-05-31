import { and, asc, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lt, lte, ne, or, type SQL } from 'drizzle-orm';
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core';

/**
 * A column reference for the ts-db predicate spec.
 *
 * Consumers obtain these from their own ts-db table definitions (e.g. `users.email`),
 * never by importing from `drizzle-orm` — keeping the drizzle dependency internal.
 */
export type ColRef = SQLiteColumn;

/** Binary comparison operators supported by the predicate spec. */
export type ComparisonOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like';

/**
 * Drizzle-free predicate vocabulary for `where`/`count` filters.
 *
 * Deliberately small (the "lean facade"): enough for the common 90% of filters.
 * Anything beyond (joins, aggregates, window functions) belongs in a named DAO
 * method that uses drizzle privately, never in this public spec.
 */
export type Predicate =
    | { col: ColRef; op: ComparisonOp; value: unknown }
    | { col: ColRef; op: 'in'; values: readonly unknown[] }
    | { col: ColRef; op: 'isNull' | 'isNotNull' }
    | { and: readonly Predicate[] }
    | { or: readonly Predicate[] };

/** A single ordering term: a column and an optional direction (default `asc`). */
export interface OrderTerm {
    col: ColRef;
    dir?: 'asc' | 'desc';
}

/** Options accepted by the structured `list` operation. */
export interface ListSpec {
    where?: Predicate;
    orderBy?: readonly OrderTerm[];
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
}

const COMPARISON_BUILDERS: Record<ComparisonOp, (col: ColRef, value: unknown) => SQL> = {
    eq: (col, value) => eq(col, value),
    ne: (col, value) => ne(col, value),
    gt: (col, value) => gt(col, value),
    gte: (col, value) => gte(col, value),
    lt: (col, value) => lt(col, value),
    lte: (col, value) => lte(col, value),
    like: (col, value) => like(col, value as string),
};

/**
 * Compile a ts-db {@link Predicate} into a drizzle `SQL` condition.
 *
 * Internal to ts-db — consumers never see drizzle's `SQL` type. Returns
 * `undefined` for an empty `and`/`or` group so callers can omit the filter.
 */
export function compilePredicate(predicate: Predicate): SQL | undefined {
    if ('and' in predicate) {
        const parts = predicate.and.map(compilePredicate).filter((p): p is SQL => p !== undefined);
        return parts.length > 0 ? and(...parts) : undefined;
    }
    if ('or' in predicate) {
        const parts = predicate.or.map(compilePredicate).filter((p): p is SQL => p !== undefined);
        return parts.length > 0 ? or(...parts) : undefined;
    }
    switch (predicate.op) {
        case 'isNull':
            return isNull(predicate.col);
        case 'isNotNull':
            return isNotNull(predicate.col);
        case 'in':
            return inArray(predicate.col, predicate.values as unknown[]);
        default:
            return COMPARISON_BUILDERS[predicate.op](predicate.col, predicate.value);
    }
}

/** Compile a list of {@link OrderTerm}s into drizzle order-by `SQL` clauses. */
export function compileOrderBy(orderBy: readonly OrderTerm[]): SQL[] {
    return orderBy.map((term) => (term.dir === 'desc' ? desc(term.col) : asc(term.col)));
}
