import { describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relativeParent, scanFiles } from '../../src/evaluators/file-discovery';

describe('relativeParent', () => {
    test('returns empty string for root path', () => {
        expect(relativeParent('file.txt')).toBe('');
    });

    test('returns parent directory for nested path', () => {
        expect(relativeParent('src/file.txt')).toBe('src');
    });

    test('handles deeply nested path', () => {
        expect(relativeParent('a/b/c/file.txt')).toBe('a/b/c');
    });
});

describe('scanFiles', () => {
    async function tempDir(): Promise<string> {
        const dir = join(
            tmpdir(),
            'ts-libs-rule-engine-scanFiles',
            `sf-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        );
        await mkdir(join(dir, 'src'), { recursive: true });
        await mkdir(join(dir, 'vendor'), { recursive: true });
        await writeFile(join(dir, 'src', 'app.ts'), 'export const x = 1;');
        await writeFile(join(dir, 'src', 'doc.md'), '# title');
        await writeFile(join(dir, 'vendor', 'lib.js'), 'const y = 2;');
        return dir;
    }

    test('loose mode: include accepts bare fragments, matches substrings or suffix', async () => {
        const dir = await tempDir();
        const scanned = await scanFiles({
            workdir: dir,
            include: ['.ts'],
            matchMode: 'loose',
        });
        const files = scanned.map((s) => s.file).sort();
        // Loose `.ts` matches any path that contains or ends with `.ts`.
        expect(files).toContain('src/app.ts');
        expect(files).not.toContain('src/doc.md');
        expect(files).not.toContain('vendor/lib.js');
    });

    test('glob mode: include is anchored, not loose-substring', async () => {
        const dir = await tempDir();
        const scanned = await scanFiles({
            workdir: dir,
            include: ['src/**'],
            exclude: ['src/doc.*'],
            matchMode: 'glob',
        });
        const files = scanned.map((s) => s.file).sort();
        expect(files).toEqual(['src/app.ts']);
    });

    test('returns file content paired with each in-scope path', async () => {
        const dir = await tempDir();
        const scanned = await scanFiles({
            workdir: dir,
            include: ['src/app.ts'],
            matchMode: 'glob',
        });
        expect(scanned).toHaveLength(1);
        expect(scanned[0]?.file).toBe('src/app.ts');
        expect(scanned[0]?.content).toBe('export const x = 1;');
    });

    test('no include + no exclude yields all non-excluded files', async () => {
        const dir = await tempDir();
        const scanned = await scanFiles({ workdir: dir, matchMode: 'glob' });
        const files = scanned.map((s) => s.file).sort();
        expect(files).toEqual(['src/app.ts', 'src/doc.md', 'vendor/lib.js']);
    });

    test('skips files larger than the documented size cap without buffering them (0060 R15)', async () => {
        const dir = join(tmpdir(), `ts-libs-scanfiles-cap-${Date.now()}`);
        await mkdir(dir, { recursive: true });
        try {
            await writeFile(join(dir, 'small.ts'), 'export const ok = 1;');
            // > 2 MiB — must be skipped, not loaded into memory.
            await writeFile(join(dir, 'huge.ts'), 'x'.repeat(2_000_001));

            const scanned = await scanFiles({ workdir: dir, include: ['.ts'], matchMode: 'loose' });
            const files = scanned.map((s) => s.file).sort();
            expect(files).toEqual(['small.ts']);
            expect(scanned[0]?.content).toBe('export const ok = 1;');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
