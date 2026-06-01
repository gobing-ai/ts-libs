import { describe, expect, test } from 'bun:test';
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
});
