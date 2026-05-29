import type { Config } from './config.js';
import { buildConfigFromObject } from './config.js';
import type { FileSystem } from './fs.js';
import { getFs } from './fs.js';
import type { RuntimeCapabilities, RuntimeFactory, RuntimeName } from './types.js';

export type RuntimeScope = 'process' | 'server-request' | 'scheduled-event' | 'test';

export interface RuntimeServiceMap {
    config: Config;
    fileSystem: FileSystem;
    [serviceName: string]: unknown;
}

export interface RuntimeContextOptions<TServices extends RuntimeServiceMap = RuntimeServiceMap> {
    scope?: RuntimeScope;
    runtimeName?: RuntimeName;
    capabilities?: RuntimeCapabilities;
    services?: Partial<TServices>;
    factory?: RuntimeFactory;
}

export class RuntimeContext<TServices extends RuntimeServiceMap = RuntimeServiceMap> {
    readonly scope: RuntimeScope;
    readonly runtimeName: RuntimeName;
    readonly capabilities: RuntimeCapabilities;
    readonly services = new Map<keyof TServices, TServices[keyof TServices]>();

    constructor(options: RuntimeContextOptions<TServices> = {}) {
        this.scope = options.scope ?? 'process';
        this.runtimeName = options.runtimeName ?? options.factory?.runtimeName ?? 'node-bun';
        this.capabilities =
            options.capabilities ??
            options.factory?.capabilities ??
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

export function createRuntimeContext<TServices extends RuntimeServiceMap = RuntimeServiceMap>(
    options: RuntimeContextOptions<TServices> = {},
): RuntimeContext<TServices> {
    return new RuntimeContext<TServices>(options);
}
