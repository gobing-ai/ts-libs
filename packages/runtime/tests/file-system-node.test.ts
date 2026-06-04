import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeFileSystem, findProjectRoot } from '../src/file-system-node';

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'fs-test-'));
}

describe('createNodeFileSystem', () => {
    // ── getProjectRoot ────────────────────────────────────────────────────

    test('getProjectRoot returns a string', () => {
        const fs = createNodeFileSystem();
        expect(fs.getProjectRoot()).toBeString();
    });

    test('getProjectRoot honours explicit root', () => {
        const dir = tempDir();
        try {
            const fs = createNodeFileSystem(dir);
            expect(fs.getProjectRoot()).toBe(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── resolve ───────────────────────────────────────────────────────────

    test('resolve joins paths relative to project root', () => {
        const fs = createNodeFileSystem();
        const resolved = fs.resolve('package.json');
        expect(resolved).toContain('package.json');
    });

    test('resolve joins multiple segments', () => {
        const dir = tempDir();
        try {
            const fs = createNodeFileSystem(dir);
            const resolved = fs.resolve('a', 'b', 'c.txt');
            expect(resolved).toBe(join(dir, 'a', 'b', 'c.txt'));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── exists ────────────────────────────────────────────────────────────

    test('exists returns true for existing file', () => {
        const dir = tempDir();
        try {
            const file = join(dir, 'f.txt');
            writeFileSync(file, 'x');
            const fs = createNodeFileSystem(dir);
            expect(fs.exists(file)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('exists returns false for missing file', () => {
        const dir = tempDir();
        try {
            const fs = createNodeFileSystem(dir);
            expect(fs.exists(join(dir, 'no-such-file.txt'))).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── readFile / writeFile ──────────────────────────────────────────────

    test('readFile and writeFile', () => {
        const dir = tempDir();
        try {
            const file = join(dir, 'f.txt');
            const fs = createNodeFileSystem(dir);
            fs.writeFile(file, 'hello');
            expect(fs.readFile(file)).toBe('hello');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('writeFile to nested directory creates parent dirs', () => {
        const dir = tempDir();
        try {
            const nested = join(dir, 'deep', 'nested', 'f.txt');
            const fs = createNodeFileSystem(dir);
            fs.writeFile(nested, 'nested-content');
            expect(fs.readFile(nested)).toBe('nested-content');
            expect(fs.exists(nested)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── ensureDir ─────────────────────────────────────────────────────────

    test('ensureDir creates a directory', () => {
        const dir = tempDir();
        try {
            const sub = join(dir, 'subdir');
            const fs = createNodeFileSystem(dir);
            fs.ensureDir(sub);
            expect(existsSync(sub)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('ensureDir creates nested directories', () => {
        const dir = tempDir();
        try {
            const nested = join(dir, 'a', 'b', 'c');
            const fs = createNodeFileSystem(dir);
            fs.ensureDir(nested);
            expect(existsSync(nested)).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── readDir ───────────────────────────────────────────────────────────

    test('readDir lists directory contents', () => {
        const dir = tempDir();
        try {
            writeFileSync(join(dir, 'a.txt'), 'a');
            writeFileSync(join(dir, 'b.txt'), 'b');
            mkdirSync(join(dir, 'sub'));
            const fs = createNodeFileSystem(dir);
            const entries = fs.readDir(dir);
            expect(entries).toBeArray();
            expect(entries).toContain('a.txt');
            expect(entries).toContain('b.txt');
            expect(entries).toContain('sub');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── appendFile ────────────────────────────────────────────────────────

    test('appendFile appends to existing file', () => {
        const dir = tempDir();
        try {
            const file = join(dir, 'f.txt');
            writeFileSync(file, 'first');
            const fs = createNodeFileSystem(dir);
            fs.appendFile(file, '-second');
            expect(fs.readFile(file)).toBe('first-second');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('appendFile creates parent directories when needed', () => {
        const dir = tempDir();
        try {
            const nested = join(dir, 'deep', 'log.txt');
            const fs = createNodeFileSystem(dir);
            fs.appendFile(nested, 'line1\n');
            fs.appendFile(nested, 'line2\n');
            expect(fs.readFile(nested)).toBe('line1\nline2\n');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── deleteFile ────────────────────────────────────────────────────────

    test('deleteFile removes a file', () => {
        const dir = tempDir();
        try {
            const file = join(dir, 'to-delete.txt');
            writeFileSync(file, 'gone');
            const fs = createNodeFileSystem(dir);
            expect(fs.exists(file)).toBe(true);
            fs.deleteFile(file);
            expect(fs.exists(file)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('deleteFile removes a directory recursively', () => {
        const dir = tempDir();
        try {
            const sub = join(dir, 'sub');
            mkdirSync(join(sub, 'inner'), { recursive: true });
            writeFileSync(join(sub, 'inner', 'f.txt'), 'x');
            const fs = createNodeFileSystem(dir);
            expect(fs.exists(sub)).toBe(true);
            fs.deleteFile(sub);
            expect(fs.exists(sub)).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── copy ──────────────────────────────────────────────────────────────

    test('copy copies a file', () => {
        const dir = tempDir();
        try {
            const src = join(dir, 'src.txt');
            const dest = join(dir, 'dest.txt');
            writeFileSync(src, 'copied');
            const fs = createNodeFileSystem(dir);
            fs.copy(src, dest);
            expect(fs.readFile(dest)).toBe('copied');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('copy copies a directory recursively', () => {
        const dir = tempDir();
        try {
            const srcDir = join(dir, 'src');
            mkdirSync(join(srcDir, 'inner'), { recursive: true });
            writeFileSync(join(srcDir, 'inner', 'f.txt'), 'deep');
            writeFileSync(join(srcDir, 'root.txt'), 'shallow');
            const destDir = join(dir, 'dest');
            const fs = createNodeFileSystem(dir);
            fs.copy(srcDir, destDir);
            expect(fs.readFile(join(destDir, 'root.txt'))).toBe('shallow');
            expect(fs.readFile(join(destDir, 'inner', 'f.txt'))).toBe('deep');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── stat ──────────────────────────────────────────────────────────────

    test('stat returns null for missing path', () => {
        const dir = tempDir();
        try {
            const fs = createNodeFileSystem(dir);
            expect(fs.stat(join(dir, 'ghost.txt'))).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('stat returns stats for existing file', () => {
        const dir = tempDir();
        try {
            const file = join(dir, 'stats.txt');
            writeFileSync(file, 'size-check');
            const fs = createNodeFileSystem(dir);
            const s = fs.stat(file) as import('../src/file-system').FileStat;
            expect(s).not.toBeNull();
            expect(s.isFile()).toBe(true);
            expect(s.isDirectory()).toBe(false);
            expect(s.size).toBe(10);
            expect(s.mtimeMs).toBeGreaterThan(0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('stat returns stats for existing directory', () => {
        const dir = tempDir();
        try {
            const sub = join(dir, 'subdir');
            mkdirSync(sub);
            const fs = createNodeFileSystem(dir);
            const s = fs.stat(sub) as import('../src/file-system').FileStat;
            expect(s).not.toBeNull();
            expect(s.isDirectory()).toBe(true);
            expect(s.isFile()).toBe(false);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // ── writeFile creates parent directories ─────────────────────────

    test('writeFile creates parent directories automatically', () => {
        const dir = tempDir();
        try {
            const nested = join(dir, 'deep', 'nested', 'file.txt');
            const fs = createNodeFileSystem(dir);
            fs.writeFile(nested, 'deep-content');
            expect(fs.readFile(nested)).toBe('deep-content');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
// ── findProjectRoot ────────────────────────────────────────────────────────

describe('findProjectRoot', () => {
    test('finds the nearest directory carrying a project marker', () => {
        // Walking up from a test file lands on the nearest dir with a bun.lock or package.json.
        // In this monorepo that is packages/runtime, which carries a package.json.
        const root = findProjectRoot(__dirname);
        const hasMarker = existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'package.json'));
        expect(hasMarker).toBe(true);
    });

    test('returns startDir when no marker is found', () => {
        const dir = tempDir();
        try {
            const root = findProjectRoot(dir);
            expect(root).toBe(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('finds root via package.json when no bun.lock is present', () => {
        // A Node repo may have package.json but no bun.lock — that marker alone must locate the root.
        const dir = tempDir();
        try {
            writeFileSync(join(dir, 'package.json'), '{}');
            const nested = join(dir, 'a', 'b');
            mkdirSync(nested, { recursive: true });
            expect(findProjectRoot(nested)).toBe(dir);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
