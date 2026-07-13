import { describe, expect, test } from 'bun:test';
import type { BusLifecycleEvents } from '@gobing-ai/ts-infra';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { RunLifecycle } from '../src/run-lifecycle';
import { WorkflowService } from '../src/service';
import type { StateMachineWorkflowDef, WorkflowDef, WorkflowRunRecord } from '../src/types';

setLoggerMuted(true);

/**
 * R3: WorkflowService accepts an optional lifecycleBus as its 3rd constructor
 * arg. When a run is started without an explicit `events` bus, the service
 * constructs an internal EventBus parented to the lifecycle bus so `workflow.*`
 * emits bridge into the System Events stream.
 */
describe('WorkflowService — lifecycle bus propagation (R3)', () => {
    function makeWorkflow(): WorkflowDef {
        return {
            name: 'r3-test',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done', guard: { kind: 'always' } }],
        };
    }

    test('workflow.run.started reaches the parent lifecycle bus', async () => {
        const seen: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (d) => seen.push(d.event));

        const host = createDefaultWorkflowEngineHost({ lifecycleBus });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);

        await svc.run(makeWorkflow(), { runId: 'r3-run' });

        expect(seen).toContain('workflow.run.started');
        expect(seen).toContain('workflow.run.done');
    });

    test('RunLifecycle constructs a parented events bus from lifecycleBus', async () => {
        const seen: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (detail) => seen.push(detail.event));
        const persistence = new MemoryWorkflowPersistenceAdapter();

        await RunLifecycle.run(
            'direct-lifecycle-test',
            'state-machine',
            { persistence, lifecycleBus },
            { runId: 'r3-direct' },
            async (lifecycle) => await lifecycle.done('done', 0),
        );

        expect(seen).toContain('workflow.run.started');
        expect(seen).toContain('workflow.run.done');
    });

    test('external transition outcomes use the host lifecycle bus fallback', async () => {
        const seen: string[] = [];
        const lifecycleBus = new EventBus<BusLifecycleEvents>();
        lifecycleBus.on('bus.emit.done', (detail) => seen.push(detail.event));
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(createDefaultWorkflowEngineHost({ lifecycleBus }), persistence);
        const workflow: StateMachineWorkflowDef = {
            name: 'external-transition-test',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done', trigger: 'approve' }],
        };
        const record: WorkflowRunRecord = {
            id: 'r3-external',
            workflow_name: workflow.name,
            mode: 'state-machine',
            status: 'running',
            started_at: new Date().toISOString(),
            completed_at: null,
            metadata_json: '{}',
        };
        await persistence.createRun(record);
        await persistence.saveWorkflowState(record.id, 'start', {});

        await service.requestTransition(workflow, record.id, 'done');
        await service.requestTransition(workflow, record.id, 'start');

        expect(seen).toContain('workflow.transition.requested');
        expect(seen).toContain('workflow.transition.denied');
    });

    test('no lifecycleBus — runs still succeed, no propagation', async () => {
        const host = createDefaultWorkflowEngineHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);

        const result = await svc.run(makeWorkflow(), { runId: 'r3-no-bus' });
        expect(result.status).toBe('done');
    });
});
