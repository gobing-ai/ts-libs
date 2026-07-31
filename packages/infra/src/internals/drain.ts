/**
 * Internal drain primitives shared by adapters that bound a shutdown wait on
 * in-flight work (DB queue consumer, Node scheduler).
 *
 * WHY: two adapters had near-identical "await this in-flight thing but not
 * forever" logic. Centralizing the bound keeps the two shapes from drifting
 * and documents the contract once. Not re-exported from the package barrel —
 * consumers depend on adapter behaviour, not this helper.
 */

/**
 * Resolve when `promise` settles or when `deadline` passes, whichever comes first.
 *
 * Never rejects: a rejected promise ends the wait the same way a fulfilled one
 * does. `deadline` is an absolute epoch-ms timestamp (not a duration) so a single
 * bound can be shared across several awaited promises without compounding.
 */
export function settleWithin(promise: Promise<void>, deadline: number): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return Promise.resolve();
    const { promise: settled, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, remaining);
    const done = (): void => {
        clearTimeout(timer);
        resolve();
    };
    promise.then(done, done);
    return settled;
}
