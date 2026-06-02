import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPresetExtensions, loadExtensionsIntoHost } from '../../src/config/extensions';
import { loadPreset, loadPresetRules } from '../../src/config/loader';
import { RuleEngineHost } from '../../src/host/rule-engine-host';

export const extension = {
    name: 'self-test-extension',
    resolveTestPath: (path: string) => path.replace(/\.ts$/, '.test.ts'),
};

async function tempDir(): Promise<string> {
    const dir = join(
        tmpdir(),
        'ts-libs-rule-engine-extensions',
        `ext-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
}

describe('collectPresetExtensions', () => {
    test('resolves module paths relative to the preset directory, grouped by kind', () => {
        const refs = collectPresetExtensions('p', '/presets', {
            evaluators: ['./eval.ts'],
            resolvers: ['res.ts'],
            formatters: ['fmt.ts'],
        });
        expect(refs).toHaveLength(3);
        expect(refs.find((r) => r.kind === 'evaluators')?.absPath).toBe('/presets/eval.ts');
        expect(refs.find((r) => r.kind === 'resolvers')?.absPath).toBe('/presets/res.ts');
    });

    test('returns no refs when extensions is undefined', () => {
        expect(collectPresetExtensions('p', '/presets', undefined)).toEqual([]);
    });
});

describe('loadExtensionsIntoHost', () => {
    test('is a no-op for empty refs', async () => {
        await expect(loadExtensionsIntoHost(new RuleEngineHost(), [])).resolves.toBeUndefined();
    });

    test('throws when extensions are present but not allowed', async () => {
        const refs = collectPresetExtensions('p', '/presets', { evaluators: ['./e.ts'] });
        await expect(loadExtensionsIntoHost(new RuleEngineHost(), refs)).rejects.toThrow('extensions are disabled');
    });

    test('imports and registers a module-exported capability when allowed', async () => {
        const host = new RuleEngineHost();
        const refs = [{ kind: 'resolvers' as const, presetName: 'p', absPath: '/extensions/custom-resolver.ts' }];
        await loadExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            moduleLoader: async () => ({
                default: { name: 'custom', resolveTestPath: (path: string) => path.replace(/\.ts$/, '.test.ts') },
            }),
        });
        expect(host.resolvers.has('custom')).toBe(true);
        expect(host.resolvers.get('custom').resolveTestPath('a.ts')).toBe('a.test.ts');
    });

    test('throws when a module lacks a string name', async () => {
        const refs = [{ kind: 'resolvers' as const, presetName: 'p', absPath: '/extensions/bad.ts' }];
        await expect(
            loadExtensionsIntoHost(new RuleEngineHost(), refs, {
                allowExtensions: true,
                moduleLoader: async () => ({ default: { notName: true } }),
            }),
        ).rejects.toThrow('must export an object with a string "name"');
    });

    test('default module loader imports extension modules', async () => {
        const host = new RuleEngineHost();
        const refs = [{ kind: 'resolvers' as const, presetName: 'p', absPath: import.meta.url }];

        await loadExtensionsIntoHost(host, refs, { allowExtensions: true });

        expect(host.resolvers.has('self-test-extension')).toBe(true);
    });

    test('throws for extension kinds that have no host registry', async () => {
        const refs = [{ kind: 'fixers' as const, presetName: 'p', absPath: '/extensions/fixer.ts' }];
        await expect(
            loadExtensionsIntoHost(new RuleEngineHost(), refs, {
                allowExtensions: true,
                moduleLoader: async () => ({ default: { name: 'custom-fixer' } }),
            }),
        ).rejects.toThrow('fixers extensions are not supported');
    });

    test('warns when an extension overrides an existing capability', async () => {
        const warnings: string[] = [];
        const refs = [{ kind: 'resolvers' as const, presetName: 'p', absPath: '/extensions/resolver.ts' }];
        const host = new RuleEngineHost();
        host.resolvers.register(
            'typescript',
            { name: 'typescript', resolveTestPath: (path: string) => path },
            'builtin',
        );

        await loadExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            logger: { warn: (message) => warnings.push(message) },
            moduleLoader: async () => ({ default: { name: 'typescript', resolveTestPath: (path: string) => path } }),
        });

        expect(warnings[0]).toContain('overrides existing "typescript"');
    });
});

describe('loadPreset extensions', () => {
    test('returns extension refs declared by top-level and nested presets', async () => {
        const dir = await tempDir();
        const root = join(dir, '.spur', 'rules');
        await mkdir(join(root, 'quality'), { recursive: true });
        await writeFile(
            join(root, 'recommended.yaml'),
            [
                'name: recommended',
                'extends:',
                '  - nested',
                'extensions:',
                '  resolvers:',
                '    - ./top-resolver.ts',
            ].join('\n'),
        );
        await writeFile(
            join(root, 'nested.yaml'),
            [
                'name: nested',
                'extends:',
                '  - quality',
                'extensions:',
                '  evaluators:',
                '    - ./nested-evaluator.ts',
            ].join('\n'),
        );
        await writeFile(
            join(root, 'quality', 'rule.yaml'),
            [
                'rules:',
                '  - id: q',
                '    description: q',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );

        const loaded = await loadPreset('recommended', { roots: [root] });

        expect(loaded.rules.map((rule) => rule.id)).toEqual(['q']);
        expect(loaded.extensions.map((ref) => ref.kind)).toEqual(['resolvers', 'evaluators']);
        expect(loaded.extensions.map((ref) => ref.absPath)).toEqual([
            join(root, 'top-resolver.ts'),
            join(root, 'nested-evaluator.ts'),
        ]);
    });

    test('loadPresetRules preserves the existing rules-only API', async () => {
        const dir = await tempDir();
        const root = join(dir, '.spur', 'rules');
        await mkdir(join(root, 'quality'), { recursive: true });
        await writeFile(
            join(root, 'recommended.yaml'),
            ['name: recommended', 'extends:', '  - quality', 'extensions:', '  resolvers:', '    - ./resolver.ts'].join(
                '\n',
            ),
        );
        await writeFile(
            join(root, 'quality', 'rule.yaml'),
            [
                'rules:',
                '  - id: q',
                '    description: q',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );

        const rules = await loadPresetRules('recommended', { roots: [root] });

        expect(rules.map((rule) => rule.id)).toEqual(['q']);
    });
});
