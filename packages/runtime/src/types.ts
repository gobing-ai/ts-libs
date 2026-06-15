import type { Config } from './config';

/** Identifier for the target runtime platform. */
export type RuntimeName = 'node-bun' | 'cloudflare-workers' | 'test';

/**
 * Feature flags describing what a runtime platform supports (filesystem, process
 * execution, persistent storage, SQL database).
 */
export interface RuntimeCapabilities {
    readonly hasFilesystem: boolean;
    readonly hasProcessExecution: boolean;
    readonly hasPersistentStorage: boolean;
    /**
     * Whether the runtime can provide a connected {@link DbAdapter}.
     *
     * `true` on Node/Bun (Bun SQLite); `false` on Cloudflare Workers until the
     * D1 round ships — the CF factory's `createDbAdapter` throws a typed
     * {@link D1NotConfiguredError} so consumer code is forward-compatible.
     */
    readonly hasSqlDatabase: boolean;
}

/**
 * Configuration for {@link RuntimeFactory.createDbAdapter}.
 *
 * Focused on the DB facility so it does not bloat the general runtime {@link Config}.
 * The Bun path reads `url` (a filesystem path or `":memory:"`); the Cloudflare path
 * would read `d1Binding` (scoped to a later ts-db round).
 */
export interface DatabaseConfig {
    /** SQLite database path or `":memory:"`. Bun path only. */
    url: string;
    /** Optional driver hint. Reserved for future drivers. */
    driver?: string;
    /** Name of the D1 binding in wrangler.toml. CF path (future D1 round). */
    d1Binding?: string;
}

/**
 * Structural database adapter contract — the runtime-facing subset of
 * `@gobing-ai/ts-db`'s `DbAdapter`.
 *
 * ts-runtime cannot import the `DbAdapter` type from ts-db at build time
 * (ts-db depends on ts-runtime, so the build order is runtime → db). This
 * structural type captures the public method surface; a ts-db `DbAdapter` is
 * assignable to it because it implements every method (plus the `@internal db`
 * property, which is extra and harmless under structural subtyping).
 *
 * The full `DbAdapter` type is re-exported from the package index via
 * `import type` for consumer convenience; this structural type is the
 * build-time contract used inside the factory.
 */
export interface RuntimeDbAdapter {
    /** Run a raw SQL statement with no parameters (DDL). */
    exec(sql: string): Promise<void>;
    /** Parameterized write (INSERT/UPDATE/DELETE) that returns no rows. */
    run(sql: string, ...params: unknown[]): Promise<void>;
    /** Parameterized read returning the first row, or undefined. */
    queryFirst<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    /** Parameterized read returning all rows. */
    queryAll<T>(sql: string, ...params: unknown[]): Promise<T[]>;
    /** Close the underlying connection. */
    close(): void;
}

/** Options passed to config loading functions, including overrides and environment variable bindings. */
export interface LoadConfigOptions {
    overrides?: Partial<Config>;
    envBindings?: Record<string, unknown>;
}

/** Minimal distributed tracing context for W3C trace/span propagation. */
export interface SpanContext {
    traceId: string;
    spanId: string;
    baggage?: Record<string, string>;
    attributes?: Record<string, string | number | boolean>;
}
