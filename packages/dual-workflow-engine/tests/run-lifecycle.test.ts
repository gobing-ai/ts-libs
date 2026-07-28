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
        commitTransition: async (runId, from, to, trigger, state, data, phase) => {
            calls.push(
                `commitTransition:${from}->${to}:${trigger ?? 'null'}:${state}${phase ? `:${phase.phase}:${phase.status}` : ''}`,
            );
            return inner.commitTransition(runId, from, to, trigger, state, data, phase);
        },
        saveActionStart: async (runId, node, kind) => {
            calls.push(`saveActionStart:${node}:${kind}`);
            return inner.saveActionStart(runId, node, kind);
        },
        saveActionFinalize: async (actionId, status, durationMs, ok, result, redactor) => {
            calls.push(`saveActionFinalize:${actionId}:${status}`);
            return inner.saveActionFinalize(actionId, status, durationMs, ok, result, redactor);
        },
        loadRun: async (runId) => inner.loadRun(runId),
        listRuns: async () => inner.listRuns(),
        findRunByKey: async (workflowName, externalKey) => inner.findRunByKey(workflowName, externalKey),
        createOrAttachRun: async (record) => {
            calls.push(`createOrAttachRun:${record.external_key ?? 'none'}`);
            return inner.createOrAttachRun(record);
        },
        reseedRun: async (runId, newState) => {
            calls.push(`reseedRun:${runId}:${newState}`);
            return inner.reseedRun(runId, newState);
        },
        loadCurrentState: async (runId) => inner.loadCurrentState(runId),
        loadLatestStateSnapshot: async (runId) => inner.loadLatestStateSnapshot(runId),
        listPausedRuns: async (options) => inner.listPausedRuns(options),
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
    test('persists create→enter→commitHop→done in order for a successful run', async () => {
        // WHY: both drivers depend on this exact sequence; the ordering is the
        // lifecycle's contract, previously duplicated and unenforced across drivers.
        // commitHop replaces the old recordTransition+enter pair with a single
        // atomic batch (ADR-020), so enter(state, tt, false) is observe-only after
        // the hop already persisted the state snapshot + phase.
        const { adapter, calls } = recordingPersistence();
        const result = await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter },
            { runId: 'r1' },
            async (lifecycle) => {
                await lifecycle.enter('a', 0);
                await lifecycle.commitHop('a', 'b', 'go', 1, { phase: 'b', status: 'running' });
                await lifecycle.enter('b', 1, false);
                return lifecycle.done('b', 1);
            },
        );

        expect(calls).toEqual([
            'createRun:r1:running',
            'saveWorkflowState:a',
            'savePhase:a:running',
            'commitTransition:a->b:go:b:b:running',
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

    test('enter(persist=false) emits observability but skips saveWorkflowState + savePhase', async () => {
        // WHY: after commitHop atomically persisted the state snapshot + phase, the
        // next enter() must NOT re-persist — that would create duplicate INSERT rows.
        // It must still emit the span event + EventBus so observability stays correct.
        const { adapter, calls } = recordingPersistence();
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.node.enter', (d) => seen.push(`enter:${d.node}:${d.transitionsTaken}`));

        await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter, events },
            { runId: 'r-persist' },
            async (lifecycle) => {
                await lifecycle.enter('a', 0); // persist=true (default)
                await lifecycle.enter('b', 1, false); // persist=false
                return lifecycle.done('b', 1);
            },
        );

        // First enter persists state 'a' + phase 'a:running'.
        // Second enter (persist=false) must NOT add saveWorkflowState:b or savePhase:b:running.
        expect(calls).toContain('saveWorkflowState:a');
        expect(calls).not.toContain('saveWorkflowState:b');
        // Both enters emit observability.
        expect(seen).toEqual(['enter:a:0', 'enter:b:1']);
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

    test('uses create-or-attach semantics when an external key is supplied', async () => {
        const { adapter, calls } = recordingPersistence();
        const result = await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter },
            { runId: 'r-keyed', externalKey: 'task:0042' },
            async (lifecycle) => lifecycle.done('end', 0),
        );

        expect(calls[0]).toBe('createOrAttachRun:task:0042');
        expect(calls).not.toContain('createRun:r-keyed:running');
        expect(result.runId).toBe('r-keyed');
    });

    test('attached external-key run uses the existing run id', async () => {
        const inner = new MemoryWorkflowPersistenceAdapter();
        await inner.createRun({
            id: 'existing',
            workflow_name: 'wf',
            mode: 'state-machine',
            status: 'running',
            started_at: new Date().toISOString(),
            completed_at: null,
            metadata_json: '{}',
            external_key: 'task:0042',
        });
        const result = await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: inner },
            { runId: 'new-attempt', externalKey: 'task:0042' },
            async (lifecycle) => lifecycle.done('end', 0),
        );

        expect(result.runId).toBe('existing');
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

