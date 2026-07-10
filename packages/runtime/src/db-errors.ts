/**
 * Thrown by {@link RuntimeFactory.createDbAdapter} on runtimes that cannot yet
 * provide a SQL database adapter.
 *
 * Today only the Cloudflare Workers factory throws this: the D1 `DbAdapter`
 * lives in a future `@gobing-ai/ts-db` round. The method exists on the
 * interface so consumer app code is forward-compatible — it calls
 * `createDbAdapter` uniformly and the Worker path surfaces this clear typed
 * failure instead of a silent `undefined`.
 */
export class D1NotConfiguredError extends Error {
    constructor(message = 'D1 DbAdapter is not yet implemented; see the ts-db D1 round.') {
        super(message);
        this.name = 'D1NotConfiguredError';
    }
}

/**
 * Thrown by {@link RuntimeFactory.createDbAdapter} on `node-bun` when the
 * optional peer `@gobing-ai/ts-db` is not installed.
 *
 * `ts-db` is an **optional peerDependency** of `ts-runtime` (ADR-012 addendum):
 * it cannot be a regular dependency because `ts-db` depends on `ts-runtime`
 * (manifest cycle). Consumers who call `nodeBunFactory.createDbAdapter` must
 * install `@gobing-ai/ts-db` themselves. This error surfaces a missing module
 * as an actionable, typed failure instead of a raw `MODULE_NOT_FOUND`.
 */
export class DbModuleNotInstalledError extends Error {
    constructor(
        message = '@gobing-ai/ts-db is not installed. It is an optional peer of @gobing-ai/ts-runtime, required only for createDbAdapter on node-bun. Install it (`bun add @gobing-ai/ts-db`) or, when bundling, mark `@gobing-ai/ts-db` external.',
        options?: ErrorOptions,
    ) {
        super(message, options);
        this.name = 'DbModuleNotInstalledError';
    }
}
