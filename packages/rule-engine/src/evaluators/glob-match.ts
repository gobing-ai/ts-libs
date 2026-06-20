/**
 * Path-pattern matching for evaluators — two deliberately distinct algorithms.
 *
 * {@link matchesAny} is the loose, back-compatible fragment/suffix matcher;
 * {@link matchesGlob} is the strict, anchored segment-aware glob matcher. They
 * are NOT interchangeable (a bare `src/` matches different sets under each), so
 * each evaluator picks the one that preserves its existing behavior.
 */

/**
 * Return true when a path matches any supplied pattern.
 *
 * Each pattern is matched in two passes, most-specific first:
 *  1. If it contains a glob metachar (`*`), try anchored {@link matchesGlob} —
 *     so `packages/**\/*.ts` resolves segment-by-segment instead of collapsing
 *     to a bare fragment (the latter silently matched nothing, leaving every
 *     glob-scoped loose-mode rule scanning zero files).
 *  2. Otherwise (or if the glob did not match), fall back to the legacy
 *     fragment/suffix substring test, where stars are stripped — preserving
 *     bare fragments like `.ts`, `src/`, `/tests/` that loose-mode evaluators
 *     have always accepted, and keeping unanchored patterns like `*.ts`
 *     (→ suffix `.ts`) matching nested paths.
 */
export function matchesAny(path: string, patterns: string[] | undefined): boolean {
    if (patterns === undefined || patterns.length === 0) return true;
    const normalizedPath = path.replaceAll('\\', '/');
    return patterns.some((pattern) => {
        const normalized = pattern.replaceAll('\\', '/');
        if (normalized.includes('*') && matchesGlob(normalizedPath, normalized)) return true;
        const clean = normalized.replaceAll('**/', '').replaceAll('*', '');
        return clean.length === 0 || normalizedPath.includes(clean) || normalizedPath.endsWith(clean);
    });
}

/**
 * Segment-aware glob matching with `**` (any depth) and `*` (single segment).
 *
 * Stricter than {@link matchesAny}: it anchors the whole path, so `apps/**` does
 * not match `vendor/apps/x`. Used by evaluators that enforce path policies
 * (coverage scoping, test-file location) where a loose match would change findings.
 */
export function matchesGlob(path: string, pattern: string): boolean {
    const normalized = path.replaceAll('\\', '/');
    if (pattern.startsWith('**/')) {
        const suffix = pattern.slice(3);
        if (suffix.indexOf('*') === -1) {
            return normalized.endsWith(suffix) || normalized.endsWith(`/${suffix}`);
        }
    }
    if (pattern === normalized) return true;
    return matchSegments(normalized.split('/'), pattern.split('/'), 0, 0);
}

/** Recursive segment-level glob matcher backing {@link matchesGlob}. */
function matchSegments(file: string[], pattern: string[], fi: number, pi: number): boolean {
    if (pi >= pattern.length) return fi >= file.length;
    if (fi >= file.length) return pattern.slice(pi).every((segment) => segment === '**');
    const pat = pattern[pi] ?? '';
    if (pat === '**') {
        return matchSegments(file, pattern, fi, pi + 1) || matchSegments(file, pattern, fi + 1, pi);
    }
    if (!matchSegment(file[fi] ?? '', pat)) return false;
    return matchSegments(file, pattern, fi + 1, pi + 1);
}

/** Match one path segment against a pattern segment where `*` matches any run of non-`/` chars. */
function matchSegment(segment: string, pattern: string): boolean {
    if (pattern.indexOf('*') === -1) return segment === pattern;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*');
    return new RegExp(`^${escaped}$`).test(segment);
}

/** Escape a string for safe literal use inside a `RegExp` source. */
export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
