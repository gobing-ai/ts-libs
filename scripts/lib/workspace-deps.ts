/**
 * Resolution of `workspace:*` internal dependency ranges for publishing.
 *
 * Internal `@gobing-ai/*` packages depend on each other via the `workspace:`
 * protocol so the version range never has to be hand-maintained. Bun resolves
 * these locally during development, but this repo publishes with `npm publish`
 * (for OIDC Trusted Publishing), and that path does NOT substitute the
 * `workspace:` protocol — it would ship the literal `"workspace:*"` string and
 * break the package on the registry.
 *
 * This module substitutes `workspace:` ranges with a concrete caret range
 * (`^<version>`) read from the depended-on package, immediately before publish.
 */

/** A package.json shape, narrowed to the dependency maps we rewrite. */
export interface ManifestLike {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    [key: string]: unknown;
}

const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** True when a range uses the `workspace:` protocol (e.g. `workspace:*`, `workspace:^1.2.3`). */
export function isWorkspaceRange(range: string): boolean {
    return range.startsWith('workspace:');
}

/**
 * Resolve a single `workspace:` range against the concrete version of the
 * depended-on package.
 *
 * - `workspace:*`        → `^<version>`   (caret of the sibling's version)
 * - `workspace:^`        → `^<version>`
 * - `workspace:~`        → `~<version>`
 * - `workspace:<range>`  → `<range>`      (explicit range after the protocol wins)
 */
export function resolveWorkspaceRange(range: string, version: string): string {
    const suffix = range.slice('workspace:'.length);
    if (suffix === '*' || suffix === '' || suffix === '^') return `^${version}`;
    if (suffix === '~') return `~${version}`;
    return suffix;
}

/**
 * Return a copy of `manifest` with every `workspace:` internal dependency range
 * replaced by a concrete range, using `versions` (name → version) for lookup.
 *
 * @throws if a `workspace:` dep names a package not present in `versions`.
 */
export function substituteWorkspaceRanges(
    manifest: ManifestLike,
    versions: Map<string, string>,
): { manifest: ManifestLike; changed: number } {
    const next: ManifestLike = { ...manifest };
    let changed = 0;

    for (const field of DEP_FIELDS) {
        const deps = manifest[field];
        if (!deps) continue;
        const nextDeps: Record<string, string> = { ...deps };
        for (const [name, range] of Object.entries(deps)) {
            if (!isWorkspaceRange(range)) continue;
            const version = versions.get(name);
            if (version === undefined) {
                throw new Error(
                    `workspace dependency "${name}" (range "${range}") has no known version — is it a workspace package?`,
                );
            }
            nextDeps[name] = resolveWorkspaceRange(range, version);
            changed += 1;
        }
        next[field] = nextDeps;
    }

    return { manifest: next, changed };
}

/**
 * Fail-closed guard: throw if any `workspace:` range remains in a manifest that
 * is about to be packed/published. Prevents shipping a broken `workspace:*`.
 */
export function assertNoWorkspaceRanges(manifest: ManifestLike, packageName: string): void {
    for (const field of DEP_FIELDS) {
        const deps = manifest[field];
        if (!deps) continue;
        for (const [name, range] of Object.entries(deps)) {
            if (isWorkspaceRange(range)) {
                throw new Error(
                    `${packageName}: unresolved workspace range "${name}": "${range}" — refusing to publish a broken manifest`,
                );
            }
        }
    }
}
