import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { matchesAny, parseInlineFlags, relativeParent, scanFiles } from '../../src/evaluators/file-utils';

describe('matchesAny', () => {
    test('returns true when patterns is undefined', () => {
        expect(matchesAny('src/foo.ts', undefined)).toBe(true);
    });

    test('returns true when patterns array is empty', () => {
        expect(matchesAny('src/foo.ts', [])).toBe(true);
    });

    test('matches by suffix', () => {
        expect(matchesAny('src/foo.ts', ['.ts'])).toBe(true);
    });

    test('matches by path fragment', () => {
        expect(matchesAny('src/components/Button.tsx', ['components'])).toBe(true);
    });

    test('returns false when no pattern matches', () => {
        expect(matchesAny('src/foo.ts', ['.tsx', '.js'])).toBe(false);
    });

    test('strips wildcards and matches by cleaned fragment', () => {
        // deep/**/*.ts → deep/.ts; matches path containing 'deep/' and ending with '.ts'
        expect(matchesAny('deep/other.ts', ['.ts'])).toBe(true);
    });

    test('normalizes backslash pattern to forward slash', () => {
        expect(matchesAny('src/foo.ts', ['src\\foo.ts'])).toBe(true);
    });
});

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

describe('parseInlineFlags', () => {
    test('returns empty flags and source unchanged when no leading group', () => {
        expect(parseInlineFlags('foo')).toEqual({ flags: '', rest: 'foo' });
    });

    test('strips a leading (?i) group and yields i', () => {
        expect(parseInlineFlags('(?i)foo')).toEqual({ flags: 'i', rest: 'foo' });
    });

    test('filters group flags to JS-relevant (imsu)', () => {
        expect(parseInlineFlags('(?ims)foo')).toEqual({ flags: 'ims', rest: 'foo' });
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
});
