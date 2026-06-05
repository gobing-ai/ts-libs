import { describe, expect, test } from 'bun:test';
import { EventBus, type Logger, setLoggerMuted } from '@gobing-ai/ts-infra';
import type { WorkflowEngineEvents } from '../src/events';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import {
    allowedEnv,
    RUNTIME_BUILTIN_KEYS,
    RunLifecycle,
    runtimeBuiltins,
    type WorkflowMode,
} from '../src/run-lifecycle';
import type { WorkflowPersistenceAdapter } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

/** Persistence spy that records the order of lifecycle calls. */
function recordingPersistence(): { adapter: WorkflowPersistenceAdapter; calls: string[] } {
    const inner = new MemoryWorkflowPersistenceAdapter();
    const calls: string[] = [];
    const adapter: WorkflowPersistenceAdapter = {
        createRun: async (record) => {
            calls.push(`createRun:${record.id}:${record.status}`);
            return inner.createRun(record);
        },
        finalizeRun: async (runId, status, completedAt) => {
            calls.push(`finalizeRun:${status}`);
            return inner.finalizeRun(runId, status, completedAt);
        },
        savePhase: async (runId, phase, status) => {
            calls.push(`savePhase:${phase}:${status}`);
            return inner.savePhase(runId, phase, status);
        },
        saveTransition: async (runId, from, to, trigger) => {
            calls.push(`saveTransition:${from}->${to}:${trigger ?? 'null'}`);
            return inner.saveTransition(runId, from, to, trigger);
        },
        saveWorkflowState: async (runId, state, data) => {
            calls.push(`saveWorkflowState:${state}`);
            return inner.saveWorkflowState(runId, state, data);
        },
        loadRun: (runId) => inner.loadRun(runId),
        listRuns: () => inner.listRuns(),
    };
    return { adapter, calls };
}

/** Logger spy capturing level + message, so we can assert observability without a real sink. */
function recordingLogger(): { logger: Logger; lines: string[] } {
    const lines: string[] = [];
    const make = (): Logger => ({
        trace: (msg) => lines.push(`trace:${msg}`),
        debug: (msg) => lines.push(`debug:${msg}`),
        info: (msg) => lines.push(`info:${msg}`),
        warn: (msg) => lines.push(`warn:${msg}`),
        error: (msg) => lines.push(`error:${msg}`),
        fatal: (msg) => lines.push(`fatal:${msg}`),
        // child() must preserve the same sink so run-scoped context still records.
        child: () => make(),
    });
    return { logger: make(), lines };
}

