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
        // WORKFLOW_ENGINE_SCHEMA_SQL has 6 statements separated by ';'.
        // The split produces a trailing empty string after the final ';'.
        // applyWorkflowEngineSchema must handle it (trim + length > 0 check).
        const execCalls: string[] = [];
        const db = {
            exec: async (sql: string) => {
                execCalls.push(sql);
            },
        } as unknown as DbAdapter;
        await applyWorkflowEngineSchema(db);
        expect(execCalls.length).toBe(6);
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

    // WHY: options are mirror-only on the SQL adapter too — never a new column, never in the row.
    // Memory path is covered in action-step tests; this locks the Db path against accidental schema drift.
    // Token strings avoid false positives on column names (e.g. "omp" ⊆ "completed_at").
    test('saveActionStart ignores options (mirror, never persist) on the SQL adapter', async () => {
        await adapter.createRun(makeRecord({ id: 'r5b' }));
        const withId = await adapter.saveActionStart('r5b', 'step-1', 'http-call', {
            secret: 'secret-token-xyz',
            agent: 'agent-value-xyz',
        });
        const withoutId = await adapter.saveActionStart('r5b', 'step-2', 'http-call');

        const columns = await db.queryAll<{ name: string }>('PRAGMA table_info(action_runs)');
        expect(columns.map((c) => c.name)).not.toContain('options');

        const rows = await db.queryAll<Record<string, unknown>>(
            'SELECT * FROM action_runs WHERE id IN (?, ?) ORDER BY node',
            withId,
            withoutId,
        );
        expect(rows).toHaveLength(2);
        const serialized = JSON.stringify(rows);
        expect(serialized).not.toContain('secret-token-xyz');
        expect(serialized).not.toContain('agent-value-xyz');
        // Shape parity: same keys for both rows (ids/nodes differ by design).
        expect(Object.keys(rows[0] ?? {}).sort()).toEqual(Object.keys(rows[1] ?? {}).sort());
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
    test('loadCurrentState returns the latest state name for a run', async () => {
        await adapter.createRun(makeRecord({ id: 'r-state' }));
        await adapter.saveWorkflowState('r-state', 'init', { step: 1 });
        await adapter.saveWorkflowState('r-state', 'processing', { step: 2 });

        const state = await adapter.loadCurrentState('r-state');
        expect(state).toBe('processing');
    });

    test('loadCurrentState returns undefined when no states exist', async () => {
        await adapter.createRun(makeRecord({ id: 'r-empty' }));

        const state = await adapter.loadCurrentState('r-empty');
        expect(state).toBeUndefined();
    });

    test('loadLatestStateSnapshot returns the latest state and parsed data', async () => {
        await adapter.createRun(makeRecord({ id: 'r-snap' }));
        await adapter.saveWorkflowState('r-snap', 'processing', { count: 3 });

        const snap = await adapter.loadLatestStateSnapshot('r-snap');
        expect(snap).toBeDefined();
        expect(snap?.state).toBe('processing');
        expect(snap?.data).toEqual({ count: 3 });
    });

    test('loadLatestStateSnapshot returns undefined when no states exist', async () => {
        await adapter.createRun(makeRecord({ id: 'r-none' }));

        const snap = await adapter.loadLatestStateSnapshot('r-none');
        expect(snap).toBeUndefined();
    });

    // WHY: loadLatestStateSnapshot must degrade gracefully on malformed stored JSON
    // rather than throwing — a partially-written or migrated row should not crash the
    // state-loading path. The catch returns {} so callers see state + empty data.
    test('loadLatestStateSnapshot returns empty data when data_json is malformed', async () => {
        await adapter.createRun(makeRecord({ id: 'r-bad-json' }));
        await db.run(
            `INSERT INTO workflow_states (id, run_id, state, data_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            'bad-state-id',
            'r-bad-json',
            'broken',
            '{not valid json',
            Date.now(),
            Date.now(),
        );

        const snap = await adapter.loadLatestStateSnapshot('r-bad-json');
        expect(snap).toBeDefined();
        expect(snap?.state).toBe('broken');
        expect(snap?.data).toEqual({});
    });

    test('loadLatestStateSnapshot returns empty data for empty-string data_json', async () => {
        await adapter.createRun(makeRecord({ id: 'r-empty-json' }));
        await db.run(
            `INSERT INTO workflow_states (id, run_id, state, data_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            'empty-state-id',
            'r-empty-json',
            'pending',
            '',
            Date.now(),
            Date.now(),
        );

        const snap = await adapter.loadLatestStateSnapshot('r-empty-json');
        expect(snap?.state).toBe('pending');
        expect(snap?.data).toEqual({});
    });

    test('listPausedRuns returns only paused runs', async () => {
        await adapter.createRun(makeRecord({ id: 'p1', status: 'paused' }));
        await adapter.createRun(makeRecord({ id: 'p2', status: 'paused' }));
        await adapter.createRun(makeRecord({ id: 'r1', status: 'running' }));
        await adapter.createRun(makeRecord({ id: 'd1', status: 'done' }));

        const paused = await adapter.listPausedRuns();
        const ids = paused.map((r) => r.id);
        expect(ids).toContain('p1');
        expect(ids).toContain('p2');
        expect(ids).not.toContain('r1');
        expect(ids).not.toContain('d1');
    });

    test('listPausedRuns filters by workflowName', async () => {
        await adapter.createRun(makeRecord({ id: 'pa', status: 'paused', workflow_name: 'wf-a' }));
        await adapter.createRun(makeRecord({ id: 'pb', status: 'paused', workflow_name: 'wf-b' }));

        const paused = await adapter.listPausedRuns({ workflowName: 'wf-a' });
        expect(paused).toHaveLength(1);
        expect(paused[0]?.id).toBe('pa');
    });

    test('listPausedRuns respects the limit option', async () => {
        for (let i = 0; i < 5; i++) {
            await adapter.createRun(makeRecord({ id: `lim-${i}`, status: 'paused' }));
        }

        const paused = await adapter.listPausedRuns({ limit: 2 });
        expect(paused).toHaveLength(2);
    });

    test('listPausedRuns returns empty array when no paused runs exist', async () => {
        await adapter.createRun(makeRecord({ id: 'only-running', status: 'running' }));

        const paused = await adapter.listPausedRuns();
        expect(paused).toHaveLength(0);
    });
});

describe('DbWorkflowPersistenceAdapter.commitTransition — atomic batch (ADR-020)', () => {
    let db: DbAdapter;
    let adapter: DbWorkflowPersistenceAdapter;

    beforeEach(async () => {
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        await applyWorkflowEngineSchema(db);
        adapter = new DbWorkflowPersistenceAdapter(db);
        await adapter.createRun(makeRecord({ id: 'r-commit' }));
    });

    afterEach(() => {
        db.close();
    });

    test('writes transition + state + phase in a single atomic batch', async () => {
        // WHY: A crash between writes left the transition_runs row without a
        // matching workflow_states row, making resume pick the wrong state.
        // commitTransition must persist all three in one DB transaction.
        await adapter.commitTransition(
            'r-commit',
            'a',
            'b',
            'go',
            'b',
            { transitionsTaken: 1 },
            {
                phase: 'b',
                status: 'running',
            },
        );

        const txRows = await db.queryAll<{ from_state: string; to_state: string; trigger: string }>(
            'SELECT from_state, to_state, trigger FROM transition_runs WHERE run_id = ?',
            'r-commit',
        );
        expect(txRows).toHaveLength(1);
        expect(txRows[0]).toEqual({ from_state: 'a', to_state: 'b', trigger: 'go' });

        const stateRows = await db.queryAll<{ state: string; data_json: string }>(
            'SELECT state, data_json FROM workflow_states WHERE run_id = ?',
            'r-commit',
        );
        expect(stateRows).toHaveLength(1);
        expect(stateRows[0]?.state).toBe('b');
        expect(JSON.parse(stateRows[0]?.data_json as string)).toEqual({ transitionsTaken: 1 });

        const phaseRows = await db.queryAll<{ phase: string; status: string }>(
            'SELECT phase, status FROM phase_runs WHERE run_id = ?',
            'r-commit',
        );
        expect(phaseRows).toHaveLength(1);
        expect(phaseRows[0]).toEqual({ phase: 'b', status: 'running' });
    });

    test('writes transition + state without phase when phase omitted', async () => {
        // WHY: the external-transition service path (WorkflowService.requestTransition)
        // has no phase to record — it must still atomically persist transition + state.
        await adapter.commitTransition('r-commit', 'start', 'done', 'fast-track', 'done', {});

        const txRows = await db.queryAll<{ to_state: string }>(
            'SELECT to_state FROM transition_runs WHERE run_id = ?',
            'r-commit',
        );
        expect(txRows).toHaveLength(1);
        expect(txRows[0]?.to_state).toBe('done');

        const stateRows = await db.queryAll<{ state: string }>(
            'SELECT state FROM workflow_states WHERE run_id = ?',
            'r-commit',
        );
        expect(stateRows).toHaveLength(1);
        expect(stateRows[0]?.state).toBe('done');

        const phaseRows = await db.queryAll<{ phase: string }>(
            'SELECT phase FROM phase_runs WHERE run_id = ?',
            'r-commit',
        );
        expect(phaseRows).toHaveLength(0);
    });

    test('uses DbAdapter.batch() — not individual run() calls', async () => {
        // WHY: the whole point of commitTransition is atomicity. If it falls back to
        // separate run() calls, a mid-sequence crash leaves partial state. The batch
        // seam on DbAdapter is the contract that makes the batch atomic.
        const batchCalls: { sql: string; params: readonly unknown[] }[][] = [];
        const realBatch = db.batch.bind(db);
        const spiedDb = new Proxy(db, {
            get(target, prop) {
                if (prop === 'batch') {
                    return async (ops: { sql: string; params: readonly unknown[] }[]) => {
                        batchCalls.push(ops);
                        return realBatch(ops);
                    };
                }
                return Reflect.get(target, prop);
            },
        });
        const spiedAdapter = new DbWorkflowPersistenceAdapter(spiedDb);

        await spiedAdapter.commitTransition(
            'r-commit',
            'a',
            'b',
            'go',
            'b',
            { transitionsTaken: 1 },
            {
                phase: 'b',
                status: 'running',
            },
        );

        // batch() must have been called with exactly one array of 3 operations.
        expect(batchCalls).toHaveLength(1);
        const firstBatch = batchCalls[0];
        expect(firstBatch).toBeDefined();
        expect(firstBatch).toHaveLength(3);
        // Each op must have a sql string and params array.
        if (!firstBatch) throw new Error('expected batch');
        for (const op of firstBatch) {
            expect(typeof op.sql).toBe('string');
            expect(Array.isArray(op.params)).toBe(true);
        }
    });
});

describe('DbAdapter.batch() — BunSqliteAdapter transaction seam', () => {
    test('all-or-nothing: a failing statement rolls back the whole batch', async () => {
        // WHY: if one statement in the batch fails, none should persist — that's
        // the atomicity guarantee commitTransition relies on for crash safety.
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await db.exec('CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT NOT NULL)');
            await db.batch([
                { sql: 'INSERT INTO t1 (id, val) VALUES (?, ?)', params: [1, 'a'] },
                { sql: 'INSERT INTO t1 (id, val) VALUES (?, ?)', params: [2, null] }, // NOT NULL violation
                { sql: 'INSERT INTO t1 (id, val) VALUES (?, ?)', params: [3, 'c'] },
            ]);
            // If we reach here, the batch didn't fail — that's a bug.
            expect.unreachable('batch should have failed on NOT NULL violation');
        } catch {
            // Expected: the transaction rolled back.
            const rows = await db.queryAll<{ id: number; val: string }>('SELECT id, val FROM t1 ORDER BY id');
            expect(rows).toHaveLength(0); // none inserted — rollback worked
        } finally {
            db.close();
        }
    });

    test('empty batch is a no-op', async () => {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            await db.batch([]);
            // No throw, no side effect — that's the contract.
            expect(true).toBe(true);
        } finally {
            db.close();
        }
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
    test('commitTransition pushes transition + state + phase synchronously (atomic by nature)', async () => {
        // WHY: the memory adapter is the reference for the contract — commitTransition
        // must push all three records in one synchronous step so a crash between pushes
        // is impossible even in-memory. This mirrors the Db batch atomicity.
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.commitTransition(
            'r1',
            'a',
            'b',
            'go',
            'b',
            { transitionsTaken: 1 },
            {
                phase: 'b',
                status: 'running',
            },
        );

        expect(adapter.transitions).toHaveLength(1);
        expect(adapter.transitions[0]).toEqual({ runId: 'r1', from: 'a', to: 'b', trigger: 'go' });
        expect(adapter.states).toHaveLength(1);
        expect(adapter.states[0]).toEqual({ runId: 'r1', state: 'b', data: { transitionsTaken: 1 } });
        expect(adapter.phases).toHaveLength(1);
        expect(adapter.phases[0]).toEqual({ runId: 'r1', phase: 'b', status: 'running' });
    });

    test('commitTransition without phase pushes transition + state only', async () => {
        const adapter = new MemoryWorkflowPersistenceAdapter();
        await adapter.commitTransition('r1', 'start', 'done', 'fast-track', 'done', {});

        expect(adapter.transitions).toHaveLength(1);
        expect(adapter.transitions[0]).toEqual({ runId: 'r1', from: 'start', to: 'done', trigger: 'fast-track' });
        expect(adapter.states).toHaveLength(1);
        expect(adapter.states[0]).toEqual({ runId: 'r1', state: 'done', data: {} });
        expect(adapter.phases).toHaveLength(0);
    });
});
