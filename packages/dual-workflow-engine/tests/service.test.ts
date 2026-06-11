import { describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { WorkflowDef, WorkflowRunRecord } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

function makeService() {
    const host = createDefaultWorkflowEngineHost();
    const persistence = new MemoryWorkflowPersistenceAdapter();
    return new WorkflowService(host, persistence);
}

describe('WorkflowService', () => {
    test('constructs with host and persistence', () => {
        const svc = makeService();
        expect(svc).toBeInstanceOf(WorkflowService);
    });

    test('runs a state-machine workflow', async () => {
        const svc = makeService();
        const workflow: WorkflowDef = {
            name: 'svc-test',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done', guard: { kind: 'always' } }],
        };

        const result = await svc.run(workflow, { runId: 'svc-run' });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(result.workflowName).toBe('svc-test');
    });

    test('runs a transition-flow workflow', async () => {
        const svc = makeService();
        const workflow: WorkflowDef = {
            kind: 'transition-flow' as const,
            name: 'svc-flow',
            initialNode: 'start',
            nodes: [{ id: 'start' }, { id: 'end' }],
            edges: [{ from: 'start', to: 'end' }],
        };

        const result = await svc.run(workflow, { runId: 'svc-flow-run' });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('end');
        expect(result.mode).toBe('transition-flow');
    });

    test('listRuns returns persisted runs', async () => {
        const svc = makeService();
        const workflow: WorkflowDef = {
            name: 'list-test',
            initialState: 's',
            states: [{ id: 's' }],
            transitions: [],
        };

        await svc.run(workflow, { runId: 'lr-1' });
        await svc.run(workflow, { runId: 'lr-2' });

        const runs = await svc.listRuns();
        expect(runs).toHaveLength(2);
        const ids = runs.map((r: WorkflowRunRecord) => r.id);
        expect(ids).toContain('lr-1');
        expect(ids).toContain('lr-2');
    });

    test('dryRun completes without executing actions', async () => {
        let actionCalled = false;
        const host = createDefaultWorkflowEngineHost();
        host.registerAction({
            kind: 'sideEffect',
            execute: async () => {
                actionCalled = true;
                return { ok: true };
            },
        });
        const svc = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());

        const workflow: WorkflowDef = {
            name: 'dry-test',
            kind: 'state-machine',
            initialState: 'start',
            states: [{ id: 'start', onEnter: [{ kind: 'sideEffect' }] }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done' }],
            terminalStates: ['done'],
        };

        const result = await svc.run(workflow, { runId: 'dry-1', dryRun: true });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(actionCalled).toBe(false);
    });
});
