import { describe, expect, test } from 'bun:test';
import { loadPresetRules, loadRuleFile } from '../../src/config/loader';

describe('loadPresetRules', () => {
    test('returns empty array when preset not found', async () => {
        const rules = await loadPresetRules('nonexistent', {
            workdir: `/tmp/does-not-exist-${Date.now()}`,
        });
        expect(rules).toEqual([]);
    });
});

describe('loadRuleFile', () => {
    test('throws for nonexistent file', async () => {
        await expect(loadRuleFile(`/tmp/nonexistent-file-${Date.now()}.yaml`)).rejects.toThrow();
    });
});
