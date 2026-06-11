import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { RunCollisionError } from '../src/errors';
import {
    applyWorkflowEngineSchema,
    DbWorkflowPersistenceAdapter,
    MemoryWorkflowPersistenceAdapter,
} from '../src/persistence';
import { WORKFLOW_ENGINE_SCHEMA_SQL } from '../src/schema-sql';
import type { WorkflowRunRecord } from '../src/types';

// Confirm the import is statically reachable for coverage (used in the split
// test below); the lint gate warns on unused imports.
void WORKFLOW_ENGINE_SCHEMA_SQL;

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

    test('creates all five tables against a real in-memory DB', async () => {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await applyWorkflowEngineSchema(db);

            // Each CREATE TABLE IF NOT EXISTS should succeed without error.
            // Verify by querying sqlite_master.
            const tables = await db.queryAll<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
            );
            const names = tables.map((t) => t.name);
            expect(names).toContain('runs');
            expect(names).toContain('phase_runs');
            expect(names).toContain('transition_runs');
            expect(names).toContain('workflow_states');
            expect(names).toContain('action_runs');
        } finally {
            db.close();
        }
    });

    test('splits multi-statement SQL and skips empty fragments', async () => {
        // WORKFLOW_ENGINE_SCHEMA_SQL has 5 statements separated by ';'.
        // The split produces a trailing empty string after the final ';'.
        // applyWorkflowEngineSchema must handle it (trim + length > 0 check).
        const execCalls: string[] = [];
        const db = {
            exec: async (sql: string) => {
                execCalls.push(sql);
            },
        } as unknown as DbAdapter;
        await applyWorkflowEngineSchema(db);
        expect(execCalls.length).toBe(5);
    });
});

