import { describe, expect, test } from 'bun:test';
import type { RulePersistenceAdapter, RuleRunInput } from '../../src/persistence/adapter';
import { MemoryRulePersistenceAdapter } from '../../src/persistence/memory-adapter';

describe('RulePersistenceAdapter contract', () => {
    // Verify the interface contract through the memory adapter implementation.
    test('RuleRunInput fields are accepted by insertRun', async () => {
        const adapter: RulePersistenceAdapter = new MemoryRulePersistenceAdapter();
        const input: RuleRunInput = {
            id: 'r1',
            sourceKind: 'file',
            sourceValue: '/path/rules.yaml',
            ruleCount: 5,
            fixMode: 'none',
            dryRun: false,
            preset: 'my-preset',
            failOn: 'error',
            stopOnFirst: 'false',
            metadataJson: '{"key":"val"}',
        };
        await adapter.insertRun(input);
        // Cast to access memory-specific state for assertion.
        const mem = adapter as MemoryRulePersistenceAdapter;
        expect(mem.runs.get('r1')?.status).toBe('running');
        expect(mem.runs.get('r1')?.sourceKind).toBe('file');
        expect(mem.runs.get('r1')?.sourceValue).toBe('/path/rules.yaml');
    });

    test('all RuleRunInput optional fields default correctly', async () => {
        const adapter: RulePersistenceAdapter = new MemoryRulePersistenceAdapter();
        await adapter.insertRun({ id: 'r2', sourceKind: 'preset', ruleCount: 1, fixMode: 'none', dryRun: false });
        const mem = adapter as MemoryRulePersistenceAdapter;
        expect(mem.runs.get('r2')?.preset).toBeUndefined();
        expect(mem.runs.get('r2')?.failOn).toBeUndefined();
        expect(mem.runs.get('r2')?.stopOnFirst).toBeUndefined();
        expect(mem.runs.get('r2')?.metadataJson).toBeUndefined();
    });
});
