/**
 * Dependency-free env gateway mirror for root `scripts/**` (release/builder tooling).
 * Root-level scripts cannot depend on workspace packages under bun isolated installs,
 * so `getEnvVar` is mirrored from `packages/utils/src/env.ts` — keep both in sync.
 * The `env-var-hygiene` rule excludes this file for the same reason it excludes
 * `packages/utils/src/env.ts`.
 */

/** Read one environment variable. Only an unset variable yields `fallback`. */
export function getEnvVar(name: string, fallback?: string): string | undefined {
    const raw = process.env[name];
    return raw === undefined ? fallback : raw;
}

/** Set one environment variable; `undefined` removes the key (see gateway). */
export function setEnvVar(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
}

/** Remove one environment variable; a no-op when the key is absent. */
export function removeEnvVar(name: string): void {
    delete process.env[name];
}