describe('DbWorkflowPersistenceAdapter — with real in-memory DB', () => {
    let db: DbAdapter;
    let adapter: DbWorkflowPersistenceAdapter;

    beforeEach(async () => {
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        await applyWorkflowEngineSchema(db);
        adapter = new DbWorkflowPersistenceAdapter(db);
    });

    afterEach(() => {
        db.close();
    });

    test('creates a run and loads it back (with schema idempotency)', async () => {
        const record = makeRecord({ id: 'run-a' });
        await adapter.createRun(record);

        const loaded = await adapter.loadRun('run-a');
        expect(loaded).toBeDefined();
        expect(loaded?.id).toBe('run-a');
        expect(loaded?.workflow_name).toBe('test-wf');
        expect(loaded?.mode).toBe('state-machine');
        expect(loaded?.status).toBe('running');
    });

    test('throws RunCollisionError on duplicate run id', async () => {
        await adapter.createRun(makeRecord({ id: 'dup' }));
        await expect(adapter.createRun(makeRecord({ id: 'dup' }))).rejects.toThrow(RunCollisionError);
    });

    test('finalizes a run with done status + timestamp', async () => {
        await adapter.createRun(makeRecord({ id: 'r-fin' }));
        await adapter.finalizeRun('r-fin', 'done', '2026-01-01T00:00:00Z');

        const loaded = await adapter.loadRun('r-fin');
        expect(loaded?.status).toBe('done');
        expect(loaded?.completed_at).toBe('2026-01-01T00:00:00Z');
    });

    test('finalizes a run with failed status', async () => {
        await adapter.createRun(makeRecord({ id: 'r-fail' }));
        await adapter.finalizeRun('r-fail', 'failed', 'now');

        const loaded = await adapter.loadRun('r-fail');
        expect(loaded?.status).toBe('failed');
    });

    test('saves and tracks phases', async () => {
        await adapter.createRun(makeRecord({ id: 'r1' }));
        await adapter.savePhase('r1', 'init', 'running');
        await adapter.savePhase('r1', 'init', 'done');
        await adapter.savePhase('r1', 'process', 'running');

        // Query phase_runs directly to verify persistence
        const rows = await db.queryAll<{ phase: string; status: string }>(
            'SELECT phase, status FROM phase_runs WHERE run_id = ? ORDER BY created_at',
            'r1',
        );
        expect(rows).toHaveLength(3);
        expect(rows[0]).toEqual({ phase: 'init', status: 'running' });
        expect(rows[1]).toEqual({ phase: 'init', status: 'done' });
        expect(rows[2]).toEqual({ phase: 'process', status: 'running' });
    });

    test('saves transitions', async () => {
        await adapter.createRun(makeRecord({ id: 'r2' }));
        await adapter.saveTransition('r2', 'start', 'done', 'manual');

        const rows = await db.queryAll<{ from_state: string; to_state: string; trigger: string | null }>(
            'SELECT from_state, to_state, trigger FROM transition_runs WHERE run_id = ?',
            'r2',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({ from_state: 'start', to_state: 'done', trigger: 'manual' });
    });

    test('saves transitions with null trigger', async () => {
        await adapter.createRun(makeRecord({ id: 'r3' }));
        await adapter.saveTransition('r3', 'a', 'b', null);

        const rows = await db.queryAll<{ trigger: string | null }>(
            'SELECT trigger FROM transition_runs WHERE run_id = ?',
            'r3',
        );
        expect(rows[0]?.trigger).toBeNull();
    });

    test('saves workflow state snapshots', async () => {
        await adapter.createRun(makeRecord({ id: 'r4' }));
        await adapter.saveWorkflowState('r4', 'processing', { count: 3, items: ['a', 'b'] });

        const rows = await db.queryAll<{ state: string; data_json: string }>(
            'SELECT state, data_json FROM workflow_states WHERE run_id = ?',
            'r4',
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.state).toBe('processing');
        expect(JSON.parse(rows[0]?.data_json as string)).toEqual({ count: 3, items: ['a', 'b'] });
    });

    test('saveActionStart initializes a running action and returns an id', async () => {
        await adapter.createRun(makeRecord({ id: 'r5' }));
        const actionId = await adapter.saveActionStart('r5', 'step-1', 'http-call');

        const rows = await db.queryAll<{ status: string; node: string; kind: string }>(
            'SELECT status, node, kind FROM action_runs WHERE id = ?',
            actionId,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]?.status).toBe('running');
        expect(rows[0]?.node).toBe('step-1');
        expect(rows[0]?.kind).toBe('http-call');
    });

    test('saveActionFinalize updates action with ok flag, duration, and result', async () => {
        await adapter.createRun(makeRecord({ id: 'r6' }));
        const actionId = await adapter.saveActionStart('r6', 'calc', 'compute');

        await adapter.saveActionFinalize(actionId, 'done', 42, true, { output: 99 });

        const rows = await db.queryAll<{
            status: string;
            duration_ms: number;
            ok: number;
            result_json: string | null;
        }>('SELECT status, duration_ms, ok, result_json FROM action_runs WHERE id = ?', actionId);
        expect(rows[0]?.status).toBe('done');
        expect(rows[0]?.duration_ms).toBe(42);
        expect(rows[0]?.ok).toBe(1);
        expect(JSON.parse(rows[0]?.result_json as string)).toEqual({ output: 99 });
    });

    test('saveActionFinalize sets ok=0 for failed actions', async () => {
        await adapter.createRun(makeRecord({ id: 'r7' }));
        const actionId = await adapter.saveActionStart('r7', 'step', 'transform');

        await adapter.saveActionFinalize(actionId, 'failed', 10, false);

        const rows = await db.queryAll<{ ok: number; status: string }>(
            'SELECT ok, status FROM action_runs WHERE id = ?',
            actionId,
        );
        expect(rows[0]?.status).toBe('failed');
        expect(rows[0]?.ok).toBe(0);
    });

    test('saveActionFinalize stores null result_json when no result provided', async () => {
        await adapter.createRun(makeRecord({ id: 'r8' }));
        const actionId = await adapter.saveActionStart('r8', 'nop', 'noop');

        await adapter.saveActionFinalize(actionId, 'done', 5, true);

        const rows = await db.queryAll<{ result_json: string | null }>(
            'SELECT result_json FROM action_runs WHERE id = ?',
            actionId,
        );
        expect(rows[0]?.result_json).toBeNull();
    });

    test('listRuns returns all runs ordered by started_at DESC', async () => {
        await adapter.createRun(makeRecord({ id: 'first', started_at: '2025-01-01T00:00:00Z' }));
        await adapter.createRun(makeRecord({ id: 'second', started_at: '2026-01-01T00:00:00Z' }));

        const runs = await adapter.listRuns();
        expect(runs).toHaveLength(2);
        // start_at DESC → second (newer) first
        expect(runs[0]?.id).toBe('second');
        expect(runs[1]?.id).toBe('first');
    });

    test('loadRun returns undefined for unknown id', async () => {
        const loaded = await adapter.loadRun('no-such-run');
        expect(loaded).toBeUndefined();
    });

    test('createRun is idempotent on schema (loadRun path also applies schema)', async () => {
        // Regression: both createRun and loadRun call applyWorkflowEngineSchema.
        // Running them interleaved on the same adapter must not throw.
        await adapter.createRun(makeRecord({ id: 'a' }));
        await adapter.loadRun('a');
        await adapter.createRun(makeRecord({ id: 'b' }));
        await adapter.loadRun('b');

        const runs = await adapter.listRuns();
        expect(runs).toHaveLength(2);
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

    test('saveActionStart and saveActionFinalize with ok=false', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        const actionId = await adapter.saveActionStart('r1', 'step', 'compute');
        await adapter.saveActionFinalize(actionId, 'failed', 500, false, undefined);

        const row = adapter.actionRuns.find((a) => a.id === actionId);
        expect(row).toBeDefined();
        expect(row?.status).toBe('failed');
        expect(row?.durationMs).toBe(500);
        expect(row?.ok).toBe(0);
        expect(row?.resultJson).toBeNull();
    });

    test('saveActionFinalize is noop for unknown action id', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.saveActionFinalize('ghost', 'done', 1, true, {});

        // No error thrown, no rows added
        expect(adapter.actionRuns).toHaveLength(0);
    });
});
