import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

import {
    atomicWriteFile,
    atomicWriteJson,
    CloudflareFileSystem,
    createLogStream,
    ensureDirForFile,
    getFs,
    getProjectRoot,
    NodeFileSystem,
    readJsonFile,
    resolveProjectPath,
    setFileSystem,
    walkDir,
    writeJsonFile,
} from '../src/fs';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ts-runtime-fs-'));
    tempDirs.push(dir);
    return dir;
}

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('NodeFileSystem', () => {
    test('reads, writes, appends, stats, resolves, copies, and unlinks files', async () => {
        const root = await createTempDir();
        const fs = new NodeFileSystem();
        const file = join(root, 'nested', 'file.txt');

        await fs.writeFile(file, 'hello');
        await fs.appendFile(file, ' world');

        expect(await fs.exists(file)).toBe(true);
        expect(await fs.readFile(file)).toBe('hello world');
        expect(await fs.readDir(join(root, 'nested'))).toEqual(['file.txt']);
        expect((await fs.stat(file))?.isFile()).toBe(true);

        const link = join(root, 'link.txt');
        await symlink(file, link);
        expect(await fs.realpath(link)).toBe(await realpath(file));

        const copy = join(root, 'copy.txt');
        await fs.copy(file, copy);
        expect(await fs.readFile(copy)).toBe('hello world');

        const renamed = join(root, 'renamed.txt');
        await fs.rename(file, renamed);
        expect(await fs.exists(renamed)).toBe(true);
        expect(await fs.exists(file)).toBe(false);

        await fs.unlink(renamed);
        expect(await fs.exists(renamed)).toBe(false);
        expect(await fs.stat(renamed)).toBeNull();
    });

    test('creates append-only log streams', async () => {
        const root = await createTempDir();
        const file = join(root, 'logs', 'app.log');

        const stream = createLogStream(file, new NodeFileSystem());
        stream.write('hello\n');
        stream.end();

        await Bun.sleep(10);
        expect(await readFile(file, 'utf-8')).toBe('hello\n');
    });
});

describe('filesystem helpers', () => {
    test('switches the active filesystem and restores it', () => {
        const previous = getFs();
        const replacement = new NodeFileSystem();
        const restore = setFileSystem(replacement);

        expect(getFs()).toBe(replacement);

        restore();
        expect(getFs()).toBe(previous);
    });

    test('writes files, JSON, and recursive directory walks', async () => {
        const root = await createTempDir();
        const fs = new NodeFileSystem();
        const textFile = join(root, 'a', 'b.txt');
        const jsonFile = join(root, 'a', 'c.json');

        await ensureDirForFile(textFile, fs);
        await atomicWriteFile(textFile, 'content', fs);
        await atomicWriteJson(jsonFile, { ok: true }, fs);
        await writeJsonFile(join(root, 'a', 'd.json'), { value: 42 }, fs);

        expect(await fs.readFile(textFile)).toBe('content');
        expect(await readJsonFile<{ ok: boolean }>(jsonFile, fs)).toEqual({ ok: true });
        expect(await walkDir(root, fs)).toEqual([
            join(root, 'a', 'b.txt'),
            join(root, 'a', 'c.json'),
            join(root, 'a', 'd.json'),
        ]);
    });

    test('resolves project paths relative to the detected project root', () => {
        const resolved = resolveProjectPath('packages');
        expect(resolved).toBe(join(getProjectRoot(), 'packages'));
        expect(resolved.endsWith(`${sep}packages`)).toBe(true);
    });

    test('falls back when project root markers are not found', async () => {
        const root = await createTempDir();
        expect(getProjectRoot(root)).toBe(root);
    });
});

describe('CloudflareFileSystem', () => {
    test('fails persistent operations with Cloudflare storage guidance', async () => {
        const fs = new CloudflareFileSystem();

        expect(await fs.exists('/data')).toBe(false);
        await expect(fs.stat('/data')).resolves.toBeNull();
        await expect(fs.mkdir('/data')).resolves.toBeUndefined();
        await expect(fs.readFile('/data/file.txt')).rejects.toThrow('Use D1, KV, or R2');
        await expect(fs.writeFile('/data/file.txt', 'x')).rejects.toThrow('Use D1, KV, or R2');
        await expect(fs.appendFile('/data/file.txt', 'x')).rejects.toThrow('Use D1, KV, or R2');
        await expect(fs.readDir('/data')).rejects.toThrow('Use D1, KV, or R2');
        await expect(fs.unlink('/data/file.txt')).rejects.toThrow('Use D1, KV, or R2');
        await expect(fs.copy('/data/a', '/data/b')).rejects.toThrow('Use D1, KV, or R2');
        await expect(fs.rename('/data/a', '/data/b')).rejects.toThrow('Use D1, KV, or R2');
        await expect(fs.realpath('/data/file.txt')).resolves.toContain('/data/file.txt');
        expect(() => fs.createLogStream('/data/app.log')).toThrow('Use D1, KV, or R2');
    });
});
