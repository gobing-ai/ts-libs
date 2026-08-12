import { describe, expect, test } from 'bun:test';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import { WorkflowResumeError } from '../src/errors';
import type { WorkflowEngineEvents } from '../src/events';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import { StateMachineDriver } from '../src/state-machine';
import { TransitionFlowDriver } from '../src/transition-flow';
import type { StateMachineWorkflowDef, TransitionFlowWorkflowDef } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

// ─── State-machine pause/resume ─────────────────────────────────────────────

function pauseWorkflow(): StateMachineWorkflowDef {
    return {
        name: 'approval-pipeline',
        initialState: 'draft',
        states: [{ id: 'draft' }, { id: 'review', pause: true }, { id: 'approved' }, { id: 'rejected' }],
        transitions: [
            { from: 'draft', to: 'review', trigger: 'submit' },
            { from: 'review', to: 'approved', trigger: 'approve' },
            { from: 'review', to: 'rejected', trigger: 'reject' },
        ],
    };
}

function pauseWorkflowWithActions(): StateMachineWorkflowDef {
    return {
        name: 'action-pause',
        initialState: 'start',
        states: [
            {
                id: 'start',
                onEnter: [{ kind: 'note', options: { message: 'entering-start' } }],
            },
            {
                id: 'checkpoint',
                pause: true,
                onEnter: [{ kind: 'note', options: { message: 'entering-checkpoint' } }],
                onExit: [{ kind: 'note', options: { message: 'exiting-checkpoint' } }],
            },
            { id: 'end' },
        ],
        transitions: [
            { from: 'start', to: 'checkpoint', trigger: 'advance' },
            { from: 'checkpoint', to: 'end', trigger: 'continue' },
        ],
    };
}

function transitionFlowPauseWorkflow(): TransitionFlowWorkflowDef {
    return {
        kind: 'transition-flow',
        name: 'tf-pause',
        initialNode: 'start',
        nodes: [
            { id: 'start', action: { kind: 'note', options: { message: 'start' } } },
            { id: 'gate', pause: true },
            { id: 'end' },
        ],
        edges: [
            { from: 'start', to: 'gate' },
            { from: 'gate', to: 'end' },
        ],
    };
}

describe('State-machine pause', () => {
    test('pauses at a state with pause: true', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const driver = new StateMachineDriver({ host, persistence });
        const result = await driver.run(pauseWorkflow(), { runId: 'pause-1' });

        expect(result.status).toBe('paused');
        expect(result.finalState).toBe('review');
        expect(result.runId).toBe('pause-1');
    });

    test('persists paused status', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const driver = new StateMachineDriver({ host, persistence });
        await driver.run(pauseWorkflow(), { runId: 'pause-persist' });

        const run = await persistence.loadRun('pause-persist');
        expect(run).toBeDefined();
        expect(run?.status).toBe('paused');
    });

    test('emits workflow.run.paused event', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const pausedEvents: Array<{ runId: string; node: string; transitionsTaken: number }> = [];
        void events.on('workflow.run.paused', (data) => pausedEvents.push(data));

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const driver = new StateMachineDriver({ host, persistence });
        await driver.run(pauseWorkflow(), { runId: 'pause-event', events });

        expect(pausedEvents.length).toBe(1);
        const [pausedEvt] = pausedEvents;
        expect(pausedEvt?.runId).toBe('pause-event');
        expect(pausedEvt?.node).toBe('review');
        expect(pausedEvt?.transitionsTaken).toBe(1);
    });

    test('executes on-enter actions before pausing', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const notes: string[] = [];
        void events.on('workflow.hitl.note', (data) => notes.push(data.message));

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const driver = new StateMachineDriver({ host, persistence });
        await driver.run(pauseWorkflowWithActions(), { runId: 'pause-actions', events });

        // Should have 'entering-start' and 'entering-checkpoint' but NOT 'exiting-checkpoint'
        expect(notes).toContain('entering-start');
        expect(notes).toContain('entering-checkpoint');
        expect(notes).not.toContain('exiting-checkpoint');
    });
});

