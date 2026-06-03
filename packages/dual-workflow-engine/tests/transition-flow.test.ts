import { describe, expect, test } from 'bun:test';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { TransitionFlowDriver } from '../src/transition-flow';
import type { TransitionFlowWorkflowDef } from '../src/types';

function makeDriver() {
    const host = createDefaultWorkflowEngineHost();
    const persistence = new MemoryWorkflowPersistenceAdapter();
    return new TransitionFlowDriver({ host, persistence });
}

function simpleFlow(overrides: Partial<TransitionFlowWorkflowDef> = {}): TransitionFlowWorkflowDef {
    return {
        kind: 'transition-flow',
        name: 'test-flow',
        initialNode: 'start',
        terminalNodes: ['done'],
        nodes: [{ id: 'start', action: { kind: 'note', options: { message: 'go' } } }, { id: 'done' }],
        edges: [{ from: 'start', to: 'done' }],
        ...overrides,
    };
}

describe('TransitionFlowDriver', () => {
    test('instantiates with host and persistence', () => {
        const driver = makeDriver();
        expect(driver).toBeInstanceOf(TransitionFlowDriver);
    });

    test('runs a simple flow to completion', async () => {
        const driver = makeDriver();
        const result = await driver.run(simpleFlow(), { runId: 'run-tf' });

        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(result.transitionsTaken).toBe(1);
        expect(result.workflowName).toBe('test-flow');
        expect(result.mode).toBe('transition-flow');
    });

    test('generates a runId when none provided', async () => {
        const driver = makeDriver();
        const result = await driver.run(simpleFlow());
        expect(result.runId).toBeTruthy();
        expect(typeof result.runId).toBe('string');
    });

    test('stops at terminal node', async () => {
        const driver = makeDriver();
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'terminal-node',
            initialNode: 'only',
            nodes: [{ id: 'only' }],
            edges: [],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('only');
        expect(result.transitionsTaken).toBe(0);
    });

    test('fails when no edge condition passes', async () => {
        const driver = makeDriver();
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'dead-end',
            initialNode: 'start',
            nodes: [{ id: 'start', action: { kind: 'note' } }, { id: 'end' }],
            edges: [{ from: 'start', to: 'end', condition: { kind: 'never' } }],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('no-passing-edge');
    });

    test('fails when action returns ok: false', async () => {
        const host = new WorkflowEngineHost().registerAction({
            kind: 'failer',
            async execute() {
                return { ok: false, error: 'action-failed' };
            },
        });
        const driver = new TransitionFlowDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'fail-flow',
            initialNode: 'start',
            nodes: [{ id: 'start', action: { kind: 'failer' } }],
            edges: [],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('action-failed');
    });

    test('stops immediately on terminal action result', async () => {
        const host = new WorkflowEngineHost().registerAction({
            kind: 'terminate',
            async execute() {
                return { ok: true, terminal: true };
            },
        });
        const driver = new TransitionFlowDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'term-flow',
            initialNode: 'start',
            nodes: [{ id: 'start', action: { kind: 'terminate' } }, { id: 'never' }],
            edges: [{ from: 'start', to: 'never' }],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('start');
        expect(result.transitionsTaken).toBe(0);
    });

    test('node without action still transitions', async () => {
        const driver = makeDriver();
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'pass-through',
            initialNode: 'a',
            nodes: [{ id: 'a' }, { id: 'b' }],
            edges: [{ from: 'a', to: 'b' }],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('b');
        expect(result.transitionsTaken).toBe(1);
    });

    test('resolves runtime builtin templates for node actions', async () => {
        const messages: unknown[] = [];
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'capture',
                async execute(options) {
                    messages.push(options.message);
                    return { ok: true };
                },
            })
            .registerGuard({ kind: 'always', evaluate: async () => true });
        const driver = new TransitionFlowDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        await driver.run(
            simpleFlow({
                name: 'builtin-flow',
                nodes: [
                    {
                        id: 'start',
                        action: {
                            kind: 'capture',
                            options: {
                                message:
                                    '$' +
                                    '{workflow}:$' +
                                    '{runId}:$' +
                                    '{task}:$' +
                                    '{state}:$' +
                                    '{node}:$' +
                                    '{iteration}:$' +
                                    '{run}:$' +
                                    '{runtime}',
                            },
                        },
                    },
                    { id: 'done' },
                ],
            }),
            { runId: 'builtin-run' },
        );

        expect(messages).toEqual(['builtin-flow:builtin-run:builtin-flow:start:start:0:builtin-run:transition-flow']);
    });
});
