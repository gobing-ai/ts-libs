import { describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { StateMachineDriver } from '../src/state-machine';
import type { ActionResult, StateMachineWorkflowDef } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

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

describe('StateMachineDriver — onError policy', () => {
    function makeFailsDriver(hostOverrides?: (host: WorkflowEngineHost) => void) {
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
                    return { ok: true, data: { result: 'ok' } };
                },
            });
        hostOverrides?.(host);
        return new StateMachineDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });
    }

    test('default onError="fail" on action failure halts', async () => {
        const driver = makeFailsDriver();
        const result = await driver.run({
            name: 'fail-wf',
            initialState: 'start',
            states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }],
            transitions: [],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('intentional');
    });

    test('onError="continue" on action advances past failure', async () => {
        const driver = makeFailsDriver();
        const result = await driver.run({
            name: 'continue-wf',
            initialState: 'start',
            terminalStates: ['done'],
            defaultOnError: 'continue',
            states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done' }],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(result.transitionsTaken).toBe(1);
    });

    test('per-action onError overrides workflow default', async () => {
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'failer',
                async execute() {
                    return { ok: false, error: 'fail-action' };
                },
            })
            .registerAction({
                kind: 'passer',
                async execute() {
                    return { ok: true };
                },
            });
        const driver = new StateMachineDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        // Workflow default is 'continue', but action overrides to 'fail'
        const result = await driver.run({
            name: 'override-wf',
            initialState: 'start',
            terminalStates: ['done'],
            defaultOnError: 'continue',
            states: [{ id: 'start', onEnter: [{ kind: 'failer', onError: 'fail' }] }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done' }],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('fail-action');
    });

    test('runOptions.onError applies when action and workflow defaults are absent', async () => {
        const driver = makeFailsDriver();
        // action.onError and workflow.defaultOnError both absent → runOptions 'continue' is the effective policy
        const result = await driver.run(
            {
                name: 'precedence-wf',
                initialState: 'start',
                terminalStates: ['done'],
                states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }, { id: 'done' }],
                transitions: [{ from: 'start', to: 'done' }],
            },
            { onError: 'continue' },
        );
        // action.onError undefined → workflow.defaultOnError undefined → runOptions 'continue' → 'continue'
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
    });

    test('workflow defaultOnError overrides runOptions', async () => {
        const driver = makeFailsDriver();
        // workflow defaultOnError='fail', runOptions='continue' → 'fail' wins
        const result = await driver.run(
            {
                name: 'prec-wf',
                initialState: 'start',
                defaultOnError: 'fail',
                states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }, { id: 'done' }],
                transitions: [],
            },
            { onError: 'continue' },
        );
        expect(result.status).toBe('failed');
    });

    test('full precedence: action > workflow > runOptions > default', async () => {
        // action.onError = 'continue' → continues even with workflow 'fail' and runOptions 'fail'
        const driver = makeFailsDriver();
        const result = await driver.run(
            {
                name: 'full-prec',
                initialState: 'start',
                terminalStates: ['done'],
                defaultOnError: 'fail',
                states: [{ id: 'start', onEnter: [{ kind: 'failer', onError: 'continue' }] }, { id: 'done' }],
                transitions: [{ from: 'start', to: 'done' }],
            },
            { onError: 'fail' },
        );
        expect(result.status).toBe('done');
    });

    test('continue still terminates on terminal action', async () => {
        const host = new WorkflowEngineHost().registerAction({
            kind: 'terminator',
            async execute() {
                return { ok: false, error: 'but-terminal', terminal: true };
            },
        });
        const driver = new StateMachineDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });
        const result = await driver.run({
            name: 'term-wf',
            initialState: 'start',
            defaultOnError: 'continue',
            states: [{ id: 'start', onEnter: [{ kind: 'terminator' }] }],
            transitions: [],
        });
        expect(result.status).toBe('done'); // terminal wins over failure
    });

    test('R4: single-node continue workflow with no edges terminates done', async () => {
        const driver = makeFailsDriver();
        const result = await driver.run({
            name: 'single-node',
            initialState: 'start',
            defaultOnError: 'continue',
            states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }],
            transitions: [],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('start');
        expect(result.transitionsTaken).toBe(0);
    });

    test('continued onExit failure remains visible to the next state guard', async () => {
        const captured: { result: ActionResult | undefined } = { result: undefined };
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'failer',
                async execute() {
                    return { ok: false, error: 'exit-failed', data: { stage: 'onExit' } };
                },
            })
            .registerGuard({
                kind: 'capture-guard',
                async evaluate(_options, context) {
                    captured.result = context.lastActionResult;
                    return true;
                },
            });
        const driver = new StateMachineDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });

        const result = await driver.run({
            name: 'exit-continue',
            initialState: 'start',
            terminalStates: ['done'],
            defaultOnError: 'continue',
            states: [{ id: 'start', onExit: [{ kind: 'failer' }] }, { id: 'middle' }, { id: 'done' }],
            transitions: [
                { from: 'start', to: 'middle' },
                { from: 'middle', to: 'done', guard: { kind: 'capture-guard' } },
            ],
        });

        expect(result.status).toBe('done');
        expect(captured.result).toEqual({ ok: false, error: 'exit-failed', data: { stage: 'onExit' } });
    });
});

