import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import type { DbAdapter, DbBatchOp, InternalDb } from '../adapter';
import * as schema from '../schema/runtime';

/**
 * Minimal D1 binding interface — avoids depending on @cloudflare/workers-types.
 */
export interface D1Binding {
    prepare(sql: string): {
        bind(...params: unknown[]): D1BoundStatement;
        first?<T>(): Promise<T | null>;
        run?(): Promise<{ results: unknown[]; success: boolean }>;
    };
    exec(sql: string): Promise<void>;
    /**
     * Run multiple statements as a single atomic batch (D1's native `batch()`
     * API). Optional for single-statement test doubles only: when absent,
     * {@link D1Adapter.batch} runs a lone statement directly (trivially atomic)
     * and **throws** for multi-statement batches rather than silently degrading
     * atomicity. Real D1 bindings always provide `batch()`.
     */
    batch?(statements: D1BoundStatement[]): Promise<unknown[]>;
}

interface D1BoundStatement {
    all<T>(): Promise<{ results: T[]; success: boolean }>;
    run(): Promise<{ results: unknown[]; success: boolean }>;
    raw<T>(): Promise<T[]>;
    first?<T>(): Promise<T | null>;
}

/**
 * Cloudflare D1 database adapter.
 *
 * Accepts a D1 binding object matching the Cloudflare Workers D1Database
 * interface shape. No ambient @cloudflare/workers-types dependency required.
 */
export class D1Adapter implements DbAdapter {
    private binding: D1Binding;
    private drizzleDb: DrizzleD1Database<typeof schema>;

    constructor(binding: D1Binding) {
        this.binding = binding;
        this.drizzleDb = drizzle(this.binding, { schema });
    }

    /** The internal typed drizzle database (ts-db DAO layer only). */
    get db(): InternalDb {
        return this.drizzleDb as unknown as InternalDb;
    }

    /** Returns the underlying drizzle instance for migration operations. */
    getDrizzleDb(): DrizzleD1Database<typeof schema> {
        return this.drizzleDb;
    }

    /** Returns the non-mutating binding for advanced direct D1 calls. */
    getBinding(): D1Binding {
        return this.binding;
    }

    async exec(sql: string): Promise<void> {
        await this.binding.exec(sql);
    }

    async run(sql: string, ...params: unknown[]): Promise<void> {
        const stmt = this.binding.prepare(sql);
        const bound = params.length > 0 ? stmt.bind(...params) : stmt;
        await (bound as unknown as { run: () => Promise<unknown> }).run();
    }

    async queryFirst<T>(sql: string, ...params: unknown[]): Promise<T | undefined> {
        const stmt = this.binding.prepare(sql);
        const bound = params.length > 0 ? stmt.bind(...params) : stmt;
        return ((await (bound as unknown as { first: <T>() => Promise<T | null> }).first<T>()) ?? undefined) as
            | T
            | undefined;
    }

    async queryAll<T>(sql: string, ...params: unknown[]): Promise<T[]> {
        const stmt = this.binding.prepare(sql);
        const bound = stmt.bind(...params);
        const result = await (bound as unknown as { all: <T>() => Promise<{ results: T[] }> }).all<T>();
        return result.results ?? [];
    }

    async batch(operations: readonly DbBatchOp[]): Promise<void> {
        if (operations.length === 0) return;
        // A single statement is atomic on its own, so a binding without native
        // batch() may run it directly. Multiple statements without native batch()
        // cannot be made atomic — fail loud rather than silently break the
        // all-or-nothing contract (real D1 bindings always provide batch()).
        if (this.binding.batch === undefined && operations.length > 1) {
            throw new Error(
                `D1 binding has no batch() — cannot execute ${operations.length} statements atomically; ` +
                    'provide a binding with native batch() support',
            );
        }
        const boundStmts: D1BoundStatement[] = operations.map((op) => {
            const stmt = this.binding.prepare(op.sql);
            return op.params.length > 0 ? stmt.bind(...op.params) : stmt.bind();
        });
        if (this.binding.batch !== undefined) {
            await this.binding.batch(boundStmts);
        } else {
            await boundStmts[0]?.run();
        }
    }

    close(): void {
        // D1 bindings are managed by the Workers runtime -- no-op
    }
}
