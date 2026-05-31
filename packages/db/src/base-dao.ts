import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { DbAdapter, InternalDb } from './adapter';
import { compileOrderBy, compilePredicate, type ListSpec, type Predicate } from './query-spec';

/**
 * A transaction-scoped handle passed to {@link BaseDao.tx} callbacks.
 *
 * Drizzle-free by design — exposes the same internal db shape DAOs use, so a
 * transactional block can run the same structured/raw operations. (G3)
 *
 * @internal
 */
export type TxHandle = InternalDb;

/**
 * Abstract base DAO — the RAW tier of the ts-db facade.
 *
 * Owns the adapter and provides generic, table-agnostic data access:
 * transactions and parameterized queries expressed through the ts-db predicate
 * spec (never drizzle's `sql` tag). ETL / analytics / reporting DAOs extend this
 * directly; {@link EntityDao} extends it to add typed CRUD over a single table.
 *
 * All signatures are ts-db's own vocabulary — drizzle never leaks to consumers. (G1)
 */
export abstract class BaseDao {
    protected constructor(protected readonly adapter: DbAdapter) {}

    /** The internal typed drizzle db. Subclasses use it to build queries. @internal */
    protected get db(): InternalDb {
        return this.adapter.db;
    }

    /** Current timestamp in milliseconds (audit columns, etc.). */
    protected now(): number {
        return Date.now();
    }

    /**
     * Execute a function within a database transaction.
     *
     * Works uniformly on bun:sqlite (sync, wrapped in a promise) and D1 (async).
     * The callback receives a transaction-scoped db handle.
     */
    protected async tx<T>(fn: (tx: TxHandle) => Promise<T>): Promise<T> {
        return (this.db as { transaction: (cb: (tx: TxHandle) => Promise<T>) => Promise<T> }).transaction((tx) =>
            fn(tx),
        );
    }

    /**
     * Run a SELECT against a table, filtered/ordered/paged by a {@link ListSpec}.
     *
     * The raw-tier read primitive: drizzle-free input, typed rows out. Subclasses
     * pass their table; `EntityDao` builds on this for `list`.
     */
    protected async query<T>(table: SQLiteTable, spec: ListSpec = {}): Promise<T[]> {
        const condition = spec.where ? compilePredicate(spec.where) : undefined;
        const order = spec.orderBy ? compileOrderBy(spec.orderBy) : [];

        // drizzle's fluent builder is internal here; the public input is the spec.
        let q = (this.db as InternalDb).select().from(table) as unknown as {
            where: (c: unknown) => typeof q;
            orderBy: (...o: unknown[]) => typeof q;
            limit: (n: number) => typeof q;
            offset: (n: number) => typeof q;
        };
        if (condition) q = q.where(condition);
        if (order.length > 0) q = q.orderBy(...order);
        if (spec.limit !== undefined) q = q.limit(spec.limit);
        if (spec.offset !== undefined) q = q.offset(spec.offset);
        return (await (q as unknown as Promise<T[]>)) ?? [];
    }

    /** Run a SELECT and return the first matching row, or undefined. */
    protected async one<T>(table: SQLiteTable, where: Predicate): Promise<T | undefined> {
        const rows = await this.query<T>(table, { where, limit: 1 });
        return rows[0];
    }
}
