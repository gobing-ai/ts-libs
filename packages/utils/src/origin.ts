export function matchOriginPattern(origin: string, pattern: string): boolean {
    if (pattern === origin) return true;
    if (pattern === '*') return true;

    if (pattern.includes('*')) {
        const parts = pattern.split('*');
        if (parts.length !== 2) {
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
