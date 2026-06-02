import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPresetExtensions, loadExtensionsIntoHost } from '../../src/config/extensions';
import { RuleEngineHost } from '../../src/host/rule-engine-host';

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
        const dir = await tempDir();
        const modulePath = join(dir, 'custom-resolver.ts');
        await writeFile(
            modulePath,
            'export default { name: "custom", resolveTestPath: (p) => p.replace(/\\.ts$/, ".test.ts") };\n',
        );
        const host = new RuleEngineHost();
        const refs = collectPresetExtensions('p', dir, { resolvers: ['custom-resolver.ts'] });
        await loadExtensionsIntoHost(host, refs, { allowExtensions: true });
        expect(host.resolvers.has('custom')).toBe(true);
        expect(host.resolvers.get('custom').resolveTestPath('a.ts')).toBe('a.test.ts');
    });

    test('throws when a module lacks a string name', async () => {
        const dir = await tempDir();
        const modulePath = join(dir, 'bad.ts');
        await writeFile(modulePath, 'export default { notName: true };\n');
        const refs = collectPresetExtensions('p', dir, { resolvers: ['bad.ts'] });
        await expect(loadExtensionsIntoHost(new RuleEngineHost(), refs, { allowExtensions: true })).rejects.toThrow(
            'must export an object with a string "name"',
        );
    });
});
