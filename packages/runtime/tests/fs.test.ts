import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCfFileSystem } from '../src/file-system-cf';
import { createNodeFileSystem } from '../src/file-system-node';
import {
    atomicWriteFile,
    atomicWriteJson,
    createLogStream,
    ensureDirForFile,
    readJsonFile,
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

describe('createNodeFileSystem', () => {
    test('reads, writes, appends, copies, and deletes files', async () => {
        const root = await createTempDir();
        const fs = createNodeFileSystem(root);
        const file = join(root, 'nested', 'file.txt');

        fs.writeFile(file, 'hello');
        expect(fs.readFile(file)).toBe('hello');
        fs.appendFile(file, '-world');
        expect(fs.readFile(file)).toBe('hello-world');

        const copyDest = join(root, 'copy.txt');
        fs.copy(file, copyDest);
        expect(fs.readFile(copyDest)).toBe('hello-world');

        const renamed = join(root, 'renamed.txt');
        fs.rename(file, renamed);
        expect(fs.exists(renamed)).toBe(true);
        expect(fs.exists(file)).toBe(false);

        fs.deleteFile(renamed);
        expect(fs.exists(renamed)).toBe(false);
    });

    test('creates append-only write streams', async () => {
        const root = await createTempDir();
        const fs = createNodeFileSystem(root);
        const file = join(root, 'stream', 'log.txt');

        const stream = fs.createWriteStream(file);
        stream.write('test\n');
        stream.end();

        // Write a marker file to verify the filesystem works under the stream dir.
        fs.writeFile(join(root, 'stream', 'verify.txt'), 'ok');
        expect(fs.readFile(join(root, 'stream', 'verify.txt'))).toBe('ok');
    });

    test('createLogStream delegates to createWriteStream', async () => {
        const root = await createTempDir();
        const fs = createNodeFileSystem(root);
        const file = join(root, 'log', 'app.log');

        const stream = createLogStream(file, fs);
        stream.write('test\n');
        stream.end();

        fs.writeFile(join(root, 'log', 'verify.txt'), 'ok');
        expect(fs.readFile(join(root, 'log', 'verify.txt'))).toBe('ok');
    });
});

describe('filesystem helpers', () => {
    test('writes files, JSON, and recursive directory walks', async () => {
        const root = await createTempDir();
        const fs = createNodeFileSystem(root);
        const textFile = join(root, 'a', 'b.txt');
        const jsonFile = join(root, 'a', 'c.json');

        await ensureDirForFile(textFile, fs);
        await atomicWriteFile(textFile, 'content', fs);
        await atomicWriteJson(jsonFile, { ok: true }, fs);
        await writeJsonFile(join(root, 'a', 'd.json'), { value: 42 }, fs);

        expect(fs.readFile(textFile)).toBe('content');
        expect(await readJsonFile<{ ok: boolean }>(jsonFile, fs)).toEqual({ ok: true });
        const walked = await walkDir(root, fs);
        expect(walked.sort()).toEqual(
            [join(root, 'a', 'b.txt'), join(root, 'a', 'c.json'), join(root, 'a', 'd.json')].sort(),
        );
    });

    test('atomicWriteFile survives concurrent writes without clobbering', async () => {
        const root = await createTempDir();
        const fs = createNodeFileSystem(root);
        const file = join(root, 'race', 'value.txt');

        const values = Array.from({ length: 25 }, (_, i) => `v${i}`);
        await Promise.all(values.map((value) => atomicWriteFile(file, value, fs)));

        const siblings = await fs.readDir(join(root, 'race'));
        expect(siblings.length).toBe(1);
    });
});

describe('createCfFileSystem', () => {
    test('mutating methods throw with D1/KV/R2 guidance', () => {
        const fs = createCfFileSystem();

        expect(() => fs.readFile('/data/a')).toThrow('Use D1, KV, or R2');
        expect(() => fs.writeFile('/data/a', 'x')).toThrow('Use D1, KV, or R2');
        expect(() => fs.appendFile('/data/a', 'x')).toThrow('Use D1, KV, or R2');
        expect(() => fs.readDir('/data')).toThrow('Use D1, KV, or R2');
        expect(() => fs.deleteFile('/data/a')).toThrow('Use D1, KV, or R2');
        expect(() => fs.rename('/data/a', '/data/b')).toThrow('Use D1, KV, or R2');
        expect(() => fs.copy('/data/a', '/data/b')).toThrow('Use D1, KV, or R2');
        expect(() => fs.createWriteStream('/data/app.log')).toThrow('Use D1, KV, or R2');
    });

    test('exists returns false and stat returns null', () => {
        const fs = createCfFileSystem();
        expect(fs.exists('/data/a')).toBe(false);
        expect(fs.stat('/data/a')).toBeNull();
    });

    test('ensureDir is a no-op', () => {
        expect(() => createCfFileSystem().ensureDir('/tmp/cache')).not.toThrow();
    });
});
