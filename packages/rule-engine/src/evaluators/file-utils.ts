import {
    dirnamePath,
    type FileSystem,
    NodeFileSystem,
    relativePath,
    resolvePath,
    walkDir,
} from '@gobing-ai/ts-runtime';

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
export async function readWorkdirFile(workdir: string, filePath: string, fs = new NodeFileSystem()): Promise<string> {
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
    const fs = options.fs ?? new NodeFileSystem();
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

/** Escape a string for safe literal use inside a `RegExp` source. */
export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Return the value as a `string[]` when every item is a string, otherwise undefined. */
export function stringArray(value: unknown): string[] | undefined {
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

/**
 * Split a leading ripgrep/PCRE-style `(?flags)` inline group off a regex source.
 *
 * Returns the JS-relevant flags found in the group (filtered to `imsu`) and the
 * remaining source with the group removed. When no leading group is present, returns
 * empty flags and the source unchanged. Shared by evaluators that accept inline flags.
 */
export function parseInlineFlags(source: string): { flags: string; rest: string } {
    const match = /^\(\?([a-z]+)\)/.exec(source);
    if (!match) return { flags: '', rest: source };
    const flags = [...(match[1] ?? '')].filter((flag) => 'imsu'.includes(flag)).join('');
    return { flags, rest: source.slice(match[0].length) };
}
