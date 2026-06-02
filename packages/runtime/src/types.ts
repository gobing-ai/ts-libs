import type { Config } from './config';

export type RuntimeName = 'node-bun' | 'cloudflare-workers' | 'test';

export interface RuntimeCapabilities {
    readonly hasFilesystem: boolean;
    readonly hasProcessExecution: boolean;
    readonly hasPersistentStorage: boolean;
}

export interface LoadConfigOptions {
    overrides?: Partial<Config>;
    envBindings?: Record<string, unknown>;
}

export interface SpanContext {
    traceId: string;
    spanId: string;
    baggage?: Record<string, string>;
    attributes?: Record<string, string | number | boolean>;
}