describe('State-machine resume', () => {
    test('resumes and completes a paused run', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf = pauseWorkflow();

        // Run until pause
        const runResult = await service.run(wf, { runId: 'resume-1' });
        expect(runResult.status).toBe('paused');

        // Resume
        const resumed = await service.resumeRun(wf, 'resume-1');
        expect(resumed.status).toBe('done');
        expect(resumed.finalState).toBe('approved');
        expect(await persistence.loadRun('resume-1')).toMatchObject({ status: 'done' });
        expect(await service.listPausedRuns()).toHaveLength(0);
    });

    test('emits workflow.run.resumed event on resume', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const resumedEvents: Array<{ runId: string; node: string }> = [];
        void events.on('workflow.run.resumed', (data) => resumedEvents.push(data));

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf = pauseWorkflow();

        await service.run(wf, { runId: 'resume-event', events });
        await service.resumeRun(wf, 'resume-event', { events });

        expect(resumedEvents.length).toBe(1);
        const [resumedEvt] = resumedEvents;
        expect(resumedEvt?.runId).toBe('resume-event');
        expect(resumedEvt?.node).toBe('review');
    });

    test('resume after restart emits externalKey from persisted run', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const resumedEvents: Array<{ runId: string; node: string; externalKey?: string; severity: string }> = [];
        void events.on('workflow.run.resumed', (data) => resumedEvents.push(data));

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const wf = pauseWorkflow();
        await new WorkflowService(host, persistence).run(wf, {
            runId: 'resume-key',
            externalKey: 'entity/resume',
            events,
        });

        await new WorkflowService(host, persistence).resumeRun(wf, 'resume-key', { events });

        expect(resumedEvents).toEqual([
            { runId: 'resume-key', node: 'review', externalKey: 'entity/resume', severity: 'info' },
        ]);
    });

    test('resume on non-paused run throws WorkflowResumeError', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf = {
            name: 'simple',
            initialState: 'start',
            terminalStates: ['done'] as const,
            states: [{ id: 'start' }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done' }],
        };

        await service.run(wf, { runId: 'done-run' });

        expect(service.resumeRun(wf, 'done-run')).rejects.toThrow(WorkflowResumeError);
    });

    test('resume on non-existent run throws WorkflowResumeError', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);

        expect(service.resumeRun(pauseWorkflow(), 'no-such-run')).rejects.toThrow(WorkflowResumeError);
    });

    test('skips on-enter on resumed state', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const notes: string[] = [];
        void events.on('workflow.hitl.note', (data) => notes.push(data.message));

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf = pauseWorkflowWithActions();

        await service.run(wf, { runId: 'skip-enter', events });
        notes.length = 0; // clear notes from first run

        await service.resumeRun(wf, 'skip-enter', { events });

        // Should have 'exiting-checkpoint' from the onExit of checkpoint, but NOT 'entering-checkpoint' again
        expect(notes).toContain('exiting-checkpoint');
        expect(notes).not.toContain('entering-checkpoint');
    });

    test('pause persists across simulated restart', async () => {
        // First session: run until pause, then simulate process exit by dropping driver/service refs
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();

        const service1 = new WorkflowService(host, persistence);
        const wf = pauseWorkflow();
        await service1.run(wf, { runId: 'restart-run' });

        // Verify paused
        const pausedRun = await persistence.loadRun('restart-run');
        expect(pausedRun).toBeDefined();
        expect(pausedRun?.status).toBe('paused');

        // Second session: new service, same persistence
        const service2 = new WorkflowService(host, persistence);
        const resumed = await service2.resumeRun(wf, 'restart-run');
        expect(resumed.status).toBe('done');
        expect(resumed.finalState).toBe('approved');
        expect(await service2.listPausedRuns()).toHaveLength(0);
    });
});

