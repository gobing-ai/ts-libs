import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPresetRules, loadRuleFile } from '../../src/config/loader';

describe('loadPresetRules', () => {
    test('returns empty array when preset not found', async () => {
        const rules = await loadPresetRules('nonexistent', {
            roots: [join(`/tmp/does-not-exist-${Date.now()}`, 'rules')],
        });
        expect(rules).toEqual([]);
    });

    test('returns empty array when no roots are supplied', async () => {
        expect(await loadPresetRules('anything', { roots: [] })).toEqual([]);
    });

    test('applies overrides declared by nested presets', async () => {
        const root = await mkdtemp(join(tmpdir(), 'preset-nested-override-'));
        await writeFile(
            join(root, 'child.yaml'),
            [
                'name: child',
                'extends:',
                '  - quality',
                'overrides:',
                '  needs-test:',
                '    fix:',
                '      mode: suggest',
                '',
            ].join('\n'),
        );
        await writeFile(join(root, 'parent.yaml'), ['name: parent', 'extends:', '  - child', ''].join('\n'));
        await writeFile(
            join(root, 'quality.yaml'),
            [
                'rules:',
                '  - id: needs-test',
                '    evaluator:',
                '      type: test-location',
                '    fix:',
                '      mode: auto',
                '',
            ].join('\n'),
        );

        const rules = await loadPresetRules('parent', { roots: [root] });

        expect(rules).toHaveLength(1);
        expect(rules[0]?.fix?.mode).toBe('suggest');
    });

    test('rejects fix authority promotion declared by nested presets', async () => {
        const root = await mkdtemp(join(tmpdir(), 'preset-nested-promotion-'));
        await writeFile(
            join(root, 'child.yaml'),
            [
                'name: child',
                'extends:',
                '  - quality',
                'overrides:',
                '  needs-test:',
                '    fix:',
                '      mode: auto',
                '',
            ].join('\n'),
        );
        await writeFile(join(root, 'parent.yaml'), ['name: parent', 'extends:', '  - child', ''].join('\n'));
        await writeFile(
            join(root, 'quality.yaml'),
            [
                'rules:',
                '  - id: needs-test',
                '    evaluator:',
                '      type: test-location',
                '    fix:',
                '      mode: suggest',
                '',
            ].join('\n'),
        );

        await expect(loadPresetRules('parent', { roots: [root] })).rejects.toThrow(
            'raises fix mode from "suggest" to "auto"',
        );
    });
});

describe('loadRuleFile', () => {
    test('throws for nonexistent file', async () => {
        await expect(loadRuleFile(`/tmp/nonexistent-file-${Date.now()}.yaml`)).rejects.toThrow();
    });

    test('invalid file error names the file and the offending field path', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'rule-bad-'));
        const file = join(dir, 'broken.yaml');
        // A rule missing the required `evaluator` key — the error should point at it.
        await writeFile(file, 'rules:\n  - id: r\n    description: d\n');
        await expect(loadRuleFile(file)).rejects.toThrow('broken.yaml');
        await expect(loadRuleFile(file)).rejects.toThrow(/evaluator/);
    });

    test('honors $schema validation by default', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'rule-schema-'));
        await writeFile(
            join(dir, 'rule-file.schema.json'),
            JSON.stringify({
                type: 'object',
                additionalProperties: false,
                required: ['rules'],
                properties: {
                    $schema: { type: 'string' },
                    rules: { type: 'array', items: { type: 'object' } },
                },
            }),
        );
        const rulePath = join(dir, 'rules.yaml');
        await writeFile(
            rulePath,
            '$schema: ./rule-file.schema.json\nrules:\n  - id: ok\n    evaluator:\n      type: path\nextra: nope\n',
        );

        await expect(loadRuleFile(rulePath)).rejects.toThrow('failed JSON schema validation');
        expect((await loadRuleFile(rulePath, { validateSchema: false })).rules).toHaveLength(1);
    });
});

describe('loadPresetRules schema validation', () => {
    test('honors preset $schema validation by default', async () => {
        const root = await mkdtemp(join(tmpdir(), 'preset-schema-'));
        await writeFile(
            join(root, 'preset.schema.json'),
            JSON.stringify({
                type: 'object',
                additionalProperties: false,
                required: ['name'],
                properties: {
                    $schema: { type: 'string' },
                    name: { type: 'string' },
                    extends: { type: 'array', items: { type: 'string' } },
                },
            }),
        );
        await writeFile(
            join(root, 'recommended.yaml'),
            '$schema: ./preset.schema.json\nname: recommended\nextra: nope\n',
        );

        await expect(loadPresetRules('recommended', { roots: [root] })).rejects.toThrow(
            'failed JSON schema validation',
        );
        expect(await loadPresetRules('recommended', { roots: [root], validateSchema: false })).toEqual([]);
    });
});
