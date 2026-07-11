import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import type { DrizzleD1Database } from 'drizzle-orm/d1';

/**
 * Minimal D1 binding interface — avoids depending on @cloudflare/workers-types.
 */
interface D1Binding {
    prepare(sql: string): unknown;
    exec(sql: string): Promise<void>;
}

/**
 * Internal typed drizzle database handle.
 *
 * This is the REAL drizzle database (bun:sqlite or D1 flavour), fully typed.
 * It is `@internal` — ts-db's DAO base classes use it to build queries, but it
 * is never part of the public API. Consumers depend only on the ts-db facade
 * (DAOs, the predicate spec), never on drizzle types directly. (G1)
 *
 * @internal
 */
export type InternalDb = BunSQLiteDatabase<Record<string, unknown>> | DrizzleD1Database<Record<string, unknown>>;

/**
 * Database adapter: construction, lifecycle, the internal typed drizzle db, and a
 * raw string-SQL escape for DDL / dynamic identifiers.
 *
 * The internal drizzle db (`db`) is exposed only to ts-db's own DAO layer; the
 * string-SQL methods are the sole raw escape, intended for DDL and dynamic
 * identifiers and gated to DAO files by a consumer-side lint rule.
 */
export interface DbAdapter {
    /**
     * The internal typed drizzle database. ts-db DAO layer only — not public API.
     * @internal
     */
    readonly db: InternalDb;
    /** Run a raw SQL statement with no parameters (DDL). */
    exec(sql: string): Promise<void>;
    /** Parameterized write (INSERT/UPDATE/DELETE) that returns no rows. */
    run(sql: string, ...params: unknown[]): Promise<void>;
    /** Parameterized read returning the first row, or undefined. */
    queryFirst<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    /** Parameterized read returning all rows. */
    queryAll<T>(sql: string, ...params: unknown[]): Promise<T[]>;
    /**
     * Execute a batch of parameterized writes atomically — either all commit or
     * none do. Used by adapters that need to persist multiple related rows in a
     * single transaction (e.g. workflow transition + state snapshot + phase write).
     * Each entry is a `{ sql, params }` tuple applied in order. If the adapter's
     * backend does not support transactions, this falls back to sequential `run()`
     * calls (callers must accept weaker atomicity on such backends).
     */
    batch(operations: readonly DbBatchOp[]): Promise<void>;
    /** Close the underlying connection. */
    close(): void;
}

/**
 * A single write operation inside a {@link DbAdapter.batch} call.
 */
export interface DbBatchOp {
    /** SQL statement (INSERT/UPDATE/DELETE). */
    sql: string;
    /** Bind parameters for the statement. */
    params: readonly unknown[];
}

/**
 * Discriminated-union config for creating a database adapter (bun-sqlite or D1).
 */
export type DbAdapterConfig =
    | {
          driver: 'bun-sqlite';
          url?: string;
          pragmas?: {
              journalMode?: string;
              synchronous?: string;
              foreignKeys?: string;
          };
      }
    | { driver: 'd1'; binding: D1Binding };

/**
 * Factory: creates the correct {@link DbAdapter} implementation based on driver config.
 */
export async function createDbAdapter(config: DbAdapterConfig): Promise<DbAdapter> {
    switch (config.driver) {
        case 'bun-sqlite': {
            const { BunSqliteAdapter } = await import('./adapters/bun-sqlite');
            return new BunSqliteAdapter({
                ...(config.url ? { databaseUrl: config.url } : {}),
                ...(config.pragmas ? { pragmas: config.pragmas } : {}),
            });
        }
        case 'd1': {
            const { D1Adapter } = await import('./adapters/d1');
            return new D1Adapter(config.binding as import('./adapters/d1').D1Binding);
        }
    }
}