describe('StateMachineDriver — setVars cross-action flow', () => {
    test('setVars from step 1 is visible to step 2 template resolution', async () => {
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
        const driver = new StateMachineDriver({ host, persistence });

        const result = await driver.run({
            name: 'setvars-cross-step',
            initialState: 'init',
            terminalStates: ['end'],
            states: [
                { id: 'init', onEnter: [{ kind: 'setter' }] },
                { id: 'next', onEnter: [{ kind: 'reader', options: { message: `\${vars.x}` } }] },
                { id: 'end' },
            ],
            transitions: [
                { from: 'init', to: 'next' },
                { from: 'next', to: 'end' },
            ],
        });
        expect(result.status).toBe('done');
        // The reader action captured the resolved template value in data.resolved.
        // We verify through the run record — the last action result is accessible.
        // The setVars value '42' should have been visible when reader ran.
        // We prove it indirectly: if x were missing, ${vars.x} would throw WorkflowValidationError.
        expect(result.status).toBe('done');
    });

    test('setVars is visible to a guard reading the var', async () => {
        let guardSawVar = false;
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
                    guardSawVar = context.vars.flag === 'on';
                    return guardSawVar;
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new StateMachineDriver({ host, persistence });

        const result = await driver.run({
            name: 'setvars-guard',
            initialState: 'init',
            terminalStates: ['end'],
            states: [{ id: 'init', onEnter: [{ kind: 'setter' }] }, { id: 'middle' }, { id: 'end' }, { id: 'dead' }],
            transitions: [
                { from: 'init', to: 'middle' },
                { from: 'middle', to: 'end', guard: { kind: 'check-flag' } },
                { from: 'middle', to: 'dead' },
            ],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('end');
        expect(guardSawVar).toBe(true);
    });

    test('guard options resolve vars templates before evaluation', async () => {
        // Regression: shell guards received raw options without var interpolation, so
        // `spur task check ${vars.wbs}` reached /bin/sh as a literal bad substitution.
        // Guards must resolve templates the same way actions do.
        let guardSawResolvedVar = false;
        const host = createDefaultWorkflowEngineHost().registerGuard({
            kind: 'var-check',
            async evaluate(options: Record<string, unknown>) {
                guardSawResolvedVar = options.command === 'echo 0042';
                return guardSawResolvedVar;
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new StateMachineDriver({ host, persistence });

        const result = await driver.run({
            name: 'guard-var-resolution',
            initialState: 'init',
            terminalStates: ['end'],
            vars: { wbs: '0042' },
            states: [{ id: 'init' }, { id: 'end' }, { id: 'dead' }],
            transitions: [
                { from: 'init', to: 'end', guard: { kind: 'var-check', options: { command: `echo \${vars.wbs}` } } },
                { from: 'init', to: 'dead' },
            ],
        });
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('end');
        expect(guardSawResolvedVar).toBe(true);
    });

    test('onExit setVars visible to subsequent state onEnter', async () => {
        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'exit-setter',
                async execute() {
                    return { ok: true, setVars: { exitVar: 'from-exit' } };
                },
            })
            .registerAction({
                kind: 'reader',
                async execute(options: Record<string, unknown>) {
                    return { ok: true, data: { resolved: options.message } };
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new StateMachineDriver({ host, persistence });

        const result = await driver.run({
            name: 'setvars-onexit',
            initialState: 'init',
            terminalStates: ['end'],
            states: [
                { id: 'init', onExit: [{ kind: 'exit-setter' }] },
                { id: 'next', onEnter: [{ kind: 'reader', options: { message: `\${vars.exitVar}` } }] },
                { id: 'end' },
            ],
            transitions: [
                { from: 'init', to: 'next' },
                { from: 'next', to: 'end' },
            ],
        });
        // If exitVar were missing, ${vars.exitVar} would throw WorkflowValidationError.
        expect(result.status).toBe('done');
    });
});