describe('RunLifecycle.run', () => {
    test('persists create→enter→transition→done in order for a successful run', async () => {
        // WHY: both drivers depend on this exact sequence; the ordering is the
        // lifecycle's contract, previously duplicated and unenforced across drivers.
        const { adapter, calls } = recordingPersistence();
        const result = await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter },
            { runId: 'r1' },
            async (lifecycle) => {
                await lifecycle.enter('a', 0);
                await lifecycle.recordTransition('a', 'b', 'go');
                await lifecycle.enter('b', 1);
                return lifecycle.done('b', 1);
            },
        );

        expect(calls).toEqual([
            'createRun:r1:running',
            'saveWorkflowState:a',
            'savePhase:a:running',
            'saveTransition:a->b:go',
            'saveWorkflowState:b',
            'savePhase:b:running',
            'savePhase:b:done',
            'finalizeRun:done',
        ]);
        expect(result).toEqual({
            runId: 'r1',
            workflowName: 'wf',
            mode: 'state-machine',
            status: 'done',
            finalState: 'b',
            transitionsTaken: 1,
        });
    });

    test('fail() finalizes as failed and carries the reason', async () => {
        const { adapter, calls } = recordingPersistence();
        const result = await RunLifecycle.run(
            'wf',
            'transition-flow',
            { persistence: adapter },
            { runId: 'r2' },
            async (lifecycle) => {
                await lifecycle.enter('start', 0);
                return lifecycle.fail('start', 0, 'no-passing-edge');
            },
        );

        expect(calls).toContain('savePhase:start:failed');
        expect(calls).toContain('finalizeRun:failed');
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('no-passing-edge');
        // A successful result must never carry a reason; a failed one always does.
        expect('reason' in result).toBe(true);
    });

    test('done() result omits the reason field entirely', async () => {
        const { adapter } = recordingPersistence();
        const result = await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter },
            { runId: 'r3' },
            async (lifecycle) => lifecycle.done('end', 0),
        );
        expect('reason' in result).toBe(false);
    });

    test('generates a run id when options.runId is absent', async () => {
        const { adapter } = recordingPersistence();
        const result = await RunLifecycle.run('wf', 'state-machine', { persistence: adapter }, {}, async (lifecycle) =>
            lifecycle.done('end', 0),
        );
        expect(result.runId).toMatch(/^[0-9a-f-]{36}$/);
    });

    test('emits start/done observability through an injected logger', async () => {
        const { adapter } = recordingPersistence();
        const { logger, lines } = recordingLogger();
        await RunLifecycle.run('wf', 'state-machine', { persistence: adapter, logger }, { runId: 'r4' }, async (lc) =>
            lc.done('end', 0),
        );
        expect(lines).toContain('info:workflow run started');
        expect(lines).toContain('info:workflow run done');
    });

    test('emits a failure warning through an injected logger', async () => {
        const { adapter } = recordingPersistence();
        const { logger, lines } = recordingLogger();
        await RunLifecycle.run('wf', 'state-machine', { persistence: adapter, logger }, { runId: 'r5' }, async (lc) =>
            lc.fail('end', 0, 'boom'),
        );
        expect(lines).toContain('warn:workflow run failed');
    });

    test('emits lifecycle events through an injected event bus', async () => {
        const { adapter } = recordingPersistence();
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.run.started', (data) => seen.push(`run.started:${data.workflowName}:${data.runId}`));
        events.on('workflow.node.enter', (data) => seen.push(`node.enter:${data.node}:${data.transitionsTaken}`));
        events.on('workflow.node.transition', (data) =>
            seen.push(`node.transition:${data.from}->${data.to}:${data.trigger}`),
        );
        events.on('workflow.run.done', (data) => seen.push(`run.done:${data.finalState}:${data.transitionsTaken}`));

        await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter, events },
            { runId: 'r-events' },
            async (lc) => {
                await lc.enter('a', 0);
                await lc.recordTransition('a', 'b', 'go');
                return lc.done('b', 1);
            },
        );

        expect(seen).toEqual(['run.started:wf:r-events', 'node.enter:a:0', 'node.transition:a->b:go', 'run.done:b:1']);
    });

    test('emits failed and action failed-continue events through an injected event bus', async () => {
        const { adapter } = recordingPersistence();
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.action.failed_continue', (data) =>
            seen.push(`action.failed_continue:${data.node}:${data.transitionsTaken}:${data.error}`),
        );
        events.on('workflow.run.failed', (data) => seen.push(`run.failed:${data.finalState}:${data.reason}`));

        await RunLifecycle.run(
            'wf',
            'transition-flow',
            { persistence: adapter, events },
            { runId: 'r-failed' },
            async (lc) => {
                lc.warnActionFailed('start', 0, 'soft');
                return lc.fail('start', 0, 'hard');
            },
        );

        expect(seen).toEqual(['action.failed_continue:start:0:soft', 'run.failed:start:hard']);
    });
});

describe('runtime builtins single source', () => {
    test('runtimeBuiltins keys match RUNTIME_BUILTIN_KEYS exactly', () => {
        // WHY: config.ts validates references against RUNTIME_BUILTIN_KEYS; if the
        // producer drifts, a valid reference gets rejected (or an invalid one passes).
        const builtins = runtimeBuiltins('wf', 'node1', 'run1', 3, 'state-machine');
        expect(Object.keys(builtins).sort()).toEqual([...RUNTIME_BUILTIN_KEYS].sort());
    });

    test('runtime builtin carries the mode as the runtime namespace value', () => {
        for (const mode of ['state-machine', 'transition-flow'] as WorkflowMode[]) {
            expect(runtimeBuiltins('wf', 'n', 'r', 0, mode).runtime).toBe(mode);
        }
    });
});

describe('allowedEnv', () => {
    test('projects only allowlisted names and drops unset ones', () => {
        const env = allowedEnv(['KEEP', 'MISSING'], { KEEP: 'yes', OTHER: 'no' });
        expect(env).toEqual({ KEEP: 'yes' });
    });

    test('returns empty object for an empty allowlist', () => {
        expect(allowedEnv([], { ANY: 'value' })).toEqual({});
    });
});
