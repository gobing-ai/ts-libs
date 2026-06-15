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
