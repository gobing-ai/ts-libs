import { describe, expect, test } from 'bun:test';
import { createDbAdapter } from '@gobing-ai/ts-db';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import { FSMError, WorkflowResumeError } from '../src/errors';
import type { WorkflowEngineEvents } from '../src/events';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { DbWorkflowPersistenceAdapter, MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { StateMachineWorkflowDef } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

/** Workflow whose entry state runs a note action (observable via workflow.hitl.note) then pauses. */
function interruptibleWorkflow(resumeRerun: boolean): StateMachineWorkflowDef {
    return {
        name: 'interruption-pipeline',
        initialState: 'work',
        terminalStates: ['done'],
        states: [
            {
                id: 'work',
                onEnter: [{ kind: 'note', options: { message: 'doing-work' } }],
                ...(resumeRerun ? { resumeRerun: true } : {}),
                pause: true,
            },
            { id: 'done' },
        ],
        transitions: [{ from: 'work', to: 'done', trigger: 'finish' }],
    };
}

function makeService(): { service: WorkflowService; persistence: MemoryWorkflowPersistenceAdapter } {
    const persistence = new MemoryWorkflowPersistenceAdapter();
    return { service: new WorkflowService(createDefaultWorkflowEngineHost(), persistence), persistence };
}

/** Drive a run to paused, then simulate a crashed resume: ghost claim (running) → interrupted. */
async function makeInterruptedRun(
    service: WorkflowService,
    persistence: MemoryWorkflowPersistenceAdapter,
    wf: StateMachineWorkflowDef,
    runId: string,
): Promise<void> {
    await service.run(wf, { runId });
    const claimed = await persistence.claimRunOwnership(runId, { attemptId: 'ghost' }, ['paused']);
    expect(claimed).toBeDefined();
    const interrupted = await service.interruptRun(runId, 'owner lost');
    expect(interrupted?.status).toBe('interrupted');
    expect(interrupted?.interrupt_reason).toBe('owner lost');
}

describe('interruption contract (task 0902)', () => {
    test('rerun-resume into unmarked state refuses loudly and leaves the run unclaimed', async () => {
        const { service, persistence } = makeService();
        const wf = interruptibleWorkflow(false);
        await makeInterruptedRun(service, persistence, wf, 'run-refused');

        // Default mode for interrupted is rerun-enter → must refuse before any action runs.
        expect(service.resumeRun(wf, 'run-refused')).rejects.toThrow(FSMError);
        const run = await persistence.loadRun('run-refused');
        expect(run?.status).toBe('interrupted');
        expect(run?.owner_attempt).toBe('ghost'); // pre-check fired before the claim, ghost owner intact
    });

    test('rerun-resume into resumeRerun-marked state re-executes on-enter actions', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const notes: string[] = [];
        void events.on('workflow.hitl.note', (data) => notes.push(data.message));
        const { service, persistence } = makeService();
        const wf = interruptibleWorkflow(true);
        await makeInterruptedRun(service, persistence, wf, 'run-rerun');

        const result = await service.resumeRun(wf, 'run-rerun', { events });
        expect(result.status).toBe('paused'); // re-paused at the pause point after the rerun
        // The initial run's note went to no bus; the rerun's note is captured here —
        // proof the on-enter action re-executed.
        expect(notes).toEqual(['doing-work']);
    });

    test('interrupted run can downgrade to explicit skip-enter without re-running actions', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const notes: string[] = [];
        void events.on('workflow.hitl.note', (data) => notes.push(data.message));
        const { service, persistence } = makeService();
        const wf = interruptibleWorkflow(true);
        await makeInterruptedRun(service, persistence, wf, 'run-skip');

        const result = await service.resumeRun(wf, 'run-skip', { events, resumeMode: 'skip-enter' });
        // skip-enter treats the pause-point actions as complete and advances past the pause.
        expect(result.status).toBe('done');
        expect(notes).toEqual([]); // no re-execution (initial note predates the bus)
    });

    test('interruptRun is a CAS: only running runs can be interrupted', async () => {
        const { service } = makeService();
        const wf = interruptibleWorkflow(false);

        // Missing run → undefined.
        expect(await service.interruptRun('missing', 'x')).toBeUndefined();

        await service.run(wf, { runId: 'cas-run' }); // ends paused (pause point)
        expect(await service.interruptRun('cas-run', 'too late')).toBeUndefined(); // paused ≠ running
    });

    test('concurrent resumes: exactly one claim wins, loser gets WorkflowResumeError', async () => {
        const { service, persistence } = makeService();
        const wf = interruptibleWorkflow(true);
        await makeInterruptedRun(service, persistence, wf, 'run-race');

        const outcomes = await Promise.allSettled([
            service.resumeRun(wf, 'run-race', { resumeOwner: { attemptId: 'a' } }),
            service.resumeRun(wf, 'run-race', { resumeOwner: { attemptId: 'b' } }),
        ]);
        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        const rejected = outcomes.filter((o) => o.status === 'rejected');
        expect(fulfilled.length).toBe(1);
        expect(rejected.length).toBe(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkflowResumeError);
        expect((await persistence.loadRun('run-race'))?.owner_attempt).toBe('a'); // first claim wins
    });

    test('resumed event carries resumeMode and ownerAttemptId', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const resumed: Array<{ resumeMode: string; ownerAttemptId: string }> = [];
        void events.on('workflow.run.resumed', (data) =>
            resumed.push({ resumeMode: data.resumeMode, ownerAttemptId: data.ownerAttemptId }),
        );
        const { service, persistence } = makeService();
        const wf = interruptibleWorkflow(true);
        await makeInterruptedRun(service, persistence, wf, 'run-event');

        await service.resumeRun(wf, 'run-event', { events, resumeOwner: { attemptId: 'att-9' } });
        expect(resumed).toEqual([{ resumeMode: 'rerun-enter', ownerAttemptId: 'att-9' }]);
    });

    test('resume with explicit pid records owner_pid', async () => {
        const { service, persistence } = makeService();
        const wf = interruptibleWorkflow(true);
        await makeInterruptedRun(service, persistence, wf, 'run-pid');

        await service.resumeRun(wf, 'run-pid', { resumeOwner: { attemptId: 'att-pid', pid: 4242 } });
        expect((await persistence.loadRun('run-pid'))?.owner_pid).toBe(4242);
    });

    test('db adapter: pre-0.5.0 runs table is migrated and claim persists owner columns', async () => {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            // Legacy schema: same 0.4.x runs table WITHOUT owner_attempt/owner_pid/interrupt_reason.
            await db.exec(`CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY, workflow_name TEXT, mode TEXT, status TEXT NOT NULL, agent TEXT,
                external_key TEXT, started_at TEXT NOT NULL, completed_at TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0
            );`);
            const adapter = new DbWorkflowPersistenceAdapter(db);
            // applyWorkflowEngineSchema runs lazily via ensureSchema on first write.
            await adapter.createRun({
                id: 'legacy-run',
                workflow_name: 'wf',
                mode: 'state-machine',
                status: 'paused',
                started_at: new Date().toISOString(),
                completed_at: null,
                metadata_json: '{}',
            });
            const claimed = await adapter.claimRunOwnership('legacy-run', { attemptId: 'att-1', pid: 7 }, ['paused']);
            expect(claimed?.status).toBe('running');
            expect(claimed?.owner_attempt).toBe('att-1');
            expect(claimed?.owner_pid).toBe(7);
            const interrupted = await adapter.interruptRun('legacy-run', 'crash');
            expect(interrupted?.status).toBe('interrupted');
            expect(interrupted?.interrupt_reason).toBe('crash');
            // Re-claim from interrupted works (interrupted is resumable).
            const reclaimed = await adapter.claimRunOwnership('legacy-run', { attemptId: 'att-2' }, ['interrupted']);
            expect(reclaimed?.owner_attempt).toBe('att-2');
        } finally {
            db.close();
        }
    });

    test('db adapter: losing claim returns undefined, winner keeps ownership', async () => {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            const adapter = new DbWorkflowPersistenceAdapter(db);
            await adapter.createRun({
                id: 'race-run',
                workflow_name: 'wf',
                mode: 'state-machine',
                status: 'paused',
                started_at: new Date().toISOString(),
                completed_at: null,
                metadata_json: '{}',
            });
            const winner = await adapter.claimRunOwnership('race-run', { attemptId: 'w1' }, ['paused']);
            expect(winner?.owner_attempt).toBe('w1');
            // Second claim: run is now running → not in expected statuses → undefined.
            const loser = await adapter.claimRunOwnership('race-run', { attemptId: 'w2' }, ['paused', 'interrupted']);
            expect(loser).toBeUndefined();
        } finally {
            db.close();
        }
    });
});
