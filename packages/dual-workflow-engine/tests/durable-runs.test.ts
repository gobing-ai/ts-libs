import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { EventBus } from '@gobing-ai/ts-infra';
import { FSMError } from '../src/errors';
import type { WorkflowEngineEvents } from '../src/events';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { DbWorkflowPersistenceAdapter, MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { StateMachineWorkflowDef, WorkflowRunRecord } from '../src/types';

function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
    return {
        id: crypto.randomUUID(),
        workflow_name: 'test-wf',
        mode: 'state-machine',
        status: 'running',
        started_at: new Date().toISOString(),
        completed_at: null,
        metadata_json: '{}',
        ...overrides,
    };
}

function simpleWorkflow(): StateMachineWorkflowDef {
    return {
        name: 'test-wf',
        initialState: 'start',
        terminalStates: ['done'],
        states: [{ id: 'start' }, { id: 'done' }],
        transitions: [{ from: 'start', to: 'done', trigger: 'finish' }],
    };
}

// ---------------------------------------------------------------------------
// MemoryWorkflowPersistenceAdapter — E1 feature tests
// ---------------------------------------------------------------------------
describe('MemoryWorkflowPersistenceAdapter — E1 durable named runs', () => {
    let adapter: MemoryWorkflowPersistenceAdapter;

    beforeEach(() => {
        adapter = new MemoryWorkflowPersistenceAdapter();
    });

    describe('findRunByKey', () => {
        test('returns undefined when no run has the key', async () => {
            const result = await adapter.findRunByKey('test-wf', 'task:0042');
            expect(result).toBeUndefined();
        });

        test('returns the run when key matches', async () => {
            const record = makeRecord({ external_key: 'task:0042' });
            await adapter.createRun(record);

            const found = await adapter.findRunByKey('test-wf', 'task:0042');
            expect(found).toBeDefined();
            expect(found?.id).toBe(record.id);
        });

        test('returns undefined when key matches but workflow differs', async () => {
            const record = makeRecord({ workflow_name: 'wf-a', external_key: 'task:0042' });
            await adapter.createRun(record);

            const found = await adapter.findRunByKey('wf-b', 'task:0042');
            expect(found).toBeUndefined();
        });

        test('returns undefined for null external_key', async () => {
            const record = makeRecord({ external_key: null });
            await adapter.createRun(record);

            const found = await adapter.findRunByKey('test-wf', 'task:0042');
            expect(found).toBeUndefined();
        });
    });

    describe('createOrAttachRun', () => {
        test('creates a new run when no existing run has the key', async () => {
            const record = makeRecord({ external_key: 'task:0042' });
            const result = await adapter.createOrAttachRun(record);

            expect(result.id).toBe(record.id);
            expect(result.external_key).toBe('task:0042');
        });

        test('attaches to existing run when key matches', async () => {
            const existing = makeRecord({ external_key: 'task:0042' });
            await adapter.createRun(existing);

            const attempt = makeRecord({ id: crypto.randomUUID(), external_key: 'task:0042' });
            const result = await adapter.createOrAttachRun(attempt);

            // Should return the *existing* run, not the new one
            expect(result.id).toBe(existing.id);
        });

        test('idempotent — second call returns existing run unchanged', async () => {
            const record = makeRecord({ external_key: 'task:0042' });
            const first = await adapter.createOrAttachRun(record);
            const second = await adapter.createOrAttachRun(
                makeRecord({ id: crypto.randomUUID(), external_key: 'task:0042' }),
            );

            expect(first.id).toBe(second.id);
        });

        test('creates without key when no external_key provided', async () => {
            const record = makeRecord();
            const result = await adapter.createOrAttachRun(record);
            expect(result.id).toBe(record.id);
        });

        test('allows different keys for same workflow', async () => {
            await adapter.createOrAttachRun(makeRecord({ external_key: 'task:0042' }));
            await adapter.createOrAttachRun(makeRecord({ external_key: 'task:0043' }));

            const all = await adapter.listRuns();
            expect(all).toHaveLength(2);
        });
    });

    describe('reseedRun', () => {
        test('persists a corrective state snapshot', async () => {
            const record = makeRecord({ id: 'r1' });
            await adapter.createRun(record);

            await adapter.reseedRun('r1', 'completed');

            // Should have a state snapshot
            const stateEntry = adapter.states.find((s) => s.runId === 'r1' && s.state === 'completed');
            expect(stateEntry).toBeDefined();
            expect(stateEntry?.data).toMatchObject({ reseeded: true });
        });

        test('records a reseed transition with __reseed__ trigger', async () => {
            const record = makeRecord({ id: 'r1' });
            await adapter.createRun(record);
            await adapter.saveWorkflowState('r1', 'start', {});

            await adapter.reseedRun('r1', 'completed');

            const tx = adapter.transitions.find((t) => t.runId === 'r1' && t.trigger === '__reseed__');
            expect(tx).toBeDefined();
            expect(tx?.to).toBe('completed');
            expect(tx?.from).toBe('start');
        });

        test('reseed is distinguishable from normal transitions', async () => {
            const record = makeRecord({ id: 'r1' });
            await adapter.createRun(record);

            // Normal transition
            await adapter.saveTransition('r1', 'start', 'processing', 'auto');
            // Reseed
            await adapter.reseedRun('r1', 'completed');

            const normal = adapter.transitions.find((t) => t.trigger === 'auto');
            const reseeded = adapter.transitions.find((t) => t.trigger === '__reseed__');

            expect(normal).toBeDefined();
            expect(reseeded).toBeDefined();
            expect(normal?.trigger).not.toBe(reseeded?.trigger);
        });
    });
});