describe('Transition-flow pause', () => {
    test('pauses at a node with pause: true', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const driver = new TransitionFlowDriver({ host, persistence });
        const result = await driver.run(transitionFlowPauseWorkflow(), { runId: 'tf-pause-1' });

        expect(result.status).toBe('paused');
        expect(result.finalState).toBe('gate');
    });

    test('resumes and completes a paused transition-flow run', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf = transitionFlowPauseWorkflow();

        const runResult = await service.run(wf, { runId: 'tf-resume-1' });
        expect(runResult.status).toBe('paused');

        const resumed = await service.resumeRun(wf, 'tf-resume-1');
        expect(resumed.status).toBe('done');
        expect(resumed.finalState).toBe('end');
        expect(await persistence.loadRun('tf-resume-1')).toMatchObject({ status: 'done' });
        expect(await service.listPausedRuns()).toHaveLength(0);
    });

    test('emits pause and resumed events', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const pausedEvents: Array<{ runId: string; node: string }> = [];
        const resumedEvents: Array<{ runId: string; node: string }> = [];
        void events.on('workflow.run.paused', (data) => pausedEvents.push(data));
        void events.on('workflow.run.resumed', (data) => resumedEvents.push(data));

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf = transitionFlowPauseWorkflow();

        await service.run(wf, { runId: 'tf-events', events });
        await service.resumeRun(wf, 'tf-events', { events });

        expect(pausedEvents.length).toBe(1);
        const [tfPaused] = pausedEvents;
        expect(tfPaused?.node).toBe('gate');
        expect(resumedEvents.length).toBe(1);
        const [tfResumed] = resumedEvents;
        expect(tfResumed?.node).toBe('gate');
    });
});

describe('listPausedRuns', () => {
    test('lists paused runs', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf = pauseWorkflow();

        await service.run(wf, { runId: 'list-1' });
        await service.run(wf, { runId: 'list-2' });

        const paused = await service.listPausedRuns();
        expect(paused.length).toBe(2);
    });

    test('filters by workflow name', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);

        const wf1: StateMachineWorkflowDef = {
            name: 'wf-a',
            initialState: 'start',
            states: [{ id: 'start', pause: true }],
            transitions: [],
        };
        const wf2: StateMachineWorkflowDef = {
            name: 'wf-b',
            initialState: 'start',
            states: [{ id: 'start', pause: true }],
            transitions: [],
        };

        await service.run(wf1, { runId: 'a-1' });
        await service.run(wf2, { runId: 'b-1' });

        const filtered = await service.listPausedRuns({ workflowName: 'wf-a' });
        expect(filtered.length).toBe(1);
        const [filteredRun] = filtered;
        expect(filteredRun?.workflow_name).toBe('wf-a');
    });

    test('respects limit', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);
        const wf: StateMachineWorkflowDef = {
            name: 'limit-wf',
            initialState: 'start',
            states: [{ id: 'start', pause: true }],
            transitions: [],
        };

        await service.run(wf, { runId: 'lim-1' });
        await service.run(wf, { runId: 'lim-2' });
        await service.run(wf, { runId: 'lim-3' });

        const limited = await service.listPausedRuns({ limit: 2 });
        expect(limited.length).toBe(2);
    });

    test('returns empty when no runs paused', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost();
        const service = new WorkflowService(host, persistence);

        const paused = await service.listPausedRuns();
        expect(paused.length).toBe(0);
    });
});

describe('Pause schema validation', () => {
    test('accepts pause: true on state definition', async () => {
        const { StateMachineWorkflowDefSchema } = await import('../src/schema');
        const result = StateMachineWorkflowDefSchema.safeParse({
            name: 'schema-test',
            initialState: 'start',
            states: [{ id: 'start', pause: true }],
            transitions: [],
        });
        expect(result.success).toBe(true);
    });

    test('accepts pause: true on flow node definition', async () => {
        const { TransitionFlowWorkflowDefSchema } = await import('../src/schema');
        const result = TransitionFlowWorkflowDefSchema.safeParse({
            kind: 'transition-flow',
            name: 'schema-test',
            initialNode: 'start',
            nodes: [{ id: 'start', pause: true }],
            edges: [],
        });
        expect(result.success).toBe(true);
    });

    test('rejects non-boolean pause value', async () => {
        const { StateMachineWorkflowDefSchema } = await import('../src/schema');
        const result = StateMachineWorkflowDefSchema.safeParse({
            name: 'schema-test',
            initialState: 'start',
            states: [{ id: 'start', pause: 'yes' as unknown as boolean }],
            transitions: [],
        });
        expect(result.success).toBe(false);
    });
});
