import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectExtensions, loadExtensionsIntoHost } from '../../src/config/extensions';
import { loadPreset, loadPresetRules, loadRuleFile } from '../../src/config/loader';
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

describe('collectExtensions', () => {
    test('resolves module paths relative to the preset directory, grouped by kind', () => {
        const refs = collectExtensions('p', '/presets', {
            evaluators: ['./eval.ts'],
            resolvers: ['res.ts'],
            formatters: ['fmt.ts'],
        });
        expect(refs).toHaveLength(3);
        expect(refs.find((r) => r.kind === 'evaluators')?.absPath).toBe('/presets/eval.ts');
        expect(refs.find((r) => r.kind === 'resolvers')?.absPath).toBe('/presets/res.ts');
    });

    test('returns no refs when extensions is undefined', () => {
        expect(collectExtensions('p', '/presets', undefined)).toEqual([]);
    });
});

describe('loadExtensionsIntoHost', () => {
    test('is a no-op for empty refs', async () => {
        await expect(loadExtensionsIntoHost(new RuleEngineHost(), [])).resolves.toBeUndefined();
    });

    test('throws when extensions are present but not allowed', async () => {
        const refs = collectExtensions('p', '/presets', { evaluators: ['./e.ts'] });
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

    test('loads fixer extensions into host.fixers registry', async () => {
        const refs = [{ kind: 'fixers' as const, presetName: 'p', absPath: '/extensions/fixer.ts' }];
        const host = new RuleEngineHost();
        const fakeProvider = {
            name: 'custom-fixer',
            createFixes: async () => [],
        };

        await loadExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            moduleLoader: async () => ({ default: fakeProvider }),
        });

        expect(host.fixers.has('custom-fixer')).toBe(true);
        expect(host.fixers.get('custom-fixer')).toBe(fakeProvider);
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

    test('throws for fixer refs when allowExtensions is false', async () => {
        const refs = [{ kind: 'fixers' as const, presetName: 'p', absPath: '/extensions/fixer.ts' }];
        await expect(
            loadExtensionsIntoHost(new RuleEngineHost(), refs, {
                allowExtensions: false,
                moduleLoader: async () => ({ default: { name: 'custom-fixer', createFixes: async () => [] } }),
            }),
        ).rejects.toThrow();
    });

    test('warns when a fixer extension overrides a builtin', async () => {
        const warnings: string[] = [];
        const refs = [{ kind: 'fixers' as const, presetName: 'p', absPath: '/extensions/fixer.ts' }];
        const host = new RuleEngineHost();
        // Simulate a builtin fixer registration (as registerBuiltinFixers does)
        host.fixers.register('regex', { createFixes: async () => [] }, 'builtin');

        await loadExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            logger: { warn: (message) => warnings.push(message) },
            moduleLoader: async () => ({ default: { name: 'regex', createFixes: async () => [] } }),
        });

        expect(warnings[0]).toContain('overrides existing "regex"');
        // Extension replaced the builtin
        const entry = host.fixers.getEntry('regex');
        expect(entry?.origin).toBe('extension');
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

describe('loadRuleFile extensions', () => {
    test('collects extension refs declared by a rule file, resolved to absolute paths', async () => {
        const dir = await tempDir();
        const file = join(dir, 'rules.yaml');
        await writeFile(
            file,
            [
                'extensions:',
                '  evaluators:',
                '    - ./custom-evaluator.ts',
                'rules:',
                '  - id: r',
                '    description: r',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );

        const loaded = await loadRuleFile(file);

        // A rule file now behaves like a preset: rules + extensions, identical shape.
        expect(loaded.rules.map((rule) => rule.id)).toEqual(['r']);
        expect(loaded.extensions.map((ref) => ref.kind)).toEqual(['evaluators']);
        expect(loaded.extensions[0]?.absPath).toBe(join(dir, 'custom-evaluator.ts'));
    });

    test('rule-file extensions flow through the same allowExtensions trust gate', async () => {
        const dir = await tempDir();
        const file = join(dir, 'rules.yaml');
        await writeFile(
            file,
            [
                'extensions:',
                '  resolvers:',
                '    - ./res.ts',
                'rules:',
                '  - id: r',
                '    description: r',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );

        const { extensions } = await loadRuleFile(file);
        // allowExtensions defaults to false: a rule file must not be able to load code
        // any more freely than a preset can.
        await expect(loadExtensionsIntoHost(new RuleEngineHost(), extensions)).rejects.toThrow(
            'extensions are disabled',
        );
    });

    test('rejects a rule-file extension path that traverses out of the directory', async () => {
        const dir = await tempDir();
        const file = join(dir, 'rules.yaml');
        await writeFile(
            file,
            [
                'extensions:',
                '  evaluators:',
                '    - ../escape.ts',
                'rules:',
                '  - id: r',
                '    description: r',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );

        await expect(loadRuleFile(file)).rejects.toThrow('".." traversal');
    });

    test('rejects an unknown key inside a rule-file extensions block (strict)', async () => {
        const dir = await tempDir();
        const file = join(dir, 'rules.yaml');
        await writeFile(
            file,
            [
                'extensions:',
                '  plugins:', // not a valid extension kind
                '    - ./x.ts',
                'rules:',
                '  - id: r',
                '    description: r',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );

        await expect(loadRuleFile(file)).rejects.toThrow();
    });

    test('a single-rule file (no rules: array) declares no extensions', async () => {
        const dir = await tempDir();
        const file = join(dir, 'rule.yaml');
        await writeFile(
            file,
            ['id: solo', 'description: solo', 'evaluator: { type: path, config: { paths: ["README.md"] } }'].join('\n'),
        );

        const loaded = await loadRuleFile(file);

        expect(loaded.rules.map((rule) => rule.id)).toEqual(['solo']);
        expect(loaded.extensions).toEqual([]);
    });
});
