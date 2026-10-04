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
                { id: 'next', action: { kind: 'reader', options: { message: `\${vars.x}` } } },
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
                { id: 'next', action: { kind: 'reader', options: { message: `\${vars.errFlag}` } } },
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

describe('TransitionFlowDriver — structured parallel execution (task 0095)', () => {
    test('runs parallel branches concurrently and advances to join node', async () => {
        const events: string[] = [];
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'slow-action',
            async execute(options) {
                const id = String(options.id);
                events.push(`start:${id}`);
                await new Promise((r) => setTimeout(r, 30));
                events.push(`end:${id}`);
                return { ok: true, setVars: { [`result_${id}`]: `done_${id}` } };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'parallel-flow',
            initialNode: 'fork',
            terminalNodes: ['done'],
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel',
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'join-node',
                    joinPolicy: 'all',
                    failurePolicy: 'collect',
                },
                { id: 'n1', action: { kind: 'slow-action', options: { id: 'n1' } } },
                { id: 'n2', action: { kind: 'slow-action', options: { id: 'n2' } } },
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

        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');

        // Both started before either ended (concurrent execution!)
        const startN1 = events.indexOf('start:n1');
        const startN2 = events.indexOf('start:n2');
        const endN1 = events.indexOf('end:n1');
        const endN2 = events.indexOf('end:n2');
        expect(startN1).toBeLessThan(endN1);
        expect(startN2).toBeLessThan(endN2);
        expect(startN1).toBeLessThan(endN2);
        expect(startN2).toBeLessThan(endN1);

        const branches = await persistence.listRunBranches(result.runId, 'fork');
        expect(branches.length).toBe(2);
        expect(branches.every((b) => b.status === 'done')).toBe(true);
    });

    test('isolates branch variables and merges them deterministically at join', async () => {
        let n1SawShared = '';
        let n2SawShared = '';
        let finalVars: Record<string, string> = {};

        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'branch1-act',
                async execute(_options, ctx) {
                    n1SawShared = ctx.vars.shared ?? '';
                    return { ok: true, setVars: { from_b1: 'val1', shared: 'updated_by_b1' } };
                },
            })
            .registerAction({
                kind: 'branch2-act',
                async execute(_options, ctx) {
                    n2SawShared = ctx.vars.shared ?? '';
                    return { ok: true, setVars: { from_b2: 'val2', shared: 'updated_by_b2' } };
                },
            })
            .registerAction({
                kind: 'join-act',
                async execute(_options, ctx) {
                    finalVars = { ...ctx.vars };
                    return { ok: true };
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'parallel-vars',
            initialNode: 'fork',
            terminalNodes: ['done'],
            vars: { shared: 'initial_value' },
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel',
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'join-node',
                },
                { id: 'n1', action: { kind: 'branch1-act' } },
                { id: 'n2', action: { kind: 'branch2-act' } },
                { id: 'join-node', action: { kind: 'join-act' } },
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

        expect(result.status).toBe('done');
        // Both branches saw the frozen fork-time snapshot
        expect(n1SawShared).toBe('initial_value');
        expect(n2SawShared).toBe('initial_value');

        // Both branch variables merged; b2 declared after b1 so its write to 'shared' won
        expect(finalVars.from_b1).toBe('val1');
        expect(finalVars.from_b2).toBe('val2');
        expect(finalVars.shared).toBe('updated_by_b2');
    });

    test('enforces concurrencyLimit bounding active branches', async () => {
        let maxConcurrent = 0;
        let currentConcurrent = 0;

        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'metered',
            async execute() {
                currentConcurrent++;
                if (currentConcurrent > maxConcurrent) maxConcurrent = currentConcurrent;
                await new Promise((r) => setTimeout(r, 25));
                currentConcurrent--;
                return { ok: true };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'bounded-parallel',
            initialNode: 'fork',
            terminalNodes: ['done'],
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel',
                    concurrencyLimit: 2,
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b2', startNode: 'n2' },
                        { id: 'b3', startNode: 'n3' },
                        { id: 'b4', startNode: 'n4' },
                    ],
                    join: 'join-node',
                },
                { id: 'n1', action: { kind: 'metered' } },
                { id: 'n2', action: { kind: 'metered' } },
                { id: 'n3', action: { kind: 'metered' } },
                { id: 'n4', action: { kind: 'metered' } },
                { id: 'join-node' },
                { id: 'done' },
            ],
            edges: [
                { from: 'fork', to: 'n1' },
                { from: 'fork', to: 'n2' },
                { from: 'fork', to: 'n3' },
                { from: 'fork', to: 'n4' },
                { from: 'n1', to: 'join-node' },
                { from: 'n2', to: 'join-node' },
                { from: 'n3', to: 'join-node' },
                { from: 'n4', to: 'join-node' },
                { from: 'join-node', to: 'done' },
            ],
        });

        expect(result.status).toBe('done');
        expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    test('collect failure policy waits for all branches before recording failure', async () => {
        let b2Finished = false;
        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'fail-now',
                async execute() {
                    return { ok: false, error: 'b1-failed' };
                },
            })
            .registerAction({
                kind: 'slow-pass',
                async execute() {
                    await new Promise((r) => setTimeout(r, 30));
                    b2Finished = true;
                    return { ok: true, setVars: { b2_out: 'success' } };
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new TransitionFlowDriver({ host, persistence });

        const result = await driver.run({
            kind: 'transition-flow',
            name: 'collect-flow',
            initialNode: 'fork',
            terminalNodes: ['done'],
            nodes: [
                {
                    id: 'fork',
                    type: 'parallel',
                    failurePolicy: 'collect',
                    branches: [
                        { id: 'b1', startNode: 'n1' },
                        { id: 'b2', startNode: 'n2' },
                    ],
                    join: 'join-node',
                },
                { id: 'n1', action: { kind: 'fail-now' } },
                { id: 'n2', action: { kind: 'slow-pass' } },
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

        expect(b2Finished).toBe(true);
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('b1-failed');

        const branches = await persistence.listRunBranches(result.runId, 'fork');
        expect(branches.find((b) => b.branch_id === 'b1')?.status).toBe('failed');
        expect(branches.find((b) => b.branch_id === 'b2')?.status).toBe('done');
    });
});
