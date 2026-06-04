import type { Config } from './config';
import type { FileSystem } from './file-system';
import type { ProcessExecutor, ProcessExecutorConfig } from './process-executor';

/**
 * @internal — confined to packages/runtime/src/; not public API
 */
export type RuntimeName = 'node-bun' | 'cloudflare-workers';

/**
 * Describes what capabilities a runtime environment provides.
 */
export interface RuntimeCapabilities {
    readonly hasFilesystem: boolean;
    readonly hasProcessExecution: boolean;
}

/** Options controlling config loading. */
export interface LoadConfigOptions {
    /** Partial overrides merged on top of the parsed config. */
    overrides?: Partial<Config>;
    /** Runtime request bindings/vars, used by Cloudflare Workers for CONFIG_YAML text blob. */
    envBindings?: Record<string, unknown>;
}

/**
 * Abstract factory for creating runtime-aware infrastructure.
 *
 * Each runtime environment (Node/Bun, Cloudflare Workers) provides its own
 * implementation. Consumers call {@link loadRuntimeFactory} to get the
 * appropriate factory, then use it to create FileSystem, ProcessExecutor,
 * and load configuration.
 */
export interface RuntimeFactory {
    /** Stable runtime identity owned by the factory implementation. */
    readonly runtimeName: RuntimeName;

    readonly capabilities: RuntimeCapabilities;

    /** Create a runtime-specific file system (real fs for Node/Bun, stub for CF Workers). */
    createFileSystem(): FileSystem;

    /** Create a runtime-specific process executor (execa-backed for Node/Bun, throws on CF Workers). */
    createProcessExecutor(config?: ProcessExecutorConfig): ProcessExecutor;

    /** Load config from the runtime's config backend. */
    loadConfig(options?: LoadConfigOptions): Promise<Config>;
}
