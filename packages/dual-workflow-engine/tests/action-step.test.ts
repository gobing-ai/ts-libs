import { describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { type ActionStepResult, runActionSequence, runActionStep } from '../src/action-step';
import { WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { RunLifecycle } from '../src/run-lifecycle';
import type { ActionDef, ActionResult, WorkflowPersistenceAdapter } from '../src/types';

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

    test('a rejected finalize write is swallowed — the run keeps going, no unhandledRejection', async () => {
        // WHY: the finalize write is audit-only (the row already exists via the awaited
        // saveActionStart). A failing audit write must never break or block the control
        // loop, so the fire-and-forget `.catch` swallows it. Without the catch this rejection
        // would surface as an unhandledRejection and could crash the host process.
        const persistence = new MemoryWorkflowPersistenceAdapter();
        // Keep the real adapter (so saveActionStart still resolves and the row exists),
        // but make only the audit finalize reject.
        const finalizeRejects: WorkflowPersistenceAdapter = Object.assign(
            Object.create(persistence) as MemoryWorkflowPersistenceAdapter,
            {
                saveActionFinalize: async (): Promise<void> => {
                    throw new Error('db down during finalize');
                },
            },
        );

        let step!: ActionStepResult;
        await RunLifecycle.run('wf', 'state-machine', { persistence }, { runId: 'r1' }, async (lifecycle) => {
            step = await runActionStep(
                { kind: 'probe' },
                {},
                {
                    host: hostReturning({ ok: true, data: { n: 1 } }),
                    persistence: finalizeRejects,
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

        // The step completed with the action's result despite the finalize write rejecting.
        expect(step.outcome).toBe('completed');
        expect(step.result).toEqual({ ok: true, data: { n: 1 } });
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

describe('runActionStep — observability seam (saveActionStart options)', () => {
    // WHY: the engine must forward the *resolved* step options (post-template-expansion) as
    // the 4th arg of saveActionStart so a mirroring/observability wrapper sees what will
    // actually run — not the raw templates. Persistence ignores the arg (mirror, never alter).
    test('forwards the resolved options map as the 4th argument to saveActionStart', async () => {
        const inner = new MemoryWorkflowPersistenceAdapter();
        const captured: { options?: Record<string, unknown> } = {};
        const spy: WorkflowPersistenceAdapter = Object.assign(
            Object.create(inner) as MemoryWorkflowPersistenceAdapter,
            {
                saveActionStart: async (
                    runId: string,
                    node: string,
                    kind: string,
                    options?: Record<string, unknown>,
                ) => {
                    captured.options = options;
                    return inner.saveActionStart(runId, node, kind, options);
                },
            },
        );

        await RunLifecycle.run('wf', 'state-machine', { persistence: inner }, { runId: 'r1' }, async (lifecycle) => {
            await runActionStep(
                { kind: 'probe', options: { msg: `\${vars.who} on \${workflow}` } },
                { who: 'me' },
                {
                    host: hostReturning({ ok: true }),
                    persistence: spy,
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

        expect(captured.options).toEqual({ msg: 'me on wf' });
    });

    test('omitting options (3-arg caller) still compiles and behaves identically', async () => {
        // WHY: the 4th param is optional; existing 3-arg implementors/callers must stay byte-identical.
        const inner = new MemoryWorkflowPersistenceAdapter();
        const id = await inner.saveActionStart('r1', 'node', 'probe');
        expect(typeof id).toBe('string');
        expect(inner.actionRuns).toHaveLength(1);
        expect(inner.actionRuns[0]?.node).toBe('node');
        expect(inner.actionRuns[0]?.kind).toBe('probe');
        expect(inner.actionRuns[0]?.status).toBe('running');
    });

    test('persistence row is identical with and without the options argument (mirror, never alter)', async () => {
        // WHY: options are observability-only — no new column, no altered row. The persisted
        // action row must be byte-identical whether options are passed or omitted.
        const withOpts = new MemoryWorkflowPersistenceAdapter();
        const withoutOpts = new MemoryWorkflowPersistenceAdapter();
        // Distinct tokens avoid false-positive substring hits on field names.
        await withOpts.saveActionStart('r1', 'node', 'probe', {
            secret: 'secret-token-xyz',
            agent: 'agent-value-xyz',
        });
        await withoutOpts.saveActionStart('r1', 'node', 'probe');
        // IDs are random UUIDs; compare everything else.
        const rowA = withOpts.actionRuns[0];
        const rowB = withoutOpts.actionRuns[0];
        expect(rowA).toBeDefined();
        expect(rowB).toBeDefined();
        // Fail hard rather than early-return (silent pass) if either row is missing.
        if (!rowA || !rowB) throw new Error('expected both action rows to exist');
        expect({ ...rowA, id: '<redacted>' }).toEqual({ ...rowB, id: '<redacted>' });
        // The options map is NOT persisted anywhere on the row.
        expect(JSON.stringify(rowA)).not.toContain('secret-token-xyz');
        expect(JSON.stringify(rowA)).not.toContain('agent-value-xyz');
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
