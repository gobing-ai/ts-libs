import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { findProjectRoot } from './file-system-node';
import { dirnamePath, getProcessCwd, joinPath, resolvePath } from './path';

/** Portable file stat interface — mirrors the subset of `node:fs.Stats` used by the runtime. */
export interface FileStat {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
}

/** Write-only append stream for log output. */
export interface LogStream {
    write(chunk: string): void;
    end(): void;
}

/** @deprecated Use {@link import('./file-system').FileSystem} instead — the new interface has union return types and does not require a separate SyncFileSystem. */
export interface FileSystem {
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    appendFile(path: string, content: string): Promise<void>;
    mkdir(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    readDir(path: string): Promise<string[]>;
    unlink(path: string): Promise<void>;
    stat(path: string): Promise<FileStat | null>;
    realpath(path: string): Promise<string>;
    copy(src: string, dest: string): Promise<void>;
    rename(src: string, dest: string): Promise<void>;
    createLogStream(path: string): LogStream;
}

/** @deprecated Use {@link import('./file-system').FileSystem} instead — its union return types make a separate sync interface unnecessary. */
export interface SyncFileSystem {
    readFile(path: string): string;
    writeFile(path: string, content: string): void;
    mkdir(path: string): void;
    exists(path: string): boolean;
    readDir(path: string): string[];
    stat(path: string): FileStat | null;
    unlink(path: string): void;
}

type NodeFsPromises = typeof import('node:fs/promises');
type NodeFs = typeof import('node:fs');

let fsPromisesModule: Promise<NodeFsPromises> | null = null;
let fsModule: Promise<NodeFs> | null = null;

function nodeFsPromises(): Promise<NodeFsPromises> {
    fsPromisesModule ??= import('node:fs/promises');
    return fsPromisesModule;
}

function nodeFs(): Promise<NodeFs> {
    fsModule ??= import('node:fs');
    return fsModule;
}

/** {@link FileSystem} backed by `node:fs/promises`. Lazy-loads the module to avoid top-level import cost. */
/** @deprecated Use createNodeFileSystem() from './file-system-node' instead. */
export class NodeFileSystem implements FileSystem {
    async readFile(path: string): Promise<string> {
        const { readFile } = await nodeFsPromises();
        return await readFile(path, 'utf-8');
    }

    async writeFile(path: string, content: string): Promise<void> {
        const { writeFile } = await nodeFsPromises();
        await ensureDirForFile(path, this);
        await writeFile(path, content, 'utf-8');
    }

    async appendFile(path: string, content: string): Promise<void> {
        const { appendFile } = await nodeFsPromises();
        await ensureDirForFile(path, this);
        await appendFile(path, content, 'utf-8');
    }

    async mkdir(path: string): Promise<void> {
        const { mkdir } = await nodeFsPromises();
        await mkdir(path, { recursive: true });
    }

    async exists(path: string): Promise<boolean> {
        const { access } = await nodeFsPromises();
        try {
            await access(path);
            return true;
        } catch {
            return false;
        }
    }

    async readDir(path: string): Promise<string[]> {
        const { readdir } = await nodeFsPromises();
        return await readdir(path);
    }

    async unlink(path: string): Promise<void> {
        const { rm } = await nodeFsPromises();
        await rm(path, { recursive: true, force: true });
    }

    async stat(path: string): Promise<FileStat | null> {
        const { stat } = await nodeFsPromises();
        try {
            const value = await stat(path);
            return {
                isFile: () => value.isFile(),
                isDirectory: () => value.isDirectory(),
                size: value.size,
                mtimeMs: value.mtimeMs,
            };
        } catch {
            return null;
        }
    }

    async realpath(path: string): Promise<string> {
        const { realpath } = await nodeFsPromises();
        return await realpath(path);
    }

    async copy(src: string, dest: string): Promise<void> {
        const { cp } = await nodeFsPromises();
        await cp(src, dest, { recursive: true });
    }