// ---------------------------------------------------------------------------
// DbWorkflowPersistenceAdapter — E1 feature tests (real SQLite)
// ---------------------------------------------------------------------------
describe('DbWorkflowPersistenceAdapter — E1 durable named runs', () => {
    let db: DbAdapter;
    let adapter: DbWorkflowPersistenceAdapter;

    beforeEach(async () => {
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        adapter = new DbWorkflowPersistenceAdapter(db);
    });

    afterEach(() => {
        db.close();
    });

    describe('findRunByKey', () => {
        test('returns undefined when no run has the key', async () => {
            const result = await adapter.findRunByKey('test-wf', 'task:0042');
            expect(result).toBeUndefined();
        });

        test('returns the run when key matches', async () => {
            const record = makeRecord({ external_key: 'task:0042' });
            await adapter.createRun(record);

            const found = await adapter.findRunByKey('test-wf', 'task:0042');
            expect(found).toBeDefined();
            expect(found?.id).toBe(record.id);
        });

        test('returns undefined when key matches but workflow differs', async () => {
            const record = makeRecord({ workflow_name: 'wf-a', external_key: 'task:0042' });
            await adapter.createRun(record);

            const found = await adapter.findRunByKey('wf-b', 'task:0042');
            expect(found).toBeUndefined();
        });
    });

    describe('createOrAttachRun', () => {
        test('creates a new run when no existing run has the key', async () => {
            const record = makeRecord({ external_key: 'task:0042' });
            const result = await adapter.createOrAttachRun(record);

            expect(result.id).toBe(record.id);
        });

        test('attaches to existing run when key matches', async () => {
            const existing = makeRecord({ external_key: 'task:0042' });
            await adapter.createRun(existing);

            const attempt = makeRecord({ id: crypto.randomUUID(), external_key: 'task:0042' });
            const result = await adapter.createOrAttachRun(attempt);

            expect(result.id).toBe(existing.id);
        });

        test('idempotent — second call returns existing run unchanged', async () => {
            const record = makeRecord({ external_key: 'task:0042' });
            const first = await adapter.createOrAttachRun(record);
            const second = await adapter.createOrAttachRun(
                makeRecord({ id: crypto.randomUUID(), external_key: 'task:0042' }),
            );

            expect(first.id).toBe(second.id);
        });

        test('rejects duplicate external key from different runs via index', async () => {
            await adapter.createRun(makeRecord({ id: 'r1', external_key: 'task:0042' }));

            // Direct createRun should fail on unique index
            await expect(adapter.createRun(makeRecord({ id: 'r2', external_key: 'task:0042' }))).rejects.toThrow();
        });
    });

    describe('reseedRun', () => {
        test('persists a corrective state snapshot', async () => {
            await adapter.createRun(makeRecord({ id: 'r1' }));
            await adapter.reseedRun('r1', 'completed');

            // Verify state was saved via loadRun path — check transition recorded
            const states = await db.queryAll<{ state: string; data_json: string }>(
                'SELECT state, data_json FROM workflow_states WHERE run_id = ?',
                'r1',
            );
            const reseeded = states.find((s) => s.state === 'completed');
            expect(reseeded).toBeDefined();
            expect(JSON.parse(reseeded ? reseeded.data_json : '{}')).toMatchObject({ reseeded: true });
        });

        test('records __reseed__ trigger in transitions', async () => {
            await adapter.createRun(makeRecord({ id: 'r1' }));
            await adapter.reseedRun('r1', 'done');

            const transitions = await db.queryAll<{ from_state: string; to_state: string; trigger: string | null }>(
                'SELECT from_state, to_state, trigger FROM transition_runs WHERE run_id = ?',
                'r1',
            );
            const reseedTx = transitions.find((t) => t.trigger === '__reseed__');
            expect(reseedTx).toBeDefined();
            expect(reseedTx?.to_state).toBe('done');
        });
    });

    describe('restart survival', () => {
        test('run survives process restart via new adapter on same DB', async () => {
            const record = makeRecord({ id: 'survivor', external_key: 'task:0099' });
            await adapter.createRun(record);

            // Simulate restart — new adapter instance, same DB
            const adapter2 = new DbWorkflowPersistenceAdapter(db);

            const found = await adapter2.findRunByKey('test-wf', 'task:0099');
            expect(found).toBeDefined();
            expect(found?.id).toBe('survivor');
        });

        test('createOrAttachRun after restart attaches to persisted run', async () => {
            const original = makeRecord({ id: 'original', external_key: 'task:0100' });
            await adapter.createRun(original);

            const adapter2 = new DbWorkflowPersistenceAdapter(db);
            const attached = await adapter2.createOrAttachRun(
                makeRecord({ id: 'new-attempt', external_key: 'task:0100' }),
            );

            expect(attached.id).toBe('original');
        });
    });
});

