import { describe, expect, test } from 'bun:test';
import type { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildPackages,
    fixDistRoots,
    packageEntryPath,
    resolveSpecifier,
    rewriteSpecifiers,
    runWorkspaceScript,
    smokeDistImports,
    smokeImport,
    toPosix,
    typecheckPackages,
    walk,
} from '../lib/build';
import type { WorkspacePackage } from '../lib/workspace';

function pkg(name: string, dir: string, options: Partial<WorkspacePackage> = {}): WorkspacePackage {
    return {
        path: `${dir}/package.json`,
        dir,
        name,
        version: '0.1.5',
        private: false,
        dependencies: {},
        scripts: {
            build: 'tsc -p tsconfig.build.json',
            typecheck: 'tsc -p tsconfig.json --noEmit',
        },
        ...options,
    };
}

describe('rewriteSpecifiers', () => {
    test('rewrites static and dynamic relative imports', () => {
        const js = '.js';
        const source = [
            "import value from './value';",
            "export { thing } from '../thing';",
            "import './side-effect';",
            "await import('./dynamic');",
        ].join('\n');

        expect(rewriteSpecifiers(source, (specifier) => `${specifier}.js`)).toBe(
            [
                `import value from './value${js}';`,
                `export { thing } from '../thing${js}';`,
                `import './side-effect${js}';`,
                `await import('./dynamic${js}');`,
            ].join('\n'),
        );
    });
});

