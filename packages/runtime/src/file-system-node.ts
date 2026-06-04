/**
 * `node:fs`-backed {@link FileSystem} implementation for Bun/Node.js.
 *
 * This is the production implementation for local development, VPS, and
 * any environment with a real filesystem. Tests should inject a virtual
 * file system.
 *
 * The implementation uses `node:fs` sync APIs by default. Bun polyfills
 * `node:fs` fully, so this works on both runtimes without a Bun-specific
 * variant.
 */

import {
    appendFileSync,
    cpSync,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import type { FileSystem } from './file-system';

/**
 * Create a {@link FileSystem} backed by `node:fs`.
 *
 * @param root - Project root directory (default: walks up from `process.cwd()` looking for `bun.lock` or `package.json`).
 */
export function createNodeFileSystem(root?: string): FileSystem {
    const projectRoot = root ?? findProjectRoot(process.cwd());

    return {
        getProjectRoot: () => projectRoot,

        resolve: (...segments: string[]) => resolvePath(projectRoot, ...segments),

        exists: (path: string) => existsSync(path),

        readFile: (path: string) => readFileSync(path, 'utf-8'),

        writeFile: (path: string, content: string) => {
            ensureParentDir(path);
            writeFileSync(path, content, 'utf-8');
        },

        appendFile: (path: string, content: string) => {
            ensureParentDir(path);
            appendFileSync(path, content, 'utf-8');
        },

        ensureDir: (path: string) => {
            mkdirSync(path, { recursive: true });
        },

        readDir: (path: string) => readdirSync(path),

        deleteFile: (path: string) => {
            rmSync(path, { recursive: true, force: true });
        },

        createWriteStream: (path: string) => {
            ensureParentDir(path);
            return createWriteStream(path, { flags: 'a' });
        },

        copy: (src: string, dest: string) => {
            cpSync(src, dest, { recursive: true });
        },

        stat: (path: string) => {
            try {
                const s = statSync(path);
                return {
                    isFile: () => s.isFile(),
                    isDirectory: () => s.isDirectory(),
                    size: s.size,
                    mtimeMs: s.mtimeMs,
                };
            } catch {
                return null;
            }
        },
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function ensureParentDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
}

/**
 * Find the project root by walking up from `startDir` looking for `bun.lock`.
 *
 * @internal — exported for reuse by config loading.
 */
export function findProjectRoot(startDir: string): string {
    let dir = resolvePath(startDir);
    const root = resolvePath('/');
    while (dir !== root) {
        if (existsSync(resolvePath(dir, 'bun.lock'))) {
            return dir;
        }
        const parent = resolvePath(dir, '..');
        if (parent === dir) break;
        dir = parent;
    }
    // Fallback: return cwd
    return startDir;
}
