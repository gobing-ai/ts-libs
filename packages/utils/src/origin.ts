/**
 * Match an origin against a pattern. Supports exact match, the bare `*` (match-all), and a single
 * `*` wildcard standing for one prefix/suffix gap (e.g. `https://*.example.com`). Patterns with more
 * than one `*` are NOT glob-expanded — they fall back to exact match (so a multi-wildcard pattern
 * matches nothing unless it equals the origin verbatim). Keep CORS patterns to a single wildcard.
 */
export function matchOriginPattern(origin: string, pattern: string): boolean {
    if (pattern === origin) return true;
    if (pattern === '*') return true;

    if (pattern.includes('*')) {
        const parts = pattern.split('*');
        if (parts.length !== 2) {
            // More than one `*`: not supported as a glob — exact-match only (see JSDoc).
            return pattern === origin;
        }
        const [prefix, suffix] = parts;
        if (prefix === undefined || suffix === undefined) return false;
        return origin.startsWith(prefix) && origin.endsWith(suffix) && origin.length >= prefix.length + suffix.length;
    }

    return false;
}

export function isAllowedOrigin(origin: string | undefined | null, allowedOrigins: string[]): boolean {
    if (!origin) return false;
    if (!allowedOrigins || allowedOrigins.length === 0) return false;

    return allowedOrigins.some((pattern) => matchOriginPattern(origin, pattern));
}

export function getValidatedOrigin(
    origin: string | undefined | null,
    allowedOrigins: string[],
    fallback: string,
): string {
    if (origin && isAllowedOrigin(origin, allowedOrigins)) {
        return origin;
    }
    return fallback;
}
