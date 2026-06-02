// Runtime-portable path math. Deliberately avoids `node:path` so the same logic works on
// `cloudflare-workers` (no `node:*`) as on node-bun (ADR-008). POSIX-style separators throughout;
// Windows drive paths (`C:/...`) are normalized and treated as absolute.

export function normalizeSeparators(path: string): string {
    return path.replaceAll('\\', '/');
}

export function isAbsolutePath(path: string): boolean {
    return path.startsWith('/') || /^[A-Za-z]:\//.test(normalizeSeparators(path));
}

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

export function joinPath(...segments: string[]): string {
    const filtered = segments.filter((segment) => segment.length > 0).map(normalizeSeparators);
    if (filtered.length === 0) return '.';
    const absolute = isAbsolutePath(filtered[0] ?? '');
    const joined = filtered.join('/').replace(/\/+/g, '/');
    return absolute ? joined : joined.replace(/^\//, '');
}

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

export function getProcessCwd(): string {
    return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/';
}