// ---------------------------------------------------------------------------
// WorkflowService — E1 integration tests
// ---------------------------------------------------------------------------
describe('WorkflowService — E1 durable named runs', () => {
    let adapter: MemoryWorkflowPersistenceAdapter;
    let service: WorkflowService;

    beforeEach(() => {
        adapter = new MemoryWorkflowPersistenceAdapter();
        service = new WorkflowService(createDefaultWorkflowEngineHost(), adapter);
    });

    test('findRunByKey delegates to persistence', async () => {
        const record = makeRecord({ external_key: 'task:0050' });
        await adapter.createRun(record);

        const found = await service.findRunByKey('test-wf', 'task:0050');
        expect(found).toBeDefined();
        expect(found?.id).toBe(record.id);
    });

    test('findRunByKey returns undefined for unknown key', async () => {
        const found = await service.findRunByKey('test-wf', 'nonexistent');
        expect(found).toBeUndefined();
    });

    test('createOrAttachRun creates when no existing', async () => {
        const record = makeRecord({ external_key: 'task:0051' });
        const result = await service.createOrAttachRun(record);
        expect(result.id).toBe(record.id);
    });

    test('createOrAttachRun attaches when existing', async () => {
        const existing = makeRecord({ external_key: 'task:0052' });
        await adapter.createRun(existing);

        const result = await service.createOrAttachRun(
            makeRecord({ id: crypto.randomUUID(), external_key: 'task:0052' }),
        );
        expect(result.id).toBe(existing.id);
    });

    test('reseedRun delegates to persistence', async () => {
        await adapter.createRun(makeRecord({ id: 'r1' }));
        await service.reseedRun('r1', 'done');

        const tx = adapter.transitions.find((t) => t.trigger === '__reseed__');
        expect(tx).toBeDefined();
    });

    test('run with externalKey attaches to the existing run id', async () => {
        await adapter.createRun(makeRecord({ id: 'existing', external_key: 'task:0053' }));

        const result = await service.run(simpleWorkflow(), { runId: 'new-attempt', externalKey: 'task:0053' });

        expect(result.runId).toBe('existing');
        expect(await adapter.listRuns()).toHaveLength(1);
    });

    test('reseedRun validates state-machine target state and emits corrective event', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.run.reseeded', (data) =>
            seen.push(`${data.runId}:${data.fromState}->${data.toState}:${data.externalKey ?? ''}`),
        );
        await adapter.createRun(makeRecord({ id: 'r1', external_key: 'entity/reseed' }));
        await adapter.saveWorkflowState('r1', 'start', {});

        await service.reseedRun(simpleWorkflow(), 'r1', 'done', { events });

        expect(seen).toEqual(['r1:start->done:entity/reseed']);
    });

    test('reseedRun rejects undeclared state when workflow definition is provided', async () => {
        await adapter.createRun(makeRecord({ id: 'r1' }));

        await expect(service.reseedRun(simpleWorkflow(), 'r1', 'missing')).rejects.toThrow(FSMError);
    });
});
