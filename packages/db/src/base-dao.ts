import type { DbClient } from './adapter';

/**
 * Abstract base DAO providing transaction and timestamp utilities to all entity DAOs.
 */
export abstract class BaseDao {
    /**
     * DB transaction utility for subclasses.
     *
     * Constructor is `protected` — instantiate through concrete DAO subclasses,
     * not BaseDao directly. Tests must declare an explicit public constructor
     * that calls `super(db)` to expose the protected constructor publicly.
     */
    protected constructor(protected readonly db: DbClient) {}

    protected now(): number {
        return Date.now();
    }

    /**
     * Execute a function within a database transaction.
     *
     * Works uniformly on both D1 (async) and bun:sqlite (sync wrapped in promise).
     * The callback receives a transaction-scoped DbClient.
     *
     * @param fn - Function to execute within the transaction.
     * @returns The return value of `fn`.
     */
    protected async withTransaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
        // Drizzle's .transaction() works on both backends:
        // - bun:sqlite: sync wrapped in a promise
        // - D1: native async
        return (this.db as unknown as { transaction: (fn: unknown) => Promise<T> }).transaction(async (tx: DbClient) =>
            fn(tx),
        );
    }
}
