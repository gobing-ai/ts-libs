import { describe, expect, test } from 'bun:test';
import { RunCollisionError } from '../src/errors';
import {
    applyWorkflowEngineSchema,
    DbWorkflowPersistenceAdapter,
    MemoryWorkflowPersistenceAdapter,
} from '../src/persistence';
import type { WorkflowRunRecord } from '../src/types';

function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
    return {
        id: 'run-1',
        workflow_name: 'test-wf',
        mode: 'state-machine',
        status: 'running',
        started_at: new Date().toISOString(),
        completed_at: null,
        metadata_json: '{}',
        ...overrides,
    };
}

describe('applyWorkflowEngineSchema', () => {
    test('function exists and is callable', () => {
        expect(typeof applyWorkflowEngineSchema).toBe('function');
    });
});

describe('DbWorkflowPersistenceAdapter', () => {
    test('class exists and can be constructed with a mock db', () => {
        const mockDb = {
            exec: async (_sql: string) => {},
            run: async (..._args: unknown[]) => {},
            queryFirst: async <T>() => undefined as T | undefined,
            queryAll: async <T>() => [] as T[],
            getDb: () => ({
                insert: () => ({ values: async () => {} }),
                select: () => ({ from: () => ({ where: async () => [] }) }),
                update: () => ({ set: () => ({ where: async () => ({ changes: 0 }) }) }),
                delete: () => ({ where: async () => ({ changes: 0 }) }),
            }),
            close: () => {},
        } as unknown as import('@gobing-ai/ts-db').DbAdapter;
        const adapter = new DbWorkflowPersistenceAdapter(mockDb);
        expect(adapter).toBeInstanceOf(DbWorkflowPersistenceAdapter);
    });
});

describe('MemoryWorkflowPersistenceAdapter', () => {
    test('creates and loads a run record', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        const record = makeRecord({ id: 'r-test' });
        await adapter.createRun(record);

        const loaded = await adapter.loadRun('r-test');
        expect(loaded).toEqual(record);
    });

    test('throws RunCollisionError on duplicate run id', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.createRun(makeRecord({ id: 'dup' }));
        await expect(adapter.createRun(makeRecord({ id: 'dup' }))).rejects.toThrow(RunCollisionError);
    });

    test('finalizes a run with done status', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.createRun(makeRecord({ id: 'r-fin' }));
        await adapter.finalizeRun('r-fin', 'done', '2026-01-01T00:00:00Z');

        const loaded = await adapter.loadRun('r-fin');
        expect(loaded?.status).toBe('done');
        expect(loaded?.completed_at).toBe('2026-01-01T00:00:00Z');
    });

    test('finalizes a run with failed status', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.createRun(makeRecord({ id: 'r-fail' }));
        await adapter.finalizeRun('r-fail', 'failed', '2026-01-01T12:00:00Z');

        const loaded = await adapter.loadRun('r-fail');
        expect(loaded?.status).toBe('failed');
    });

    test('finalizeRun is no-op for unknown run id', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.finalizeRun('ghost', 'done', 'now');
        expect(adapter.runs.size).toBe(0);
    });

    test('saves and tracks phases', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.savePhase('r1', 'init', 'running');
        await adapter.savePhase('r1', 'init', 'done');
        await adapter.savePhase('r1', 'process', 'running');

        expect(adapter.phases).toHaveLength(3);
        expect(adapter.phases[0]).toEqual({ runId: 'r1', phase: 'init', status: 'running' });
        expect(adapter.phases[1]).toEqual({ runId: 'r1', phase: 'init', status: 'done' });
    });

    test('saves transitions', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.saveTransition('r1', 'start', 'done', 'manual');

        expect(adapter.transitions).toHaveLength(1);
        expect(adapter.transitions[0]).toEqual({ runId: 'r1', from: 'start', to: 'done', trigger: 'manual' });
    });

    test('saves transitions with null trigger', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.saveTransition('r1', 'a', 'b', null);

        expect(adapter.transitions[0]?.trigger).toBeNull();
    });

    test('saves workflow state snapshots', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.saveWorkflowState('r1', 'processing', { count: 3, items: ['a', 'b'] });

        expect(adapter.states).toHaveLength(1);
        expect(adapter.states[0]).toEqual({
            runId: 'r1',
            state: 'processing',
            data: { count: 3, items: ['a', 'b'] },
        });
    });

    test('listRuns returns all created runs', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.createRun(makeRecord({ id: 'r1' }));
        await adapter.createRun(makeRecord({ id: 'r2' }));

        const runs = await adapter.listRuns();
        expect(runs).toHaveLength(2);
        const ids = runs.map((r) => r.id);
        expect(ids).toContain('r1');
        expect(ids).toContain('r2');
    });

    test('loadRun returns undefined for unknown id', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        const result = await adapter.loadRun('no-such-run');
        expect(result).toBeUndefined();
    });
});
