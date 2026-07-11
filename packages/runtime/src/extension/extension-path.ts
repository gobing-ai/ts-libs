/**
 * Assert that an extension module path is relative and does not escape its
 * declaring directory via string-level traversal.
 *
 * Extension declarations are data, and a path that is absolute or escapes via `..`
 * is a trust-boundary violation even when extension loading is explicitly allowed.
 * This is a standalone validator (not a schema refinement) so the loader can enforce
 * it at load time, independent of any engine's config schema — defense in depth.
 *
 * This guard is string-level only: it rejects `..` segments and absolute paths in
 * the declaration but does NOT resolve symlinks. A symlink inside `baseDir` that
 * points outside it passes this check. For symlink-safe confinement, supply a
 * `realPath` canonicalizer to `LoadExtensionsOptions` (ADR-022); the loader
 * performs the filesystem-level check when `realPath` is provided.
 *
 * @throws When the path is absolute or contains a `..` traversal segment.
 */
export function assertRelativeExtensionPath(path: string, options: { sourceName?: string } = {}): void {
    const where = options.sourceName !== undefined ? ` declared by "${options.sourceName}"` : '';
    if (/^([/\\]|[A-Za-z]:[/\\])/.test(path)) {
        throw new Error(`extension path "${path}"${where} must be relative (no absolute paths)`);
    }
    if (path.split(/[/\\]/).includes('..')) {
        throw new Error(`extension path "${path}"${where} must not contain ".." traversal`);
    }
}