    async rename(src: string, dest: string): Promise<void> {
        const { rename } = await nodeFsPromises();
        await rename(src, dest);
    }

    createLogStream(path: string): LogStream {
        return new LazyNodeLogStream(path);
    }
}

/** {@link SyncFileSystem} backed by `node:fs` synchronous APIs. */
/** @deprecated Use createNodeFileSystem() from './file-system-node' instead — its FileSystem interface has union return types, eliminating the need for a separate sync implementation. */
export class NodeSyncFileSystem implements SyncFileSystem {
    readFile(path: string): string {
        return readFileSync(path, 'utf-8');
    }

    writeFile(path: string, content: string): void {
        ensureDirForFileSync(path, this);
        writeFileSync(path, content, 'utf-8');
    }

    mkdir(path: string): void {
        mkdirSync(path, { recursive: true });
    }

    exists(path: string): boolean {
        try {
            return this.stat(path) !== null;
        } catch {
            return false;
        }
    }

    readDir(path: string): string[] {
        return readdirSync(path);
    }

    stat(path: string): FileStat | null {
        try {
            const value = statSync(path);
            return {
                isFile: () => value.isFile(),
                isDirectory: () => value.isDirectory(),
                size: value.size,
                mtimeMs: value.mtimeMs,
            };
        } catch {
            return null;
        }
    }

    unlink(path: string): void {
        rmSync(path, { recursive: true, force: true });
    }
}

class LazyNodeLogStream implements LogStream {
    private readonly ready: Promise<{
        write: (chunk: string) => void;
        end: () => void;
    }>;
    private ended = false;
    // Single serialized chain: every write/end is appended here, so the underlying stream observes
    // them in call order regardless of how the resolving microtasks interleave. A per-write `shift()`
    // off a shared buffer (the previous approach) could reorder writes that arrived in the same tick.
    private tail: Promise<unknown>;

    constructor(path: string) {
        this.ready = nodeFs().then(({ createWriteStream, mkdirSync }) => {
            mkdirSync(dirnamePath(path), { recursive: true });
            const stream = createWriteStream(path, { flags: 'a' });
            return {
                write: (chunk: string) => stream.write(chunk),
                end: () => stream.end(),
            };
        });
        this.tail = this.ready;
    }

    write(chunk: string): void {
        if (this.ended) return;
        this.tail = this.tail.then(() => this.ready.then((stream) => stream.write(chunk)));
    }

    end(): void {
        if (this.ended) return;
        this.ended = true;
        this.tail = this.tail.then(() => this.ready.then((stream) => stream.end()));
    }
}

const CLOUDFLARE_FS_ERROR = 'FileSystem is not available on Cloudflare Workers. Use D1, KV, or R2.';

/** {@link FileSystem} stub for Cloudflare Workers — all file operations throw. Use D1, KV, or R2 instead. */
/** @deprecated Use createCfFileSystem() from './file-system-cf' instead. */
export class CloudflareFileSystem implements FileSystem {
    async readFile(path: string): Promise<string> {
        throw unsupportedCloudflareFs('readFile', path);
    }

    async writeFile(path: string, _content: string): Promise<void> {
        throw unsupportedCloudflareFs('writeFile', path);
    }

    async appendFile(path: string, _content: string): Promise<void> {
        throw unsupportedCloudflareFs('appendFile', path);
    }

    async mkdir(_path: string): Promise<void> {
        return;
    }

    async exists(_path: string): Promise<boolean> {
        return false;
    }

    async readDir(path: string): Promise<string[]> {
        throw unsupportedCloudflareFs('readDir', path);
    }

    async unlink(path: string): Promise<void> {
        throw unsupportedCloudflareFs('unlink', path);
    }

    async stat(_path: string): Promise<FileStat | null> {
        return null;
    }

    async realpath(path: string): Promise<string> {
        return resolveProjectPath(path);
    }

