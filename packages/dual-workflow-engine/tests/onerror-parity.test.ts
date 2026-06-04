import { describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { StateMachineDriver } from '../src/state-machine';
import { TransitionFlowDriver } from '../src/transition-flow';
import type { ActionResult } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

// WHY: both drivers implement the same `onError: 'continue'` policy. A continued
// failure's result MUST stay visible to the next guard identically across dialects —
// otherwise a guard inspecting lastActionResult.error/.data behaves differently
// depending on whether the workflow is a state-machine or a transition-flow, which
// would be a silent semantic fork (the F1 finding in task 0014's verification).

/** Host whose failing action returns rich data, plus a guard that captures what it sees. */
function makeHost(captured: { result: ActionResult | undefined }): WorkflowEngineHost {
    return new WorkflowEngineHost()
        .registerAction({
            kind: 'failer',
            async execute() {
                return { ok: false, error: 'boom', data: { detail: 'why-it-failed' } };
            },
        })
        .registerGuard({
            kind: 'capture-guard',
            async evaluate(_options, context) {
                captured.result = context.lastActionResult;
                return true;
            },
        });
}

describe('onError continue — cross-driver parity', () => {
    test('state-machine: a continued failure is visible to the downstream guard', async () => {
        const captured: { result: ActionResult | undefined } = { result: undefined };
        const driver = new StateMachineDriver({
            host: makeHost(captured),
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });
        const result = await driver.run({
            name: 'sm-continue',
            initialState: 'start',
            terminalStates: ['done'],
            defaultOnError: 'continue',
            states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done', guard: { kind: 'capture-guard' } }],
        });

        expect(result.status).toBe('done');
        expect(captured.result).toEqual({ ok: false, error: 'boom', data: { detail: 'why-it-failed' } });
    });

    test('transition-flow: a continued failure is visible to the downstream guard', async () => {
        const captured: { result: ActionResult | undefined } = { result: undefined };
        const driver = new TransitionFlowDriver({
            host: makeHost(captured),
            persistence: new MemoryWorkflowPersistenceAdapter(),
        });
        const result = await driver.run({
            kind: 'transition-flow',
            name: 'tf-continue',
            initialNode: 'start',
            terminalNodes: ['done'],
            defaultOnError: 'continue',
            nodes: [{ id: 'start', action: { kind: 'failer' } }, { id: 'done' }],
            edges: [{ from: 'start', to: 'done', condition: { kind: 'capture-guard' } }],
        });

        expect(result.status).toBe('done');
        expect(captured.result).toEqual({ ok: false, error: 'boom', data: { detail: 'why-it-failed' } });
    });

    test('both drivers expose the identical continued-failure result to the guard', async () => {
        const smCaptured: { result: ActionResult | undefined } = { result: undefined };
        const tfCaptured: { result: ActionResult | undefined } = { result: undefined };

        await new StateMachineDriver({
            host: makeHost(smCaptured),
            persistence: new MemoryWorkflowPersistenceAdapter(),
        }).run({
            name: 'sm',
            initialState: 'start',
            terminalStates: ['done'],
            defaultOnError: 'continue',
            states: [{ id: 'start', onEnter: [{ kind: 'failer' }] }, { id: 'done' }],
            transitions: [{ from: 'start', to: 'done', guard: { kind: 'capture-guard' } }],
        });

        await new TransitionFlowDriver({
            host: makeHost(tfCaptured),
            persistence: new MemoryWorkflowPersistenceAdapter(),
        }).run({
            kind: 'transition-flow',
            name: 'tf',
            initialNode: 'start',
            terminalNodes: ['done'],
            defaultOnError: 'continue',
            nodes: [{ id: 'start', action: { kind: 'failer' } }, { id: 'done' }],
            edges: [{ from: 'start', to: 'done', condition: { kind: 'capture-guard' } }],
        });

        expect(smCaptured.result).toEqual(tfCaptured.result);
    });
});
