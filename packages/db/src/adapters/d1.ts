import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import type { DbAdapter, DbClient } from '../adapter.js';
import * as schema from '../schema/index.js';

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

    getDb(): DbClient {
        return this.drizzleDb as unknown as DbClient;
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

    close(): void {
        // D1 bindings are managed by the Workers runtime -- no-op
    }
}
