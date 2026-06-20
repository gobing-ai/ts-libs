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

/** Reads and parses a JSON file. */
export async function readJsonFile<T = unknown>(
    path: string,
    fs: CanonicalFileSystem = createNodeFileSystem(),
): Promise<T> {
    return JSON.parse(await fs.readFile(path)) as T;
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
 */
export async function walkDir(
    path: string,
    fs: CanonicalFileSystem = createNodeFileSystem(),
    exclude?: Set<string>,
): Promise<string[]> {
    const entries = (await fs.readDir(path)).sort();
    const result: string[] = [];
    for (const entry of entries) {
        if (exclude?.has(entry)) continue;
        const fullPath = joinPath(path, entry);
        const entryStat = await fs.stat(fullPath);
        if (entryStat?.isDirectory()) {
            result.push(...(await walkDir(fullPath, fs, exclude)));
        } else if (entryStat?.isFile()) {
            result.push(fullPath);
        }
    }
    return result;
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
