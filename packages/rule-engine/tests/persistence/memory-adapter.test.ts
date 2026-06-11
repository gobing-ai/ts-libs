import { describe, expect, test } from 'bun:test';
import { MemoryRulePersistenceAdapter } from '../../src/persistence/memory-adapter';

describe('MemoryRulePersistenceAdapter', () => {
    test('insertRun stores a run row with running status', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 3, fixMode: 'none', dryRun: false });
        expect(adapter.runs.get('r1')?.status).toBe('running');
        expect(adapter.runs.get('r1')?.ruleCount).toBe(3);
    });

    test('updateRunStatus finalizes a run row', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertRun({ id: 'r1', sourceKind: 'preset', ruleCount: 3, fixMode: 'none', dryRun: false });
        await adapter.updateRunStatus('r1', 'done', 2, 1, 1, 1500);
        expect(adapter.runs.get('r1')?.status).toBe('done');
        expect(adapter.runs.get('r1')?.findingCount).toBe(2);
        expect(adapter.runs.get('r1')?.fixCount).toBe(1);
        expect(adapter.runs.get('r1')?.appliedFixCount).toBe(1);
        expect(adapter.runs.get('r1')?.durationMs).toBe(1500);
    });

    test('updateRunStatus throws for missing run', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await expect(adapter.updateRunStatus('nonexistent', 'done', 0, 0, 0, 0)).rejects.toThrow('Run not found');
    });

    test('insertEvalRun stores an eval row with running status', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertEvalRun({ id: 'r1:no-x', runId: 'r1', ruleId: 'no-x', severity: 'error', evaluator: 'rg' });
        const key = 'r1:no-x';
        expect(adapter.evals.get(key)?.status).toBe('running');
        await adapter.updateEvalRun({
            runId: 'r1',
            ruleId: 'no-x',
            status: 'done',
            findingCount: 0,
            fixCount: 0,
            durationMs: 42,
        });
        expect(adapter.evals.get(key)?.status).toBe('done');
        expect(adapter.evals.get(key)?.durationMs).toBe(42);
    });

    test('updateEvalRun sets error for failed eval', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await adapter.insertEvalRun({
            id: 'r1:crashy',
            runId: 'r1',
            ruleId: 'crashy',
            severity: 'error',
            evaluator: 'rg',
        });
        await adapter.updateEvalRun({
            runId: 'r1',
            ruleId: 'crashy',
            status: 'failed',
            findingCount: 0,
            fixCount: 0,
            durationMs: 0,
            error: 'boom',
        });
        expect(adapter.evals.get('r1:crashy')?.status).toBe('failed');
        expect(adapter.evals.get('r1:crashy')?.error).toBe('boom');
    });

    test('updateEvalRun throws for missing eval', async () => {
        const adapter = new MemoryRulePersistenceAdapter();
        await expect(
            adapter.updateEvalRun({
                runId: 'r1',
                ruleId: 'no-such',
                status: 'done',
                findingCount: 0,
                fixCount: 0,
                durationMs: 0,
            }),
        ).rejects.toThrow('Eval run not found');
    });
});