    async copy(src: string, _dest: string): Promise<void> {
        throw unsupportedCloudflareFs('copy', src);
    }

    async rename(src: string, _dest: string): Promise<void> {
        throw unsupportedCloudflareFs('rename', src);
    }

    createLogStream(path: string): LogStream {
        throw unsupportedCloudflareFs('createLogStream', path);
    }
}

function unsupportedCloudflareFs(operation: string, path: string): Error {
    return new Error(`CloudflareFileSystem.${operation} failed for "${path}": ${CLOUDFLARE_FS_ERROR}`);
}

let activeFileSystem: FileSystem = new NodeFileSystem();

/** Swaps the active global file system, returning a restore function for the previous instance. */
/** @deprecated Use RuntimeFactory.createFileSystem() or ctx.require('fileSystem') instead. The global swap is replaced by factory-based DI. */
export function setFileSystem(fileSystem: FileSystem): () => void {
    const previous = activeFileSystem;
    activeFileSystem = fileSystem;
    return () => {
        activeFileSystem = previous;
    };
}

/** Returns the currently active global {@link FileSystem} instance. */
/** @deprecated Use RuntimeFactory.createFileSystem() or ctx.require('fileSystem') instead. */
export function getFs(): FileSystem {
    return activeFileSystem;
}

/** Creates parent directories for a file path before writing. */
export async function ensureDirForFile(path: string, fs = getFs()): Promise<void> {
    await fs.mkdir(dirnamePath(path));
}

/** Synchronous variant of {@link ensureDirForFile}. */
/** @deprecated The new createNodeFileSystem() handles parent-directory creation internally. */
export function ensureDirForFileSync(path: string, fs: SyncFileSystem): void {
    fs.mkdir(dirnamePath(path));
}

/** Atomically writes a file by writing to a temp path then renaming, avoiding partial writes on crash. */
export async function atomicWriteFile(path: string, content: string, fs = getFs()): Promise<void> {
    await ensureDirForFile(path, fs);
    const tempPath = `${path}.${getProcessPid()}.${uniqueToken()}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, path);
}

/** Atomically writes a value as JSON with trailing newline. */
export async function atomicWriteJson(path: string, value: unknown, fs = getFs()): Promise<void> {
    await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, fs);
}

/** Reads and parses a JSON file. */
export async function readJsonFile<T = unknown>(path: string, fs = getFs()): Promise<T> {
    return JSON.parse(await fs.readFile(path)) as T;
}

/** Writes a value as JSON with 2-space indentation and trailing newline. */
export async function writeJsonFile(path: string, value: unknown, fs = getFs()): Promise<void> {
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Recursively walks a directory, returning sorted paths to all files, optionally excluding entries by name. */
export async function walkDir(path: string, fs = getFs(), exclude?: Set<string>): Promise<string[]> {
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
 * Walks up from `startDir` looking for a `package.json` or `bun.lock` to locate the project root.
 *
 * @deprecated Use {@link import('./file-system-node').findProjectRoot} (or `createNodeFileSystem().getProjectRoot()`).
 * This delegates to the single shared implementation.
 */
export function getProjectRoot(startDir = getProcessCwd()): string {
    return findProjectRoot(startDir);
}

/** Resolves path segments relative to the project root. */
export function resolveProjectPath(...segments: string[]): string {
    return resolvePath(getProjectRoot(), ...segments);
}

/** Creates a {@link LogStream} at the given path using the active file system. */
export function createLogStream(path: string, fs = getFs()): LogStream {
    return fs.createLogStream(path);
}

function getProcessPid(): number {
    return (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
}

// Two writers to the same path in the same millisecond must not share a temp name, or one clobbers
// the other before rename. randomUUID disambiguates; Date.now keeps names sortable for debugging.
function uniqueToken(): string {
    return `${Date.now()}.${crypto.randomUUID()}`;
}
