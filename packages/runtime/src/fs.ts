import type { FileSystem as CanonicalFileSystem } from './file-system';
import { createNodeFileSystem } from './file-system-node';
import { dirnamePath, joinPath } from './path';
/** Creates parent directories for a file path before writing. */
export async function ensureDirForFile(path: string, fs: CanonicalFileSystem = createNodeFileSystem()): Promise<void> {
    await fs.ensureDir(dirnamePath(path));
}

/** Atomically writes a file by writing to a temp path then renaming, avoiding partial writes on crash. */
export async function atomicWriteFile(
    path: string,
    content: string,
    fs: CanonicalFileSystem = createNodeFileSystem(),
): Promise<void> {
    await ensureDirForFile(path, fs);
    const tempPath = `${path}.${getProcessPid()}.${uniqueToken()}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, path);
}

/** Atomically writes a value as JSON with trailing newline. */
export async function atomicWriteJson(
    path: string,
    value: unknown,
    fs: CanonicalFileSystem = createNodeFileSystem(),
): Promise<void> {
    await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, fs);
}

/** Reads and parses a JSON file. Throws with the file named when the content is not valid JSON. */
export async function readJsonFile<T = unknown>(
    path: string,
    fs: CanonicalFileSystem = createNodeFileSystem(),
): Promise<T> {
    const content = await fs.readFile(path);
    try {
        return JSON.parse(content) as T;
    } catch (error) {
        throw new Error(`Failed to parse JSON file "${path}": ${(error as Error).message}`);
    }
}

/** Writes a value as JSON with 2-space indentation and trailing newline. */
export async function writeJsonFile(
    path: string,
    value: unknown,
    fs: CanonicalFileSystem = createNodeFileSystem(),
): Promise<void> {
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Recursively walks a directory, returning sorted paths to all files,
 * optionally excluding entries by name.
 *
 * Cycle-safe and root-confined (task 0060 F3): directory symlinks are tracked
 * by their canonical real path, so a link back to an ancestor (or the start
 * root itself) is walked once at most, and a link escaping the start root is
 * skipped. In-root directory symlinks are still traversed — importer and
 * rule-engine walk `$HOME/...` trees that are often symlinks into a dotfiles
 * repo. When the filesystem has no `realPath` (in-memory / CF stubs), today's
 * follow-`stat` behaviour is kept (no ambient capability).
 */
export async function walkDir(
    path: string,
    fs: CanonicalFileSystem = createNodeFileSystem(),
    exclude?: Set<string>,
): Promise<string[]> {
    const startReal = fs.realPath?.(path) ?? path;
    const visited = new Set<string>([startReal]);
    const result: string[] = [];
    await walkDirInto(path, fs, exclude, startReal, visited, result);
    return result;
}

async function walkDirInto(
    path: string,
    fs: CanonicalFileSystem,
    exclude: Set<string> | undefined,
    startReal: string,
    visited: Set<string>,
    result: string[],
): Promise<void> {
    const entries = (await fs.readDir(path)).sort();
    for (const entry of entries) {
        if (exclude?.has(entry)) continue;
        const fullPath = joinPath(path, entry);
        const entryStat = await fs.stat(fullPath);
        if (entryStat?.isDirectory()) {
            const entryReal = fs.realPath?.(fullPath) ?? fullPath;
            if (visited.has(entryReal)) continue; // cycle or already-walked real dir
            if (
                fs.realPath !== undefined &&
                entryReal !== startReal &&
                !entryReal.startsWith(`${startReal}/`) &&
                !entryReal.startsWith(`${startReal}\\`)
            ) {
                continue; // symlink escapes the start root
            }
            visited.add(entryReal);
            await walkDirInto(fullPath, fs, exclude, startReal, visited, result);
        } else if (entryStat?.isFile()) {
            result.push(fullPath);
        }
    }
}

/**
 * Creates a writable stream for append-only output at the given path.
 */
export function createLogStream(
    path: string,
    fs: CanonicalFileSystem = createNodeFileSystem(),
): { write(chunk: string): void; end(): void } {
    return fs.createWriteStream(path);
}

function getProcessPid(): number {
    return (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
}

function uniqueToken(): string {
    return `${Date.now()}.${crypto.randomUUID()}`;
}
