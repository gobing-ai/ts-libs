/**
 * File discovery and reading for evaluators — the shared scaffolding behind the
 * line-scanning rules. Owns directory walks, scope filtering, and per-file reads
 * so each evaluator is left with only its own matcher.
 */

import {
    createNodeFileSystem,
    dirnamePath,
    type FileSystem,
    relativePath,
    resolvePath,
    walkDir,
} from '@gobing-ai/ts-runtime';
import { matchesAny, matchesGlob } from './glob-match';

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

/**
 * Directory names pruned from every file walk — heavy or generated trees that no rule
 * should scan. Shared so subprocess-backed evaluators (e.g. `sg`) can forward the same
 * skip-list to the external tool instead of relying on each rule to remember it.
 */
export const DEFAULT_EXCLUDES = new Set(['.git', 'node_modules', 'dist', '.coverage', '.astro', '.wrangler']);

/** Resolve source files for evaluators using conservative path-fragment matching. */
export async function discoverFiles(options: SourceDiscoveryOptions): Promise<string[]> {
    const fs = options.fs ?? createNodeFileSystem();
    const allFiles = await walkDir(options.workdir, fs, DEFAULT_EXCLUDES);
    return allFiles
        .map((path) => relativePath(options.workdir, path))
        .filter((path) => !path.split('/').some((segment) => DEFAULT_EXCLUDES.has(segment)))
        .filter(
            (path) =>
                matchesAny(path, options.include) &&
                (options.exclude === undefined || !matchesAny(path, options.exclude)),
        );
}

/** Read a file from a workdir-relative path. */
export async function readWorkdirFile(workdir: string, filePath: string, fs = createNodeFileSystem()): Promise<string> {
    return await fs.readFile(resolvePath(workdir, filePath));
}

/** A discovered in-scope file paired with its contents. */
export interface ScannedFile {
    /** Workdir-relative path. */
    readonly file: string;
    /** Full file contents. */
    readonly content: string;
}

/** How `scanFiles` matches `include` / `exclude` against discovered paths. */
export type ScanMatchMode = 'loose' | 'glob';

/** Options for {@link scanFiles}. */
export interface ScanFilesOptions {
    /** Working directory to walk. */
    workdir: string;
    /** Include patterns; semantics depend on `matchMode`. Undefined/empty = all files. */
    include?: string[];
    /** Exclude patterns; semantics depend on `matchMode`. */
    exclude?: string[];
    /**
     * Scope matching policy:
     * - `loose` — substring/suffix fragments via {@link matchesAny} (back-compat for
     *   evaluators that historically accepted bare fragments like `.ts` or `src/`).
     * - `glob` — anchored `**`/`*` globs via {@link matchesGlob}.
     *
     * The two are NOT interchangeable: a bare `src/` matches different sets under each.
     * Each evaluator declares the mode that preserves its existing behavior.
     */
    matchMode: ScanMatchMode;
    /** Filesystem adapter. */
    fs?: FileSystem;
}

/**
 * Discover in-scope files and read each once — the shared scaffolding behind the
 * line-scanning evaluators. Owns discovery, scope filtering (per `matchMode`), and
 * reads, so each evaluator is left with only its own matcher.
 *
 * Scope is a parameter, not assumed one-per-rule: callers that scan under several
 * scopes (e.g. import boundaries) pass no `include` here and apply their own globs to
 * the returned paths.
 */
export async function scanFiles(options: ScanFilesOptions): Promise<ScannedFile[]> {
    const fs = options.fs ?? createNodeFileSystem();
    const files =
        options.matchMode === 'loose'
            ? await discoverFiles({ workdir: options.workdir, include: options.include, exclude: options.exclude, fs })
            : await discoverFilesByGlob(options.workdir, options.include, options.exclude, fs);
    const scanned: ScannedFile[] = [];
    for (const file of files) {
        scanned.push({ file, content: await readWorkdirFile(options.workdir, file, fs) });
    }
    return scanned;
}

/** Discover files then filter with anchored globs (strict mode for {@link scanFiles}). */
async function discoverFilesByGlob(
    workdir: string,
    include: string[] | undefined,
    exclude: string[] | undefined,
    fs: FileSystem,
): Promise<string[]> {
    const all = await discoverFiles({ workdir, fs });
    return all
        .filter((file) => include === undefined || include.length === 0 || include.some((g) => matchesGlob(file, g)))
        .filter((file) => exclude === undefined || !exclude.some((g) => matchesGlob(file, g)));
}

/** Ensure a path is workdir-relative for findings. */
export function relativeToWorkdir(workdir: string, path: string): string {
    return relativePath(workdir, resolvePath(path));
}

/** Return parent directory for a workdir-relative path. */
export function relativeParent(path: string): string {
    const parent = dirnamePath(path);
    return parent === '.' ? '' : parent;
}
