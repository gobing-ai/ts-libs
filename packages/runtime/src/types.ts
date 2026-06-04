import type { Config } from './config';

/** Identifier for the target runtime platform. */
export type RuntimeName = 'node-bun' | 'cloudflare-workers' | 'test';

/** Feature flags describing what a runtime platform supports (filesystem, process execution, persistent storage). */
export interface RuntimeCapabilities {
    readonly hasFilesystem: boolean;
    readonly hasProcessExecution: boolean;
    readonly hasPersistentStorage: boolean;
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
