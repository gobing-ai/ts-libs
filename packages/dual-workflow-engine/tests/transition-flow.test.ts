import { describe, expect, test } from 'bun:test';
import { EventBus, setLoggerMuted } from '@gobing-ai/ts-infra';
import type { WorkflowEngineEvents } from '../src/events';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { TransitionFlowDriver } from '../src/transition-flow';
import type { TransitionFlowWorkflowDef } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

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

    test('emits action start and done events only for nodes with actions', async () => {
        const host = new WorkflowEngineHost().registerAction({
            kind: 'capture',
            async execute() {
                return { ok: true };
            },
        });
        const driver = new TransitionFlowDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.action.start', (data) => seen.push(`start:${data.node}:${data.kind}`));
        events.on('workflow.action.done', (data) =>
            seen.push(`done:${data.node}:${data.kind}:${data.ok}:${data.durationMs >= 0}`),
        );

        await driver.run(
            {
                kind: 'transition-flow',
                name: 'action-events',
                initialNode: 'with-action',
                terminalNodes: ['without-action'],
                nodes: [{ id: 'with-action', action: { kind: 'capture' } }, { id: 'without-action' }],
                edges: [{ from: 'with-action', to: 'without-action' }],
            },
            { runId: 'action-events', events },
        );

        expect(seen).toEqual(['start:with-action:capture', 'done:with-action:capture:true:true']);
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

describe('TransitionFlowDriver — onError policy', () => {
    function makeFailsDriver() {
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'failer',
                async execute() {
                    return { ok: false, error: 'intentional' };
                },
            })
            .registerAction({
                kind: 'passer',
                async execute() {
                    return { ok: true };
                },
            });
        return new TransitionFlowDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });
    }

    test('default onError="fail" on action failure halts', async () => {
        const driver = makeFailsDriver();
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'fail-flow',
            initialNode: 'start',
            nodes: [{ id: 'start', action: { kind: 'failer' } }],
            edges: [],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('intentional');
    });

    test('onError="continue" on action advances past failure', async () => {
        const driver = makeFailsDriver();
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'continue-flow',
            initialNode: 'start',
            terminalNodes: ['done'],
            defaultOnError: 'continue',
            nodes: [{ id: 'start', action: { kind: 'failer' } }, { id: 'done' }],
            edges: [{ from: 'start', to: 'done' }],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(result.transitionsTaken).toBe(1);
    });

    test('per-action onError overrides workflow default', async () => {
        const driver = makeFailsDriver();
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'override-flow',
            initialNode: 'start',
            defaultOnError: 'continue',
            nodes: [{ id: 'start', action: { kind: 'failer', onError: 'fail' } }],
            edges: [],
        });
        expect(result.status).toBe('failed');
    });

    test('R4: single-node continue flow terminates done', async () => {
        const driver = makeFailsDriver();
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'single-node',
            initialNode: 'start',
            defaultOnError: 'continue',
            nodes: [{ id: 'start', action: { kind: 'failer' } }],
            edges: [],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('start');
        expect(result.transitionsTaken).toBe(0);
    });
});

describe('TransitionFlowDriver — setVars cross-action flow', () => {
    test('setVars from node 1 is visible to node 2 template resolution', async () => {
        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'setter',
                async execute() {
                    return { ok: true, setVars: { x: '42' } };
                },
            })
            .registerAction({
                kind: 'reader',
                async execute(options: Record<string, unknown>) {
                    return { ok: true, data: { resolved: options.message } };
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'setvars-cross-node',
            initialNode: 'init',
            terminalNodes: ['end'],
            nodes: [
                { id: 'init', action: { kind: 'setter' } },
                // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow engine template syntax, not JS interpolation
                { id: 'next', action: { kind: 'reader', options: { message: '${vars.x}' } } },
                { id: 'end' },
            ],
            edges: [
                { from: 'init', to: 'next' },
                { from: 'next', to: 'end' },
            ],
        });
        // If x were missing, ${vars.x} would throw WorkflowValidationError.
        expect(result.status).toBe('done');
    });

    test('setVars is visible to an edge condition reading the var', async () => {
        let conditionSawVar = false;
        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'setter',
                async execute() {
                    return { ok: true, setVars: { flag: 'on' } };
                },
            })
            .registerGuard({
                kind: 'check-flag',
                async evaluate(_options: Record<string, unknown>, context) {
                    conditionSawVar = context.vars.flag === 'on';
                    return conditionSawVar;
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'setvars-condition',
            initialNode: 'init',
            terminalNodes: ['end'],
            nodes: [{ id: 'init', action: { kind: 'setter' } }, { id: 'middle' }, { id: 'end' }, { id: 'dead' }],
            edges: [
                { from: 'init', to: 'middle' },
                { from: 'middle', to: 'end', condition: { kind: 'check-flag' } },
                { from: 'middle', to: 'dead' },
            ],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('end');
        expect(conditionSawVar).toBe(true);
    });

    test('setVars from a continued-failure action is still merged', async () => {
        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'fail-setter',
                async execute() {
                    return { ok: false, error: 'failed but continued', setVars: { errFlag: 'set' } };
                },
            })
            .registerAction({
                kind: 'reader',
                async execute(options: Record<string, unknown>) {
                    return { ok: true, data: { resolved: options.message } };
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'setvars-continue',
            initialNode: 'init',
            terminalNodes: ['end'],
            defaultOnError: 'continue',
            nodes: [
                { id: 'init', action: { kind: 'fail-setter' } },
                // biome-ignore lint/suspicious/noTemplateCurlyInString: workflow engine template syntax, not JS interpolation
                { id: 'next', action: { kind: 'reader', options: { message: '${vars.errFlag}' } } },
                { id: 'end' },
            ],
            edges: [
                { from: 'init', to: 'next' },
                { from: 'next', to: 'end' },
            ],
        });
        // If errFlag were missing, ${vars.errFlag} would throw WorkflowValidationError.
        expect(result.status).toBe('done');
    });
});
