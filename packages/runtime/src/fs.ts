import { createWriteStream, mkdirSync } from 'node:fs';
import {
    access,
    appendFile,
    cp,
    mkdir,
    readdir,
    readFile,
    realpath,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

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

export class NodeFileSystem implements FileSystem {
    async readFile(path: string): Promise<string> {
        return await readFile(path, 'utf-8');
    }

    async writeFile(path: string, content: string): Promise<void> {
        await ensureDirForFile(path, this);
        await writeFile(path, content, 'utf-8');
    }

    async appendFile(path: string, content: string): Promise<void> {
        await ensureDirForFile(path, this);
        await appendFile(path, content, 'utf-8');
    }

    async mkdir(path: string): Promise<void> {
        await mkdir(path, { recursive: true });
    }

    async exists(path: string): Promise<boolean> {
        try {
            await access(path);
            return true;
        } catch {
            return false;
        }
    }

    async readDir(path: string): Promise<string[]> {
        return await readdir(path);
    }

    async unlink(path: string): Promise<void> {
        await rm(path, { recursive: true, force: true });
    }

    async stat(path: string): Promise<FileStat | null> {
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
        return await realpath(path);
    }

    async copy(src: string, dest: string): Promise<void> {
        await cp(src, dest, { recursive: true });
    }

    async rename(src: string, dest: string): Promise<void> {
        await rename(src, dest);
    }

    createLogStream(path: string): LogStream {
        mkdirSync(dirname(path), { recursive: true });
        return createWriteStream(path, { flags: 'a' });
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
    await fs.mkdir(dirname(path));
}

export async function atomicWriteFile(path: string, content: string, fs = getFs()): Promise<void> {
    await ensureDirForFile(path, fs);
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
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
        const fullPath = join(path, entry);
        const entryStat = await fs.stat(fullPath);
        if (entryStat?.isDirectory()) {
            result.push(...(await walkDir(fullPath, fs)));
        } else if (entryStat?.isFile()) {
            result.push(fullPath);
        }
    }
    return result;
}

export function getProjectRoot(startDir = process.cwd()): string {
    let current = resolve(startDir);
    for (let i = 0; i < 12; i++) {
        if (Bun.file(join(current, 'bun.lock')).size !== 0 || Bun.file(join(current, 'package.json')).size !== 0) {
            return current;
        }
        const parent = dirname(current);
        if (parent === current) return startDir;
        current = parent;
    }
    return startDir;
}

export function resolveProjectPath(...segments: string[]): string {
    return resolve(getProjectRoot(), ...segments);
}

export function createLogStream(path: string, fs = getFs()): LogStream {
    return fs.createLogStream(path);
}
