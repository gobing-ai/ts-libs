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
});

describe('loadRuleFile', () => {
    test('throws for nonexistent file', async () => {
        await expect(loadRuleFile(`/tmp/nonexistent-file-${Date.now()}.yaml`)).rejects.toThrow();
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
        expect(await loadRuleFile(rulePath, { validateSchema: false })).toHaveLength(1);
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
