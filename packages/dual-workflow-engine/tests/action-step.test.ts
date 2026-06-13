import { describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { type ActionStepResult, runActionSequence, runActionStep } from '../src/action-step';
import { WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { RunLifecycle } from '../src/run-lifecycle';
import type { ActionDef, ActionResult } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

// WHY: runActionStep is the single seam both drivers share for action execution.
// Its outcome discriminator and persistence/observability sequence are the contract
// the state-machine and transition-flow loops depend on. These tests pin that contract
// at the seam so the two drivers cannot silently fork (the original duplication risk).

/** A host whose single action returns whatever the test wants, recording its options. */
function hostReturning(result: ActionResult, seen?: { options: Record<string, unknown> }): WorkflowEngineHost {
    return new WorkflowEngineHost().registerAction({
        kind: 'probe',
        async execute(options) {
            if (seen) seen.options = options;
            return result;
        },
    });
}

/** Drive a single action step inside a real RunLifecycle, returning the step result + persistence trace. */
async function runStepInLifecycle(
    action: ActionDef,
    host: WorkflowEngineHost,
    vars: Record<string, string> = {},
    overrides: Partial<Parameters<typeof runActionStep>[2]> = {},
): Promise<{ step: ActionStepResult; persistence: MemoryWorkflowPersistenceAdapter }> {
    const persistence = new MemoryWorkflowPersistenceAdapter();
    let step!: ActionStepResult;
    await RunLifecycle.run('wf', 'state-machine', { persistence }, { runId: 'r1' }, async (lifecycle) => {
        step = await runActionStep(action, vars, {
            host,
            persistence,
            lifecycle,
            workflowName: 'wf',
            stateOrNodeId: 'node',
            runId: 'r1',
            mode: 'state-machine',
            transitionsTaken: 0,
            env: {},
            options: {},
            defaultOnError: undefined,
            ...overrides,
        });
        return lifecycle.done('node', 0);
    });
    return { step, persistence };
}

describe('runActionStep — outcome classification', () => {
    test('a successful action yields completed with its result', async () => {
        const { step } = await runStepInLifecycle({ kind: 'probe' }, hostReturning({ ok: true, data: { x: 1 } }));
        expect(step.outcome).toBe('completed');
        expect(step.result).toEqual({ ok: true, data: { x: 1 } });
    });

    test('terminal wins over failure — a failing terminal result returns terminal, not fail', async () => {
        // WHY: both drivers must treat terminal as run-ending even when ok is false; this
        // is the unified contract (state-machine.test.ts "terminal wins over failure").
        const { step } = await runStepInLifecycle(
            { kind: 'probe' },
            hostReturning({ ok: false, error: 'boom', terminal: true }),
        );
        expect(step.outcome).toBe('terminal');
    });

    test("a failure under the default 'fail' policy returns fail", async () => {
        const { step } = await runStepInLifecycle({ kind: 'probe' }, hostReturning({ ok: false, error: 'boom' }));
        expect(step.outcome).toBe('fail');
        expect(step.result?.error).toBe('boom');
    });

    test("a failure under a 'continue' policy returns completed and retains the result", async () => {
        // WHY: a continued failure must stay visible to the next guard (onError-parity invariant).
        const { step } = await runStepInLifecycle(
            { kind: 'probe', onError: 'continue' },
            hostReturning({ ok: false, error: 'boom', data: { detail: 'why' } }),
        );
        expect(step.outcome).toBe('completed');
        expect(step.result).toEqual({ ok: false, error: 'boom', data: { detail: 'why' } });
    });

    test('the action-level onError beats the run/default policy', async () => {
        // action.onError 'continue' overrides a defaultOnError of 'fail'.
        const { step } = await runStepInLifecycle(
            { kind: 'probe', onError: 'continue' },
            hostReturning({ ok: false, error: 'boom' }),
            {},
            { defaultOnError: 'fail' },
        );
        expect(step.outcome).toBe('completed');
    });
});

describe('runActionStep — persistence sequence', () => {
    test('persists a start row then finalizes it with the terminal status', async () => {
        const { persistence } = await runStepInLifecycle({ kind: 'probe' }, hostReturning({ ok: true }));
        expect(persistence.actionRuns).toHaveLength(1);
        const row = persistence.actionRuns[0];
        expect(row?.node).toBe('node');
        expect(row?.kind).toBe('probe');
        expect(row?.status).toBe('done');
        expect(row?.ok).toBe(1);
    });

    test('finalizes a failed action as failed even when it is finalized via finally', async () => {
        const { persistence } = await runStepInLifecycle({ kind: 'probe' }, hostReturning({ ok: false, error: 'x' }));
        expect(persistence.actionRuns[0]?.status).toBe('failed');
        expect(persistence.actionRuns[0]?.ok).toBe(0);
    });
});

describe('runActionStep — template resolution', () => {
    test('resolves vars and builtins in action options before invoking the host', async () => {
        const seen: { options: Record<string, unknown> } = { options: {} };
        await runStepInLifecycle(
            { kind: 'probe', options: { msg: `\${vars.who} on \${workflow}` } },
            hostReturning({ ok: true }, seen),
            { who: 'me' },
        );
        expect(seen.options.msg).toBe('me on wf');
    });
});

describe('runActionSequence — multi-action control flow', () => {
    test('runs actions in order and returns the last result on completion', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = new WorkflowEngineHost().registerAction({
            kind: 'count',
            async execute(options) {
                return { ok: true, data: { n: options.n } };
            },
        });
        let result!: ActionStepResult;
        await RunLifecycle.run('wf', 'state-machine', { persistence }, { runId: 'r1' }, async (lifecycle) => {
            result = await runActionSequence(
                [
                    { kind: 'count', options: { n: 1 } },
                    { kind: 'count', options: { n: 2 } },
                ],
                {},
                {
                    host,
                    persistence,
                    lifecycle,
                    workflowName: 'wf',
                    stateOrNodeId: 'node',
                    runId: 'r1',
                    mode: 'state-machine',
                    transitionsTaken: 0,
                    env: {},
                    options: {},
                    defaultOnError: undefined,
                },
            );
            return lifecycle.done('node', 0);
        });
        expect(result.outcome).toBe('completed');
        expect(result.result?.data).toEqual({ n: 2 });
        expect(persistence.actionRuns).toHaveLength(2);
    });

    test('stops at the first failing action under a fail policy', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'fails',
                async execute() {
                    return { ok: false, error: 'stop here' };
                },
            })
            .registerAction({
                kind: 'never',
                async execute() {
                    return { ok: true, data: { reached: true } };
                },
            });
        let result!: ActionStepResult;
        await RunLifecycle.run('wf', 'state-machine', { persistence }, { runId: 'r1' }, async (lifecycle) => {
            result = await runActionSequence(
                [{ kind: 'fails' }, { kind: 'never' }],
                {},
                {
                    host,
                    persistence,
                    lifecycle,
                    workflowName: 'wf',
                    stateOrNodeId: 'node',
                    runId: 'r1',
                    mode: 'state-machine',
                    transitionsTaken: 0,
                    env: {},
                    options: {},
                    defaultOnError: 'fail',
                },
            );
            return lifecycle.done('node', 0);
        });
        expect(result.outcome).toBe('fail');
        // The second action must never run — only one start row persisted.
        expect(persistence.actionRuns).toHaveLength(1);
    });

    test('an empty action list completes with no result', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        let result!: ActionStepResult;
        await RunLifecycle.run('wf', 'state-machine', { persistence }, { runId: 'r1' }, async (lifecycle) => {
            result = await runActionSequence(
                [],
                {},
                {
                    host: new WorkflowEngineHost(),
                    persistence,
                    lifecycle,
                    workflowName: 'wf',
                    stateOrNodeId: 'node',
                    runId: 'r1',
                    mode: 'state-machine',
                    transitionsTaken: 0,
                    env: {},
                    options: {},
                    defaultOnError: undefined,
                },
            );
            return lifecycle.done('node', 0);
        });
        expect(result.outcome).toBe('completed');
        expect(result.result).toBeUndefined();
    });
});
