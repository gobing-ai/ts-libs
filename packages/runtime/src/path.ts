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

function splitRoot(path: string): { root: string; rest: string } {
    const normalized = normalizeSeparators(path);
    const drive = normalized.match(/^([A-Za-z]:)(?:\/|$)/);
    if (drive) {
        return { root: drive[1] ?? '', rest: normalized.slice((drive[1] ?? '').length).replace(/^\/+/, '') };
    }
    if (normalized.startsWith('/')) {
        return { root: '/', rest: normalized.replace(/^\/+/, '') };
    }
    return { root: '', rest: normalized };
}

function pathParts(path: string): { root: string; parts: string[] } {
    const { root, rest } = splitRoot(path);
    return { root, parts: rest.split('/').filter(Boolean) };
}

/** Returns the parent directory of a path. Platform-independent — avoids `node:path`. */
export function dirnamePath(path: string): string {
    const input = normalizeSeparators(path);
    const { root } = splitRoot(input);
    if (root !== '' && input.replace(/\/+$/, '') === root) return root === '/' ? '/' : `${root}/`;
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

/** Convert a file:// URL into the portable path format used by this package. */
export function fileUrlToPath(url: string): string {
    const parsed = new URL(url);
    if (parsed.protocol !== 'file:') {
        throw new Error(`Expected file URL, got "${parsed.protocol}"`);
    }

    // Encoded separators would decode into extra path segments (e.g. "%2F..%2F"
    // becoming "/../"), silently changing path semantics — reject like node:url does.
    if (/%2f|%5c/i.test(parsed.pathname)) {
        throw new Error('File URL path must not include encoded "/" or "\\" characters');
    }

    const pathname = decodeURIComponent(parsed.pathname);
    const localPath = /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    if (parsed.hostname.length > 0 && parsed.hostname !== 'localhost') {
        return normalizeSeparators(`//${parsed.hostname}${localPath}`);
    }
    return normalizeSeparators(localPath);
}

/** Compute a platform-independent relative path from `from` to `to`. Both paths should be absolute. */
export function relativePath(from: string, to: string): string {
    const fromParsed = pathParts(resolvePath(from));
    const toParsed = pathParts(resolvePath(to));
    if (fromParsed.root.toLowerCase() !== toParsed.root.toLowerCase()) {
        return resolvePath(to);
    }
    const fromParts = fromParsed.parts;
    const toParts = toParsed.parts;

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
    const { root, rest } = splitRoot(resolved);
    const parts: string[] = [];
    const absolute = root !== '';
    for (const part of rest.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
            if (parts.length > 0) parts.pop();
            continue;
        }
        parts.push(part);
    }
    if (!absolute) return parts.join('/') || '.';
    if (root === '/') return `/${parts.join('/')}` || '/';
    return parts.length > 0 ? `${root}/${parts.join('/')}` : `${root}/`;
}

/** Returns `process.cwd()` if available, or `/` as fallback (Cloudflare Workers). */
export function getProcessCwd(): string {
    return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/';
}
