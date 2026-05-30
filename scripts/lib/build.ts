import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { buildConfig, repoRoot } from '../config';
import type { Spawn } from './command';
import { runCommand } from './command';
import { sortPackagesByDependencyOrder } from './release';
import type { WorkspacePackage } from './workspace';

type SpecifierResolver = (specifier: string) => string;

export async function fixDistRoots(roots: string[]): Promise<void> {
    if (roots.length === 0) {
        throw new Error('Usage: bun scripts/builder.ts fix-dist-esm-extensions <dist-dir> [...dist-dir]');
    }

    for (const root of roots) {
        await fixDistRoot(resolve(root));
    }
}

export async function fixDistRoot(root: string): Promise<void> {
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

export async function walk(root: string): Promise<string[]> {
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

export function rewriteSpecifiers(source: string, resolveSpecifier: SpecifierResolver): string {
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

export function resolveSpecifier(root: string, file: string, specifier: string, emittedFiles: Set<string>): string {
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

export function hasExtension(specifier: string): boolean {
    const lastSegment = specifier.split('/').at(-1) ?? '';
    return extname(lastSegment) !== '';
}

export function toPosix(path: string): string {
    return sep === posix.sep ? path.replace(/\\/g, posix.sep) : path.split(sep).join(posix.sep);
}

export function packageEntryPath(pkg: WorkspacePackage): string {
    return `./${pkg.dir}/dist/index${buildConfig.distEntryExtension}`;
}

export function smokeImport(command: string, args: string[], label: string, spawn?: Spawn): void {
    const result = runCommand(
        command,
        args,
        {
            cwd: repoRoot,
            stdio: 'pipe',
        },
        spawn,
    );

    if (!result.ok) {
        throw new Error(
            `Failed to import built ${label}: ${result.stderr || result.stdout || `exit ${result.status}`}`,
        );
    }
}

export async function runWorkspaceScript(
    packages: WorkspacePackage[],
    scriptName: 'build' | 'typecheck',
    spawn?: Spawn,
): Promise<void> {
    const orderedPackages = await sortPackagesByDependencyOrder(packages);

    for (const pkg of orderedPackages) {
        if (!pkg.scripts?.[scriptName]) {
            throw new Error(`Package ${pkg.name} is missing required "${scriptName}" script in ${pkg.path}`);
        }

        const result = runCommand(
            'bun',
            ['run', '--filter', pkg.name, scriptName],
            {
                cwd: repoRoot,
                stdio: 'inherit',
            },
            spawn,
        );

        if (!result.ok) {
            throw new Error(`Failed to run "${scriptName}" for ${pkg.name}: exit ${result.status}`);
        }
    }
}

export async function buildPackages(packages: WorkspacePackage[], spawn?: Spawn): Promise<void> {
    await runWorkspaceScript(packages, 'build', spawn);
    await smokeDistImports(packages, spawn);
}

export async function typecheckPackages(packages: WorkspacePackage[], spawn?: Spawn): Promise<void> {
    await runWorkspaceScript(packages, 'typecheck', spawn);
}

export async function smokeDistImports(packages: WorkspacePackage[], spawn?: Spawn): Promise<void> {
    const orderedPackages = await sortPackagesByDependencyOrder(packages);
    const packagesByName = new Map(packages.map((pkg) => [pkg.name, pkg]));

    for (const pkg of orderedPackages) {
        const entry = packageEntryPath(pkg);
        smokeImport(
            'bun',
            ['-e', `const p = ${JSON.stringify(entry)}; await import(p)`],
            `package "${pkg.name}" with Bun`,
            spawn,
        );
    }

    for (const name of buildConfig.nodeSmokePackages) {
        const pkg = packagesByName.get(name);
        if (!pkg) throw new Error(`Smoke import package is not in the workspace: ${name}`);
        const entry = packageEntryPath(pkg);
        smokeImport(
            'node',
            ['-e', `const p = ${JSON.stringify(entry)}; import(p)`],
            `package "${name}" with Node`,
            spawn,
        );
    }
}
