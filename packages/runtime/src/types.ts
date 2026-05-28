import type { Config } from './config';
import type { RuntimeContext } from './context';
import type { FileSystem } from './fs';

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

export interface RuntimeFactory {
    readonly runtimeName: RuntimeName;
    readonly capabilities: RuntimeCapabilities;
    createFileSystem(): FileSystem;
    loadConfig(options?: LoadConfigOptions): Promise<Config>;
    createContext?(options?: { scope?: string }): RuntimeContext;
}

export interface SpanContext {
    traceId: string;
    spanId: string;
    baggage?: Record<string, string>;
    attributes?: Record<string, string | number | boolean>;
}
