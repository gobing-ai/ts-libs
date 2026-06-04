// Runtime-portable path math. Deliberately avoids `node:path` so the same logic works on
// `cloudflare-workers` (no `node:*`) as on node-bun (ADR-008). POSIX-style separators throughout;
// Windows drive paths (`C:/...`) are normalized and treated as absolute.

/** Replaces Windows backslashes with forward slashes for consistent POSIX-style path handling. */
export function normalizeSeparators(path: string): string {
    return path.replaceAll('\\', '/');
}

/** Platform-specific path segment separator (`'/'` on POSIX, `'\\'` on Windows). */
export const SEP: string =
    (globalThis as { process?: { platform?: string } }).process?.platform === 'win32' ? '\\' : '/';

/** Returns `true` for POSIX absolute paths and Windows drive paths (`C:/…`). */
export function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(normalizeSeparators(path));
}

/** Returns the parent directory of a path. Platform-independent — avoids `node:path`. */
export function dirnamePath(path: string): string {
    const input = normalizeSeparators(path);
    if (/^\/+$/.test(input)) return '/';
    const normalized = input.replace(/\/+$/, '');
    if (normalized === '' || normalized === '/') return normalized || '.';
    const index = normalized.lastIndexOf('/');
    if (index < 0) return '.';
    if (index === 0) return '/';
    return normalized.slice(0, index);
}

/** Return the last segment of a path. Optionally strip a trailing extension. */
export function basenamePath(p: string, ext?: string): string {
    const normalized = normalizeSeparators(p).replace(/\/+$/, '');
    const index = normalized.lastIndexOf('/');
    let base = index < 0 ? normalized : normalized.slice(index + 1);
    if (ext !== undefined && base !== ext && base.endsWith(ext)) {
        base = base.slice(0, -ext.length);
    }
    return base;
}

/** Compute a platform-independent relative path from `from` to `to`. Both paths should be absolute. */
export function relativePath(from: string, to: string): string {
    const fromParts = resolvePath(from).split('/').filter(Boolean);
    const toParts = resolvePath(to).split('/').filter(Boolean);

    // Strip common prefix.
    let i = 0;
    const minLen = Math.min(fromParts.length, toParts.length);
    while (i < minLen && fromParts[i] === toParts[i]) i++;

    const up = fromParts.slice(i).map(() => '..');
    const down = toParts.slice(i);
    const result = [...up, ...down].join('/');
    return result || '.';
}

/** Joins path segments with `/`, normalizing separators and collapsing redundant slashes. */
export function joinPath(...segments: string[]): string {
    const filtered = segments.filter((segment) => segment.length > 0).map(normalizeSeparators);
    if (filtered.length === 0) return '.';
    const absolute = isAbsolutePath(filtered[0] ?? '');
    const joined = filtered.join('/').replace(/\/+/g, '/');
    return absolute ? joined : joined.replace(/^\//, '');
}

/** Resolves a sequence of path segments to an absolute path, collapsing `..` and `.`. */
export function resolvePath(...segments: string[]): string {
    const candidates = segments.length === 0 ? [getProcessCwd()] : segments;
    let resolved = '';
    for (const segment of candidates.map(normalizeSeparators)) {
        if (segment.length === 0) continue;
        resolved = isAbsolutePath(segment) ? segment : joinPath(resolved || getProcessCwd(), segment);
    }
    const parts: string[] = [];
    const absolute = isAbsolutePath(resolved);
    for (const part of resolved.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            parts.pop();
            continue;
        }
        parts.push(part);
    }
    return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
}

/** Returns `process.cwd()` if available, or `/` as fallback (Cloudflare Workers). */
export function getProcessCwd(): string {
    return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/';
}
