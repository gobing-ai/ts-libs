import { Database } from 'bun:sqlite';
import { isAbsolute, resolve } from 'node:path';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import type { DbAdapter, DbClient } from '../adapter.js';
import * as schema from '../schema/index.js';

type SqliteStatementLike = {
    all: (...params: unknown[]) => unknown;
    get: (...params: unknown[]) => unknown;
    run: (...params: unknown[]) => unknown;
    values?: (...params: unknown[]) => unknown;
};

/**
 * Configuration options for the bun:sqlite adapter (path, pragmas).
 */
export interface BunSqliteOptions {
    /** Database path or ":memory:". Default: ".spur/spur.db" */
    databaseUrl?: string;
    /** SQLite pragmas. All have sensible defaults. */
    pragmas?: {
        journalMode?: string;
        synchronous?: string;
        foreignKeys?: string;
    };
}

const DEFAULT_PRAGMAS = {
    journalMode: 'PRAGMA journal_mode = WAL',
    synchronous: 'PRAGMA synchronous = NORMAL',
    foreignKeys: 'PRAGMA foreign_keys = ON',
} as const;

const DEFAULT_DB_PATH = '.spur/spur.db';

/**
 * Bun SQLite database adapter backed by `bun:sqlite`.
 */
export class BunSqliteAdapter implements DbAdapter {
    private sqlite: Database;
    private drizzleDb: BunSQLiteDatabase<typeof schema>;
    /**
     * Compiled-statement cache keyed by SQL text. `bun:sqlite` statements are
     * reusable across calls with different params, so caching collapses the
     * per-call `prepare()` recompile that dominated bulk write loops.
     */
    private readonly stmtCache = new Map<string, SqliteStatementLike>();

    private getStatement(sql: string): SqliteStatementLike {
        const cached = this.stmtCache.get(sql);
        if (cached !== undefined) {
            return cached;
        }
        const stmt = this.sqlite.prepare(sql) as unknown as SqliteStatementLike;
        this.stmtCache.set(sql, stmt);
        return stmt;
    }

    constructor(options?: BunSqliteOptions) {
        let dbPath = options?.databaseUrl ?? DEFAULT_DB_PATH;
        const pragmas = { ...DEFAULT_PRAGMAS, ...options?.pragmas };

        // Resolve relative paths
        if (dbPath !== ':memory:' && !isAbsolute(dbPath)) {
            dbPath = resolve(dbPath);
        }

        this.sqlite = new Database(dbPath, { create: true });

        this.sqlite.run(pragmas.journalMode);
        this.sqlite.run(pragmas.synchronous);
        this.sqlite.run(pragmas.foreignKeys);

        this.drizzleDb = drizzle({ client: this.sqlite, schema });
    }

    getDb(): DbClient {
        return this.drizzleDb as unknown as DbClient;
    }

    /** Returns the underlying drizzle instance for migration operations. */
    getDrizzleDb(): BunSQLiteDatabase<typeof schema> {
        return this.drizzleDb;
    }

    async exec(sql: string): Promise<void> {
        this.sqlite.prepare(sql).run();
    }

    async run(sql: string, ...params: unknown[]): Promise<void> {
        const stmt = this.getStatement(sql);
        (stmt as unknown as { run: (...p: unknown[]) => unknown }).run(...params);
    }

    async queryFirst<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
        const stmt = this.getStatement(sql);
        return (stmt as unknown as { get: (...p: unknown[]) => T | undefined }).get(...params) as T | undefined;
    }

    async queryAll<T>(sql: string, ...params: unknown[]): Promise<T[]> {
        const stmt = this.getStatement(sql);
        return ((stmt as unknown as { all: (...p: unknown[]) => T[] }).all(...params) as T[]) ?? [];
    }

    close(): void {
        this.sqlite.close();
    }
}
