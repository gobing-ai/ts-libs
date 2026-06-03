import { describe, expect, test } from 'bun:test';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { StateMachineDriver } from '../src/state-machine';
import type { StateMachineWorkflowDef } from '../src/types';

function makeDriver() {
    const host = createDefaultWorkflowEngineHost();
    const persistence = new MemoryWorkflowPersistenceAdapter();
    return new StateMachineDriver({ host, persistence });
}

function simpleWorkflow(overrides: Partial<StateMachineWorkflowDef> = {}): StateMachineWorkflowDef {
    return {
        name: 'test',
        initialState: 'start',
        terminalStates: ['done'],
        states: [{ id: 'start', onEnter: [{ kind: 'note', options: { message: 'starting' } }] }, { id: 'done' }],
        transitions: [{ from: 'start', to: 'done', guard: { kind: 'always' } }],
        ...overrides,
    };
}

describe('StateMachineDriver', () => {
    test('instantiates with host and persistence', () => {
        const driver = makeDriver();
        expect(driver).toBeInstanceOf(StateMachineDriver);
    });

    test('runs a simple workflow to completion', async () => {
        const driver = makeDriver();
        const result = await driver.run(simpleWorkflow(), { runId: 'run-sm' });

        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(result.transitionsTaken).toBe(1);
        expect(result.workflowName).toBe('test');
        expect(result.mode).toBe('state-machine');
    });

    test('generates a runId when none provided', async () => {
        const driver = makeDriver();
        const result = await driver.run(simpleWorkflow());
        expect(result.runId).toBeTruthy();
        expect(typeof result.runId).toBe('string');
    });

    test('stops at terminal state without transitions', async () => {
        const driver = makeDriver();
        const result = await driver.run({
            name: 'no-outbound',
            initialState: 'alone',
            states: [{ id: 'alone' }],
            transitions: [],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('alone');
        expect(result.transitionsTaken).toBe(0);
    });

    test('fails when no transition passes guard', async () => {
        const driver = makeDriver();
        const result = await driver.run({
            name: 'dead-end',
            initialState: 'start',
            states: [{ id: 'start' }, { id: 'end' }],
            transitions: [{ from: 'start', to: 'end', guard: { kind: 'never' } }],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('no-passing-transition');
    });

    test('fails when action returns ok: false', async () => {
        const host = new WorkflowEngineHost().registerAction({
            kind: 'failer',
            async execute() {
                return { ok: false, error: 'intentional' };
            },
        });
        const driver = new StateMachineDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        const result = await driver.run({
            name: 'fail-wf',
            initialState: 'start',
            states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }],
            transitions: [],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('intentional');
    });

    test('stops immediately on terminal action result', async () => {
        const host = new WorkflowEngineHost().registerAction({
            kind: 'terminate',
            async execute() {
                return { ok: true, terminal: true };
            },
        });
        const driver = new StateMachineDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        const result = await driver.run({
            name: 'term-wf',
            initialState: 'start',
            states: [{ id: 'start', onEnter: [{ kind: 'terminate' }] }, { id: 'never-visit' }],
            transitions: [{ from: 'start', to: 'never-visit', guard: { kind: 'always' } }],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('start');
        expect(result.transitionsTaken).toBe(0);
    });

    test('resolves runtime builtin templates for actions', async () => {
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
        const driver = new StateMachineDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        await driver.run(
            simpleWorkflow({
                name: 'builtin-wf',
                states: [
                    {
                        id: 'start',
                        onEnter: [
                            {
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
                        ],
                    },
                    { id: 'done' },
                ],
            }),
            { runId: 'builtin-run' },
        );

        expect(messages).toEqual(['builtin-wf:builtin-run:builtin-wf:start:start:0:builtin-run:state-machine']);
    });
});
