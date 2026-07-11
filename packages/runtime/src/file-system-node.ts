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
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
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

        readFileStream: async function* (path: string): AsyncIterable<string> {
            // WHY: large JSONL history files (100MB+) must not be loaded into memory
            // all at once. createReadStream + manual line splitting lets the importer
            // process records incrementally with constant memory.
            const stream = createReadStream(path, { encoding: 'utf-8' });
            let buffer = '';
            for await (const chunk of stream) {
                buffer += chunk;
                const lines = buffer.split(/\r?\n/);
                // Keep the last (possibly partial) line in the buffer.
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    yield line;
                }
            }
            if (buffer.length > 0) yield buffer;
        },

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

        rename: (src: string, dest: string) => {
            renameSync(src, dest);
        },

        copy: (src: string, dest: string) => {
            cpSync(src, dest, { recursive: true });
        },

        createWriteStream: (path: string) => {
            ensureParentDir(path);
            return createWriteStream(path, { flags: 'a' });
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

        realPath: (path: string) => realpathSync(path),
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
 * Find the project root by walking up from `startDir` looking for a `bun.lock`
 * or `package.json` marker. Uses `existsSync`, so it works on both Node and Bun.
 *
 * This is the single project-root discovery implementation; the deprecated
 * {@link import('./fs').getProjectRoot} delegates here.
 *
 * @internal — exported for reuse by config loading.
 */
export function findProjectRoot(startDir: string): string {
    let dir = resolvePath(startDir);
    const root = resolvePath('/');
    while (dir !== root) {
        if (existsSync(resolvePath(dir, 'bun.lock')) || existsSync(resolvePath(dir, 'package.json'))) {
            return dir;
        }
        const parent = resolvePath(dir, '..');
        if (parent === dir) break;
        dir = parent;
    }
    // Fallback: return the directory we started from.
    return startDir;
}