describe('fixDistRoots', () => {
    test('walks and fixes emitted ESM extensionless imports', async () => {
        const root = await mkdtemp(join(tmpdir(), 'ts-libs-build-'));
        try {
            await writeFile(join(root, 'feature.js'), 'export const value = 1;\n');
            await writeFile(join(root, 'index.js'), "export { value } from './feature';\n");

            expect((await walk(root)).map((path) => path.endsWith('index.js') || path.endsWith('feature.js'))).toEqual([
                true,
                true,
            ]);

            await fixDistRoots([root]);

            expect(await readFile(join(root, 'index.js'), 'utf-8')).toBe(
                `export { value } from './feature${'.js'}';\n`,
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('requires at least one dist root', async () => {
        await expect(fixDistRoots([])).rejects.toThrow('fix-dist-esm-extensions <dist-dir>');
    });
});

describe('resolveSpecifier', () => {
    test('adds .js for emitted module files', () => {
        const emittedFiles = new Set(['feature.js']);

        expect(resolveSpecifier('/repo/dist', '/repo/dist/index.js', './feature', emittedFiles)).toBe('./feature.js');
    });

    test('adds /index.js for emitted directory indexes', () => {
        const emittedFiles = new Set(['feature/index.js']);

        expect(resolveSpecifier('/repo/dist', '/repo/dist/index.js', './feature', emittedFiles)).toBe(
            './feature/index.js',
        );
    });

    test('leaves explicit extensions and unresolved specifiers unchanged', () => {
        const emittedFiles = new Set(['feature.js']);

        expect(resolveSpecifier('/repo/dist', '/repo/dist/index.js', './feature.js', emittedFiles)).toBe(
            './feature.js',
        );
        expect(resolveSpecifier('/repo/dist', '/repo/dist/index.js', './missing', emittedFiles)).toBe('./missing');
    });
});

describe('smokeDistImports', () => {
    test('smoke imports every publishable package with Bun', async () => {
        const calls: Array<{ command: string; args: string[] }> = [];
        const spawn = ((command: string, args: string[]) => {
            calls.push({ command, args });
            return { status: 0, stdout: '', stderr: '' };
        }) as typeof spawnSync;

        await smokeDistImports(
            [
                pkg('@gobing-ai/ts-utils', 'packages/utils'),
                pkg('@gobing-ai/ts-runtime', 'packages/runtime', {
                    dependencies: { '@gobing-ai/ts-utils': 'workspace:*' },
                }),
                pkg('@gobing-ai/ts-db', 'packages/db', { dependencies: { '@gobing-ai/ts-runtime': 'workspace:*' } }),
                pkg('@gobing-ai/ts-infra', 'packages/infra', {
                    dependencies: { '@gobing-ai/ts-db': 'workspace:*' },
                }),
            ],
            spawn,
        );

        expect(calls.map((call) => call.command)).toEqual(['bun', 'bun', 'bun', 'bun']);
        expect(calls[0].args.join(' ')).toContain('./packages/utils/dist/index.js');
        expect(calls[3].args.join(' ')).toContain('./packages/infra/dist/index.js');
    });

    test('reports command output when smoke import fails', () => {
        const spawn = (() => ({ status: 1, stdout: '', stderr: 'module not found' })) as typeof spawnSync;

        expect(() => smokeImport('node', ['-e', 'import("./missing.js")'], 'missing package', spawn)).toThrow(
            'module not found',
        );
    });
});

describe('workspace scripts', () => {
    test('runs publishable packages in dependency order', async () => {
        const calls: Array<{ command: string; args: string[] }> = [];
        const spawn = ((command: string, args: string[]) => {
            calls.push({ command, args });
            return { status: 0, stdout: '', stderr: '' };
        }) as typeof spawnSync;

        await runWorkspaceScript(
            [
                pkg('@gobing-ai/ts-db', 'packages/db', { dependencies: { '@gobing-ai/ts-runtime': 'workspace:*' } }),
                pkg('@gobing-ai/ts-runtime', 'packages/runtime'),
            ],
            'typecheck',
            spawn,
        );

        expect(calls.map((call) => call.args)).toEqual([
            ['run', '--filter', '@gobing-ai/ts-runtime', 'typecheck'],
            ['run', '--filter', '@gobing-ai/ts-db', 'typecheck'],
        ]);
    });

    test('build runs package builds before smoke imports', async () => {
        const calls: string[] = [];
        const spawn = ((command: string, args: string[]) => {
            calls.push(`${command} ${args.join(' ')}`);
            return { status: 0, stdout: '', stderr: '' };
        }) as typeof spawnSync;

        await buildPackages(
            [
                pkg('@gobing-ai/ts-utils', 'packages/utils'),
                pkg('@gobing-ai/ts-runtime', 'packages/runtime', {
                    dependencies: { '@gobing-ai/ts-utils': 'workspace:*' },
                }),
            ],
            spawn,
        );

        expect(calls).toEqual([
            'bun run --filter @gobing-ai/ts-utils build',
            'bun run --filter @gobing-ai/ts-runtime build',
            'bun -e const p = "./packages/utils/dist/index.js"; await import(p)',
            'bun -e const p = "./packages/runtime/dist/index.js"; await import(p)',
        ]);
    });

    test('typecheck delegates to the workspace script runner', async () => {
        const calls: string[] = [];
        const spawn = ((command: string, args: string[]) => {
            calls.push(`${command} ${args.join(' ')}`);
            return { status: 0, stdout: '', stderr: '' };
        }) as typeof spawnSync;

        await typecheckPackages([pkg('@gobing-ai/ts-utils', 'packages/utils')], spawn);

        expect(calls).toEqual(['bun run --filter @gobing-ai/ts-utils typecheck']);
    });

    test('fails when a publishable package is missing a required script', async () => {
        await expect(
            runWorkspaceScript([pkg('@gobing-ai/ts-utils', 'packages/utils', { scripts: {} })], 'build'),
        ).rejects.toThrow('missing required "build" script');
    });

    test('reports package script failures with package context', async () => {
        const spawn = (() => ({ status: 1, stdout: '', stderr: '' })) as typeof spawnSync;

        await expect(
            runWorkspaceScript([pkg('@gobing-ai/ts-utils', 'packages/utils')], 'build', spawn),
        ).rejects.toThrow('Failed to run "build" for @gobing-ai/ts-utils');
    });
});

describe('path helpers', () => {
    test('returns package dist entry paths', () => {
        expect(packageEntryPath(pkg('@gobing-ai/ts-utils', 'packages/utils'))).toBe('./packages/utils/dist/index.js');
    });

    test('normalizes platform separators to posix', () => {
        expect(toPosix('a\\b\\c')).toBe('a/b/c');
    });
});
