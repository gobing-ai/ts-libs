import type { RuntimeFactory, RuntimeName } from './runtime-factory';

// Single authoritative source for runtime detection.
// All other code MUST consume RuntimeFactory via loadRuntimeFactory().
// Probe-once contract: each primitive is invoked at most once per process and
// the result is cached in `_factory` / `_runtimeName`.

/** True when running in a Cloudflare Worker (server-tier only). */
export function isCloudflareWorkerRuntime(): boolean {
    return globalThis.navigator?.userAgent?.startsWith('Cloudflare-Workers') ?? false;
}

let _factory: RuntimeFactory | undefined;
let _runtimeName: RuntimeName | undefined;

/**
 * Lazy-load and cache the appropriate {@link RuntimeFactory} based on environment detection.
 */
export async function loadRuntimeFactory(): Promise<RuntimeFactory> {
    if (_factory) return _factory;

    let factory: RuntimeFactory;
    if (getRuntimeName() === 'cloudflare-workers') {
        const { cloudflareWorkersFactory } = await import('./runtime-cf');
        factory = cloudflareWorkersFactory;
    } else {
        const { nodeBunFactory } = await import('./runtime-node-bun');
        factory = nodeBunFactory;
    }
    _factory = factory;
    return factory;
}

function getRuntimeName(): RuntimeName {
    if (_runtimeName) return _runtimeName;
    _runtimeName = isCloudflareWorkerRuntime() ? 'cloudflare-workers' : 'node-bun';
    return _runtimeName;
}

/**
 * Reset the cached runtime factory and name (for test isolation).
 */
export function _resetRuntimeFactory(): void {
    _factory = undefined;
    _runtimeName = undefined;
}
