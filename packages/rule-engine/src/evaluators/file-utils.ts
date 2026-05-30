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
