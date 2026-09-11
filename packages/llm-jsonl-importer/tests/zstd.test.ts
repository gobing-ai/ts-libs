import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryImportError, zstdDecompress } from '../src';

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'zstd-test-'));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('zstdDecompress (task 0067)', () => {
    test('decompresses a zstd file through the system CLI', async () => {
        const file = join(root, 'session.v3.jsonl.zstd');
        const scratch = join(root, 'plain.jsonl');
        await writeFile(scratch, JSON.stringify({ type: 'session', id: 'x' }));
        const proc = Bun.spawnSync(['zstd', '-q', '-f', '-o', file, scratch]);
        expect(proc.exitCode).toBe(0);
        expect(await zstdDecompress(file)).toBe('{"type":"session","id":"x"}');
    });

    test('corrupt zstd payload fails with the zstd exit-code message naming zstd and the file', async () => {
        const file = join(root, 'garbage.zstd');
        await writeFile(file, 'not-a-zstd-frame');
        await expect(zstdDecompress(file)).rejects.toThrow(HistoryImportError);
        await expect(zstdDecompress(file)).rejects.toThrow(/zstd \(exit \d+\)/);
        await expect(zstdDecompress(file)).rejects.toThrow(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    });

    test('missing zstd executable raises an actionable error naming zstd and the file', async () => {
        const file = join(root, 'nope.zstd');
        await expect(zstdDecompress(file, { PATH: '/nonexistent-zstd-path' })).rejects.toThrow(HistoryImportError);
        await expect(zstdDecompress(file, { PATH: '/nonexistent-zstd-path' })).rejects.toThrow(
            /zstd executable is required on PATH/,
        );
        await expect(zstdDecompress(file, { PATH: '/nonexistent-zstd-path' })).rejects.toThrow(file);
    });
});
