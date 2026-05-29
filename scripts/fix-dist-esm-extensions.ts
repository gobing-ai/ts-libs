import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';

type SpecifierResolver = (specifier: string) => string;

const roots = process.argv.slice(2);

if (roots.length === 0) {
    throw new Error('Usage: bun scripts/fix-dist-esm-extensions.ts <dist-dir> [...dist-dir]');
}

for (const root of roots) {
    await fixDistRoot(resolve(root));
}

async function fixDistRoot(root: string): Promise<void> {
    const files = await walk(root);
    const emittedFiles = new Set(files.map((file) => toPosix(relative(root, file))));

    for (const file of files.filter((path) => path.endsWith('.js'))) {
        const original = await readFile(file, 'utf-8');
        const next = rewriteSpecifiers(original, (specifier) => resolveSpecifier(root, file, specifier, emittedFiles));

        if (next !== original) {
            await writeFile(file, next, 'utf-8');
        }
    }
}

async function walk(root: string): Promise<string[]> {
    const entries = await readdir(root);
    const files: string[] = [];

    for (const entry of entries) {
        const path = join(root, entry);
        const info = await stat(path);
        if (info.isDirectory()) {
            files.push(...(await walk(path)));
        } else if (info.isFile()) {
            files.push(path);
        }
    }

    return files;
}

function rewriteSpecifiers(source: string, resolveSpecifier: SpecifierResolver): string {
    let next = source.replace(/\b(from\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
        return `${prefix}${resolveSpecifier(specifier)}${suffix}`;
    });

    next = next.replace(/\b(import\s*["'])(\.{1,2}\/[^"']+)(["'])/g, (_match, prefix, specifier, suffix) => {
        return `${prefix}${resolveSpecifier(specifier)}${suffix}`;
    });

    return next.replace(/\b(import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["']\s*\))/g, (_match, prefix, specifier, suffix) => {
        return `${prefix}${resolveSpecifier(specifier)}${suffix}`;
    });
}

function resolveSpecifier(root: string, file: string, specifier: string, emittedFiles: Set<string>): string {
    if (hasExtension(specifier)) return specifier;

    const currentDir = dirname(file);
    const target = resolve(currentDir, specifier);
    const targetJs = toPosix(relative(root, `${target}.js`));
    const targetDts = toPosix(relative(root, `${target}.d.ts`));
    const targetIndexJs = toPosix(relative(root, join(target, 'index.js')));
    const targetIndexDts = toPosix(relative(root, join(target, 'index.d.ts')));

    if (emittedFiles.has(targetJs) || emittedFiles.has(targetDts)) {
        return `${specifier}.js`;
    }

    if (emittedFiles.has(targetIndexJs) || emittedFiles.has(targetIndexDts)) {
        return `${specifier.replace(/\/$/, '')}/index.js`;
    }

    return specifier;
}

function hasExtension(specifier: string): boolean {
    const lastSegment = specifier.split('/').at(-1) ?? '';
    return extname(lastSegment) !== '';
}

function toPosix(path: string): string {
    return sep === posix.sep ? path : path.split(sep).join(posix.sep);
}