describe('RunLifecycle — E4 event seam parity (fresh vs attached)', () => {
    /**
     * Collects all seam event payloads from a run, capturing the order they fire
     * and the externalKey presence in each payload.
     */
    function collectSeamEvents(events: EventBus<WorkflowEngineEvents>) {
        const sequence: Array<{ event: string; hasExternalKey: boolean; externalKey: unknown }> = [];
        const push = (event: string) => (data: Record<string, unknown>) => {
            sequence.push({
                event,
                hasExternalKey: 'externalKey' in data,
                externalKey: (data as Record<string, unknown>).externalKey,
            });
        };
        events.on('workflow.run.started', push('workflow.run.started'));
        events.on('workflow.node.transition', push('workflow.node.transition'));
        events.on('workflow.guard.evaluated', push('workflow.guard.evaluated'));
        events.on('workflow.run.done', push('workflow.run.done'));
        events.on('workflow.run.paused', push('workflow.run.paused'));
        events.on('workflow.run.resumed', push('workflow.run.resumed'));
        events.on('workflow.run.failed', push('workflow.run.failed'));
        events.on('workflow.transition.requested', push('workflow.transition.requested'));
        events.on('workflow.transition.denied', push('workflow.transition.denied'));
        return sequence;
    }

    test('externalKey is present in seam event payloads for a fresh run with externalKey', async () => {
        // WHY: R2 — subscribers must map events to their own entities without extra lookups
        const { adapter } = recordingPersistence();
        const events = new EventBus<WorkflowEngineEvents>();
        const sequence = collectSeamEvents(events);

        await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter, events },
            { runId: 'r-key', externalKey: 'org/42' },
            async (lifecycle) => {
                await lifecycle.enter('start', 0);
                lifecycle.guardEvaluated('start', 'end', 'always', true);
                await lifecycle.recordTransition('start', 'end', null);
                return lifecycle.done('end', 1);
            },
        );

        // Every seam event that fired should carry the externalKey.
        for (const entry of sequence) {
            expect(entry.hasExternalKey).toBe(true);
            expect(entry.externalKey).toBe('org/42');
        }
        expect(sequence.length).toBeGreaterThan(0);
    });

    test('externalKey is undefined in seam event payloads when not provided', async () => {
        // WHY: externalKey is optional — events must still fire without it
        const { adapter } = recordingPersistence();
        const events = new EventBus<WorkflowEngineEvents>();
        const sequence = collectSeamEvents(events);

        await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter, events },
            { runId: 'r-nokey' },
            async (lifecycle) => {
                await lifecycle.enter('start', 0);
                lifecycle.guardEvaluated('start', 'end', 'always', true);
                await lifecycle.recordTransition('start', 'end', null);
                return lifecycle.done('end', 1);
            },
        );

        for (const entry of sequence) {
            expect(entry.hasExternalKey).toBe(true);
            expect(entry.externalKey).toBeUndefined();
        }
        expect(sequence.length).toBeGreaterThan(0);
    });

    test('fresh and attached runs produce identical event sequences', async () => {
        // WHY: R1, R4 — event seam must behave identically for fresh vs rehydrated runs
        const adapter = new MemoryWorkflowPersistenceAdapter();

        // -- Fresh run --
        const freshEvents = new EventBus<WorkflowEngineEvents>();
        const freshSeq = collectSeamEvents(freshEvents);
        await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter, events: freshEvents },
            { runId: 'r-fresh', externalKey: 'entity/1' },
            async (lifecycle) => {
                await lifecycle.enter('start', 0);
                lifecycle.guardEvaluated('start', 'mid', 'check', true);
                await lifecycle.recordTransition('start', 'mid', null);
                await lifecycle.enter('mid', 1);
                return lifecycle.done('mid', 1);
            },
        );

        // -- Attached run (simulates rehydration — different runId, same event shape) --
        const attachEvents = new EventBus<WorkflowEngineEvents>();
        const attachSeq = collectSeamEvents(attachEvents);
        await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter, events: attachEvents },
            { runId: 'r-attach', externalKey: 'entity/2' },
            async (lifecycle) => {
                await lifecycle.enter('start', 0);
                lifecycle.guardEvaluated('start', 'mid', 'check', true);
                await lifecycle.recordTransition('start', 'mid', null);
                await lifecycle.enter('mid', 1);
                return lifecycle.done('mid', 1);
            },
        );

        // Strip externalKey value (different runs have different keys); compare event names and key presence only.
        const normalize = (seq: typeof freshSeq) => seq.map(({ event, hasExternalKey }) => ({ event, hasExternalKey }));

        expect(normalize(freshSeq)).toEqual(normalize(attachSeq));
        expect(freshSeq.length).toBeGreaterThan(0);

        // Every entry in both sequences carries externalKey
        for (const entry of freshSeq) expect(entry.hasExternalKey).toBe(true);
        for (const entry of attachSeq) expect(entry.hasExternalKey).toBe(true);
    });

    test('pause and resume events carry externalKey', async () => {
        // WHY: R1 — pause/resume (E3) must also carry the externalKey
        const { adapter } = recordingPersistence();
        const events = new EventBus<WorkflowEngineEvents>();
        const sequence = collectSeamEvents(events);

        await RunLifecycle.run(
            'wf',
            'state-machine',
            { persistence: adapter, events },
            { runId: 'r-pause', externalKey: 'entity/pause' },
            async (lifecycle) => {
                await lifecycle.enter('start', 0);
                return lifecycle.pause('start', 0);
            },
        );

        const pausedEntry = sequence.find((e) => e.event === 'workflow.run.paused');
        expect(pausedEntry).toBeDefined();
        expect(pausedEntry?.hasExternalKey).toBe(true);
        expect(pausedEntry?.externalKey).toBe('entity/pause');
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

describe('RunLifecycle.forExternalTransition', () => {
    test('creates no run record — an external transition is a hop, not a run', () => {
        // WHY: the external-transition path attaches to an existing run. If it created a
        // record (or opened a workflow.run span) it would masquerade as a run in traces.
        const { adapter, calls } = recordingPersistence();
        RunLifecycle.forExternalTransition('wf', 'r1', { persistence: adapter }, undefined);
        expect(calls).toEqual([]);
    });

    test('recordTransition persists and emits node.transition carrying the external key', async () => {
        // WHY: WorkflowService.requestTransition reuses this seam so the transition
        // persist+emit lives in one place; the external key must survive the seam.
        const { adapter, calls } = recordingPersistence();
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.node.transition', (d) =>
            seen.push(`${d.from}->${d.to}:${d.trigger}:${d.externalKey ?? ''}`),
        );

        const lifecycle = RunLifecycle.forExternalTransition('wf', 'r1', { persistence: adapter, events }, 'entity/1');
        await lifecycle.recordTransition('start', 'done', 'fast-track');

        expect(calls).toEqual(['saveTransition:start->done:fast-track']);
        expect(seen).toEqual(['start->done:fast-track:entity/1']);
    });

    test('guardEvaluated emits with the external key for attached transitions', () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.guard.evaluated', (d) => seen.push(`${d.kind}:${d.passed}:${d.externalKey ?? ''}`));

        const lifecycle = RunLifecycle.forExternalTransition(
            'wf',
            'r1',
            { persistence: new MemoryWorkflowPersistenceAdapter(), events },
            'entity/9',
        );
        lifecycle.guardEvaluated('start', 'review', 'allow-if-reviewed', false);

        expect(seen).toEqual(['allow-if-reviewed:false:entity/9']);
    });
});
