import { describe, expect, test } from 'bun:test';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { createDefaultWorkflowEngineHost, type WorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { ActionResult, ActionRunContext, ActionRunner, StateMachineWorkflowDef } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

/**
 * Action that sets `__hitlAnswer` into run vars. Simulates the idea-pipeline's
 * paused-state onEnter that captures an operator decision before pause.
 */
class SetHitlAnswerAction implements ActionRunner {
    readonly kind = 'set-hitl-answer';
    constructor(private readonly value: string) {}
    async execute(_options: Record<string, unknown>, _context: ActionRunContext): Promise<ActionResult> {
        return { ok: true, setVars: { __hitlAnswer: this.value } };
    }
}

/**
 * Action that records the `__hitlAnswer` it observes at execution time by
 * emitting it through `setVars` under a new key, so the test can assert what
 * the resumed run actually saw.
 */
class CaptureSeenAnswerAction implements ActionRunner {
    readonly kind = 'capture-seen-answer';
    constructor(private readonly sink: { seen: string | undefined }) {}
    async execute(_options: Record<string, unknown>, context: ActionRunContext): Promise<ActionResult> {
        this.sink.seen = context.vars.__hitlAnswer;
        return { ok: true };
    }
}

function hitlWorkflow(): StateMachineWorkflowDef {
    return {
        name: 'hitl-vars',
        initialState: 'ask',
        states: [
            { id: 'ask' },
            {
                id: 'review',
                pause: true,
                onEnter: [{ kind: 'set-hitl-answer', options: { value: 'approved-by-operator' } }],
            },
            {
                id: 'record',
                onEnter: [{ kind: 'capture-seen-answer', options: {} }],
            },
            { id: 'done' },
        ],
        transitions: [
            { from: 'ask', to: 'review', trigger: 'submit' },
            { from: 'review', to: 'record', trigger: 'continue' },
            { from: 'record', to: 'done', trigger: 'finish' },
        ],
    };
}

function buildHost(sink: { seen: string | undefined }, answer: string): WorkflowEngineHost {
    const host = createDefaultWorkflowEngineHost();
    host.registerAction(new SetHitlAnswerAction(answer));
    host.registerAction(new CaptureSeenAnswerAction(sink));
    return host;
}

describe('Pause/resume effectiveVars persistence (0366 R1/R2/R3/R11)', () => {
    test('persists effectiveVars in the paused state snapshot', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const host = buildHost({ seen: undefined }, 'approved-by-operator');
        const service = new WorkflowService(host, persistence);

        await service.run(hitlWorkflow(), { runId: 'persist-vars' });

        const snapshot = await persistence.loadLatestStateSnapshot('persist-vars');
        expect(snapshot).toBeDefined();
        expect(snapshot?.state).toBe('review');
        expect(snapshot?.data.effectiveVars).toMatchObject({ __hitlAnswer: 'approved-by-operator' });
    });

    test('restores effectiveVars on resume so downstream actions see them (state machine)', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const sink: { seen: string | undefined } = { seen: undefined };
        const host = buildHost(sink, 'approved-by-operator');
        const service = new WorkflowService(host, persistence);

        await service.run(hitlWorkflow(), { runId: 'restore-vars' });
        // The paused state's onEnter set __hitlAnswer; resume must propagate it.
        const resumed = await service.resumeRun(hitlWorkflow(), 'restore-vars');

        expect(resumed.status).toBe('done');
        expect(resumed.finalState).toBe('done');
        expect(sink.seen).toBe('approved-by-operator');
    });

    test('caller-provided vars override persisted effectiveVars on resume', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const sink: { seen: string | undefined } = { seen: undefined };
        const host = buildHost(sink, 'approved-by-operator');
        const service = new WorkflowService(host, persistence);

        await service.run(hitlWorkflow(), { runId: 'override-vars' });
        const resumed = await service.resumeRun(hitlWorkflow(), 'override-vars', {
            vars: { __hitlAnswer: 'overridden' },
        });

        expect(resumed.status).toBe('done');
        expect(sink.seen).toBe('overridden');
    });

    test('resumes cleanly when the persisted snapshot predates effectiveVars (backward compat)', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const sink: { seen: string | undefined } = { seen: undefined };
        const host = buildHost(sink, 'approved-by-operator');
        const service = new WorkflowService(host, persistence);

        await service.run(hitlWorkflow(), { runId: 'legacy-snapshot' });

        // Simulate a legacy snapshot by overwriting the data payload without effectiveVars.
        await persistence.saveWorkflowState('legacy-snapshot', 'review', { transitionsTaken: 1 });

        const snapshot = await persistence.loadLatestStateSnapshot('legacy-snapshot');
        expect(snapshot?.data.effectiveVars).toBeUndefined();

        const resumed = await service.resumeRun(hitlWorkflow(), 'legacy-snapshot');
        expect(resumed.status).toBe('done');
        // No persisted vars and no caller override → downstream sees undefined.
        expect(sink.seen).toBeUndefined();
    });
});
