import { dirname, relative, resolve } from 'node:path';
import { type FileSystem, NodeFileSystem, walkDir } from '@gobing-ai/ts-runtime';

/** Options for source-file discovery. */
export interface SourceDiscoveryOptions {
    /** Working directory. */
    workdir: string;
    /** Include path fragments or suffixes. */
    include?: string[];
    /** Exclude path fragments. */
    exclude?: string[];
    /** Filesystem adapter. */
    fs?: FileSystem;
}

const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', '.coverage', '.astro', '.wrangler']);

/** Resolve source files for evaluators using conservative path-fragment matching. */
export async function discoverFiles(options: SourceDiscoveryOptions): Promise<string[]> {
    const fs = options.fs ?? new NodeFileSystem();
    const allFiles = await walkDir(options.workdir, fs);
    return allFiles
        .map((path) => relative(options.workdir, path))
        .filter((path) => !path.split('/').some((segment) => DEFAULT_EXCLUDES.has(segment)))
        .filter(
            (path) =>
                matchesAny(path, options.include) &&
                (options.exclude === undefined || !matchesAny(path, options.exclude)),
        );
}

/** Read a file from a workdir-relative path. */
export async function readWorkdirFile(workdir: string, filePath: string, fs = new NodeFileSystem()): Promise<string> {
    return await fs.readFile(resolve(workdir, filePath));
}

/** Ensure a path is workdir-relative for findings. */
export function relativeToWorkdir(workdir: string, path: string): string {
    return relative(workdir, resolve(path));
}

/** Return parent directory for a workdir-relative path. */
export function relativeParent(path: string): string {
    const parent = dirname(path);
    return parent === '.' ? '' : parent;
}

/** Return true when a path matches any supplied fragment or suffix. */
export function matchesAny(path: string, patterns: string[] | undefined): boolean {
    if (patterns === undefined || patterns.length === 0) return true;
    return patterns.some((pattern) => {
        const clean = pattern.replaceAll('\\', '/').replaceAll('**/', '').replaceAll('*', '');
        return clean.length === 0 || path.includes(clean) || path.endsWith(clean);
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
