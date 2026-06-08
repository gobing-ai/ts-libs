/**
 * Assert that an extension module path is relative and does not escape its
 * declaring directory.
 *
 * Extension declarations are data, and a path that is absolute or escapes via `..`
 * is a trust-boundary violation even when extension loading is explicitly allowed.
 * This is a standalone validator (not a schema refinement) so the loader can enforce
 * it at load time, independent of any engine's config schema — defense in depth.
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
