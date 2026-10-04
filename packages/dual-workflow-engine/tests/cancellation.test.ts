import { describe, expect, test } from 'bun:test';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { TransitionFlowDriver } from '../src/transition-flow';

describe('Cancellation and fail-fast process-group termination (task 0096)', () => {
    test('ActionRunContext exposes AbortSignal to action runners', async () => {
        let signalExposed = false;
        let signalAborted = false;

        const controller = new AbortController();
        const host = new WorkflowEngineHost().registerAction({
            kind: 'signal-inspector',
            async execute(_options, context) {
                signalExposed = context.signal !== undefined;
                context.signal?.addEventListener('abort', () => {
                    signalAborted = true;
                });
                controller.abort();
                return { ok: true };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        await driver.run(
            {
                kind: 'transition-flow',
                name: 'signal-flow',
                initialNode: 'start',
                nodes: [{ id: 'start', action: { kind: 'signal-inspector' } }],
                edges: [],
            },
            { signal: controller.signal },
        );

        expect(signalExposed).toBe(true);
        expect(signalAborted).toBe(true);
    });

    test('fail-fast aborts active sibling branches when one branch fails', async () => {
        let siblingAborted = false;
        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'instant-fail',
                async execute() {
                    return { ok: false, error: 'fail-fast-trigger' };
                },
            })
            .registerAction({
                kind: 'abort-listener',
                async execute(_options, context) {
                    return await new Promise((resolve) => {
                        const timer = setTimeout(() => {
                            resolve({ ok: true, data: { timedOut: false } });
                        }, 200);

                        context.signal?.addEventListener('abort', () => {
                            siblingAborted = true;
                            clearTimeout(timer);
                            resolve({ ok: false, error: 'aborted-by-fail-fast' });
                        });
                    });
                },
            });

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });
        const start = Date.now();

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'fail-fast-flow',
            initialNode: 'fork',
            terminalNodes: ['done'],
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel',
                    failurePolicy: 'fail-fast',
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'join-node',
                },
                { id: 'n1', action: { kind: 'instant-fail' } },
                { id: 'n2', action: { kind: 'abort-listener' } },
                { id: 'join-node' },
                { id: 'done' },
            ],
            edges: [
                { from: 'fork', to: 'n1' },
                { from: 'fork', to: 'n2' },
                { from: 'n1', to: 'join-node' },
                { from: 'n2', to: 'join-node' },
                { from: 'join-node', to: 'done' },
            ],
        });

        const duration = Date.now() - start;
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('fail-fast-trigger');
        expect(siblingAborted).toBe(true);
        expect(duration).toBeLessThan(150); // Did not wait for the 200ms timer to elapse!

        const branches = await persistence.listRunBranches(result.runId, 'fork');
        expect(branches.find((b) => b.branch_id === 'b1')?.status).toBe('failed');
        expect(branches.find((b) => b.branch_id === 'b2')?.status).toBe('cancelled');
    });

    test('ShellActionRunner terminates subprocess when signal is aborted', async () => {
        const controller = new AbortController();
        const host = createDefaultWorkflowEngineHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        setTimeout(() => {
            controller.abort();
        }, 30);

        const start = Date.now();
        const result = await driver.run(
            {
                kind: 'transition-flow',
                name: 'shell-cancel',
                initialNode: 'start',
                nodes: [
                    {
                        id: 'start',
                        action: {
                            kind: 'shell',
                            options: {
                                command: 'sleep 5',
                            },
                        },
                    },
                ],
                edges: [],
            },
            { signal: controller.signal },
        );

        const duration = Date.now() - start;
        expect(result.status).toBe('failed');
        expect(duration).toBeLessThan(1000); // Sleep 5 was killed well before 5 seconds!
    });
});
