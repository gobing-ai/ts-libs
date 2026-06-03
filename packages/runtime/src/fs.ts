import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirnamePath, getProcessCwd, joinPath, resolvePath } from './path';

export interface FileStat {
    isFile(): boolean;
    isDirectory(): boolean;
    size: number;
    mtimeMs: number;
}

export interface LogStream {
    write(chunk: string): void;
    end(): void;
}

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

export function setFileSystem(fileSystem: FileSystem): () => void {
    const previous = activeFileSystem;
    activeFileSystem = fileSystem;
    return () => {
        activeFileSystem = previous;
    };
}

export function getFs(): FileSystem {
    return activeFileSystem;
}

export async function ensureDirForFile(path: string, fs = getFs()): Promise<void> {
    await fs.mkdir(dirnamePath(path));
}

export function ensureDirForFileSync(path: string, fs: SyncFileSystem): void {
    fs.mkdir(dirnamePath(path));
}

export async function atomicWriteFile(path: string, content: string, fs = getFs()): Promise<void> {
    await ensureDirForFile(path, fs);
    const tempPath = `${path}.${getProcessPid()}.${uniqueToken()}.tmp`;
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, path);
}

export async function atomicWriteJson(path: string, value: unknown, fs = getFs()): Promise<void> {
    await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, fs);
}

export async function readJsonFile<T = unknown>(path: string, fs = getFs()): Promise<T> {
    return JSON.parse(await fs.readFile(path)) as T;
}

export async function writeJsonFile(path: string, value: unknown, fs = getFs()): Promise<void> {
    await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function walkDir(path: string, fs = getFs()): Promise<string[]> {
    const entries = (await fs.readDir(path)).sort();
    const result: string[] = [];
    for (const entry of entries) {
        const fullPath = joinPath(path, entry);
        const entryStat = await fs.stat(fullPath);
        if (entryStat?.isDirectory()) {
            result.push(...(await walkDir(fullPath, fs)));
        } else if (entryStat?.isFile()) {
            result.push(fullPath);
        }
    }
    return result;
}

export function getProjectRoot(startDir = getProcessCwd()): string {
    let current = resolvePath(startDir);
    for (let i = 0; i < 12; i++) {
        if (hasBunFile(joinPath(current, 'bun.lock')) || hasBunFile(joinPath(current, 'package.json'))) {
            return current;
        }
        const parent = dirnamePath(current);
        if (parent === current) return startDir;
        current = parent;
    }
    return startDir;
}

export function resolveProjectPath(...segments: string[]): string {
    return resolvePath(getProjectRoot(), ...segments);
}

export function createLogStream(path: string, fs = getFs()): LogStream {
    return fs.createLogStream(path);
}

function hasBunFile(path: string): boolean {
    const bun = (globalThis as { Bun?: { file: (path: string) => { size: number } } }).Bun;
    if (bun === undefined) return false;
    return bun.file(path).size !== 0;
}

function getProcessPid(): number {
    return (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
}

// Two writers to the same path in the same millisecond must not share a temp name, or one clobbers
// the other before rename. randomUUID disambiguates; Date.now keeps names sortable for debugging.
function uniqueToken(): string {
    return `${Date.now()}.${crypto.randomUUID()}`;
}
