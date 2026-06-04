import type { Config } from './config';
import { buildConfigFromObject } from './config';
import type { FileSystem } from './fs';
import { getFs } from './fs';
import { loadRuntimeFactory } from './platform';
import type { RuntimeCapabilities, RuntimeName } from './types';
/** Execution scope of a runtime context — determines service lifecycle and availability. */
export type RuntimeScope = 'process' | 'server-request' | 'scheduled-event' | 'test';

/** Map of named services available to a runtime context, including the required `config` and `fileSystem`. */
export interface RuntimeServiceMap {
    config: Config;
    fileSystem: FileSystem;
    [serviceName: string]: unknown;
}

/** Options for constructing a {@link RuntimeContext}. */
export interface RuntimeContextOptions<TServices extends RuntimeServiceMap = RuntimeServiceMap> {
    scope?: RuntimeScope;
    runtimeName?: RuntimeName;
    capabilities?: RuntimeCapabilities;
    services?: Partial<TServices>;
}

/** Injectable service container scoped to a runtime environment (process, request, event, or test). */
export class RuntimeContext<TServices extends RuntimeServiceMap = RuntimeServiceMap> {
    readonly scope: RuntimeScope;
    readonly runtimeName: RuntimeName;
    readonly capabilities: RuntimeCapabilities;
    readonly services = new Map<keyof TServices, TServices[keyof TServices]>();

    constructor(options: RuntimeContextOptions<TServices> = {}) {
        this.scope = options.scope ?? 'process';
        this.runtimeName = options.runtimeName ?? 'node-bun';
        this.capabilities =
            options.capabilities ??
            ({
                hasFilesystem: true,
                hasProcessExecution: true,
                hasPersistentStorage: true,
            } satisfies RuntimeCapabilities);

        this.register('config', (options.services?.config ?? buildConfigFromObject({})) as TServices['config']);
        this.register('fileSystem', (options.services?.fileSystem ?? getFs()) as TServices['fileSystem']);

        for (const [key, value] of Object.entries(options.services ?? {})) {
            if (value !== undefined) {
                this.register(key as keyof TServices, value as TServices[keyof TServices]);
            }
        }
    }

    register<K extends keyof TServices>(key: K, service: TServices[K]): this {
        this.services.set(key, service);
        return this;
    }

    get<K extends keyof TServices>(key: K): TServices[K] | undefined {
        return this.services.get(key) as TServices[K] | undefined;
    }

    require<K extends keyof TServices>(key: K): TServices[K] {
        const service = this.get(key);
        if (service === undefined) {
            throw new Error(`Runtime service "${String(key)}" is unavailable for runtime ${this.runtimeName}.`);
        }
        return service;
    }

    has<K extends keyof TServices>(key: K): boolean {
        return this.services.has(key);
    }

    async dispose(): Promise<void> {
        const errors: Error[] = [];
        for (const service of this.services.values()) {
            if (isDisposable(service)) {
                try {
                    await service.dispose();
                } catch (error) {
                    errors.push(error instanceof Error ? error : new Error(String(error)));
                }
            }
        }
        if (errors.length > 0) {
            throw new Error(`Failed to dispose some services:\n${errors.map((e) => `- ${e.message}`).join('\n')}`);
        }
    }
}

function isDisposable(value: unknown): value is { dispose(): void | Promise<void> } {
    return typeof value === 'object' && value !== null && 'dispose' in value && typeof value.dispose === 'function';
}

/**
 * Create a {@link RuntimeContext} wired to the auto-detected runtime factory.
 *
 * Loads the platform-specific factory via {@link loadRuntimeFactory},
 * auto-wires FileSystem, ProcessExecutor, and Config, then returns a
 * ready-to-use context. Call this at the entry point of any app or worker.
 *
 * @example
 * ```ts
 * const ctx = await createRuntimeContextFromFactory();
 * const fs = ctx.require('fileSystem');
 * const config = ctx.require('config');
 * ```
 */
export async function createRuntimeContextFromFactory<TServices extends RuntimeServiceMap = RuntimeServiceMap>(
    options?: RuntimeContextOptions<TServices>,
): Promise<RuntimeContext<TServices>> {
    const factory = await loadRuntimeFactory();
    const config = await factory.loadConfig();
    const fileSystem = factory.createFileSystem();

    return new RuntimeContext<TServices>({
        scope: 'process',
        runtimeName: factory.runtimeName,
        capabilities: {
            hasFilesystem: factory.capabilities.hasFilesystem,
            hasProcessExecution: factory.capabilities.hasProcessExecution,
            hasPersistentStorage: true,
        },
        services: {
            config,
            fileSystem,
            ...options?.services,
        },
    } as RuntimeContextOptions<TServices>);
}

/**
 * @deprecated Use {@link createRuntimeContextFromFactory} instead —
 * it auto-detects the platform and wires the correct services from the factory.
 * This function is kept for backward compatibility with synchronous callers
 * that manually configure services.
 */
export function createRuntimeContext<TServices extends RuntimeServiceMap = RuntimeServiceMap>(
    options: RuntimeContextOptions<TServices> = {},
): RuntimeContext<TServices> {
    return new RuntimeContext<TServices>(options);
}
