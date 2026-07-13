import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createDbAdapter, type DbAdapter } from '@gobing-ai/ts-db';
import { EventBus } from '@gobing-ai/ts-infra';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import type { WorkflowEngineEvents } from '../src/events';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import { DbWorkflowPersistenceAdapter, MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { GuardContext, GuardRunner, StateMachineWorkflowDef, WorkflowRunRecord } from '../src/types';

function makeRecord(overrides: Partial<WorkflowRunRecord> = {}): WorkflowRunRecord {
    return {
        id: crypto.randomUUID(),
        workflow_name: 'test-wf',
        mode: 'state-machine',
        status: 'running',
        started_at: new Date().toISOString(),
        completed_at: null,
        metadata_json: '{}',
        ...overrides,
    };
}

function workflowWithGuards(): StateMachineWorkflowDef {
    return {
        name: 'test-wf',
        initialState: 'start',
        terminalStates: ['done'],
        states: [{ id: 'start' }, { id: 'review' }, { id: 'done' }],
        transitions: [
            {
                from: 'start',
                to: 'review',
                trigger: 'submit',
                guard: { kind: 'allow-if-reviewed', options: { flag: 'yes' } },
            },
            { from: 'start', to: 'done', trigger: 'fast-track' },
            { from: 'review', to: 'done', trigger: 'approve' },
        ],
    };
}

/** Guard that passes when options.flag === 'yes'. */
class FlagGuardRunner implements GuardRunner {
    readonly kind = 'allow-if-reviewed';
    async evaluate(options: Record<string, unknown>, _context: GuardContext): Promise<boolean> {
        return options.flag === 'yes';
    }
}

class FakeShellExecutor implements ProcessExecutor {
    async run(options: ProcessOptions): Promise<ProcessResult> {
        const line = options.command === '/bin/sh' ? (options.args?.[1] ?? '') : options.command;
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: line.includes('fail') ? 7 : 0,
            stdout: `stdout:${line}`,
            stderr: `stderr:${line}`,
            durationMs: 1,
        };
    }

    runStreaming(): never {
        throw new Error('FakeShellExecutor.runStreaming not implemented');
    }
}

// ─── Memory adapter tests ─────────────────────────────────────────────

describe('requestTransition — Memory adapter', () => {
    const adapter = new MemoryWorkflowPersistenceAdapter();
    const host = createDefaultWorkflowEngineHost();
    const service = new WorkflowService(host, adapter);

    test('allows a valid transition with no guard', async () => {
        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'r1' });
        await adapter.createRun(record);
        // Simulate the run being in 'start' state.
        await adapter.saveWorkflowState('r1', 'start', {});

        const result = await service.requestTransition(wf, 'r1', 'done');
        expect(result.allowed).toBe(true);
        if (result.allowed) {
            expect(result.fromState).toBe('start');
            expect(result.toState).toBe('done');
        }
    });

    test('denies when no transition exists between states', async () => {
        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'r2' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('r2', 'done', {});

        const result = await service.requestTransition(wf, 'r2', 'start');
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('no-such-transition');
            expect(result.detail).toContain('done');
            expect(result.detail).toContain('start');
        }
    });

    test('denies when guard fails', async () => {
        const hostWithGuard = new WorkflowEngineHost();
        hostWithGuard.registerGuard(new FlagGuardRunner());
        const svc = new WorkflowService(hostWithGuard, adapter);

        // Guard will fail because options.flag is 'no' (not 'yes').
        const wf: StateMachineWorkflowDef = {
            name: 'test-wf',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'review' }],
            transitions: [
                {
                    from: 'start',
                    to: 'review',
                    trigger: 'submit',
                    guard: { kind: 'allow-if-reviewed', options: { flag: 'no' } },
                },
            ],
        };
        const record = makeRecord({ id: 'r3' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('r3', 'start', {});

        const result = await svc.requestTransition(wf, 'r3', 'review');
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('guard-failed');
            expect(result.guardKind).toBe('allow-if-reviewed');
        }
    });

    test('denies with shell guard output report and does not mutate state', async () => {
        const svc = new WorkflowService(
            createDefaultWorkflowEngineHost({ processExecutor: new FakeShellExecutor() }),
            adapter,
        );
        const wf: StateMachineWorkflowDef = {
            name: 'test-wf',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'done' }],
            transitions: [
                {
                    from: 'start',
                    to: 'done',
                    trigger: 'go',
                    guard: { kind: 'shell', options: { command: 'please fail' } },
                },
            ],
        };
        await adapter.createRun(makeRecord({ id: 'r-shell' }));
        await adapter.saveWorkflowState('r-shell', 'start', {});
        const before = adapter.transitions.length;

        const result = await svc.requestTransition(wf, 'r-shell', 'done');

        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('guard-failed');
            expect(result.guardKind).toBe('shell');
            expect(result.guardReport).toEqual({
                stdout: 'stdout:please fail',
                stderr: 'stderr:please fail',
                exitCode: 7,
            });
        }
        expect(adapter.transitions.length).toBe(before);
        expect(await adapter.loadCurrentState('r-shell')).toBe('start');
    });

    test('allows when guard passes', async () => {
        const hostWithGuard = new WorkflowEngineHost();
        hostWithGuard.registerGuard(new FlagGuardRunner());
        const svc = new WorkflowService(hostWithGuard, adapter);

        const wf: StateMachineWorkflowDef = {
            name: 'test-wf',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'done' }],
            transitions: [
                {
                    from: 'start',
                    to: 'done',
                    trigger: 'go',
                    guard: { kind: 'allow-if-reviewed', options: { flag: 'yes' } },
                },
            ],
        };
        const record = makeRecord({ id: 'r4' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('r4', 'start', {});

        const result = await svc.requestTransition(wf, 'r4', 'done');
        expect(result.allowed).toBe(true);
    });

    test('denies when run has no recorded state', async () => {
        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'r5' });
        await adapter.createRun(record);
        // No saveWorkflowState call — run has no current state.

        const result = await service.requestTransition(wf, 'r5', 'done');
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('no-such-transition');
        }
    });

    test('persists transition and state on success', async () => {
        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'r6' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('r6', 'start', {});

        await service.requestTransition(wf, 'r6', 'done');

        const tx = adapter.transitions.find((t) => t.runId === 'r6' && t.to === 'done');
        expect(tx).toBeDefined();
        expect(tx?.from).toBe('start');
        expect(tx?.trigger).toBe('fast-track');

        const stateEntry = adapter.states.findLast((s) => s.runId === 'r6');
        expect(stateEntry?.state).toBe('done');
    });

    test('does not mutate state on denial', async () => {
        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'r7' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('r7', 'start', {});

        const before = adapter.transitions.length;
        // start → review requires a guard; request a nonexistent transition instead.
        const result = await service.requestTransition(wf, 'r7', 'nonexistent');
        expect(result.allowed).toBe(false);
        expect(adapter.transitions.length).toBe(before);
    });

    test('emits transition.requested event on success', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.node.transition', (d) => seen.push(`node:${d.from}->${d.to}:${d.trigger}`));
        events.on('workflow.transition.requested', (d) => seen.push(`requested:${d.from}->${d.to}`));

        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'r8' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('r8', 'start', {});

        await service.requestTransition(wf, 'r8', 'done', { events });
        expect(seen).toEqual(['node:start->done:fast-track', 'requested:start->done']);
    });

    test('emits transition.denied event on denial', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.transition.denied', (d) => seen.push(`denied:${d.from}->${d.to}:${d.reason}`));

        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'r9' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('r9', 'done', {});

        await service.requestTransition(wf, 'r9', 'start', { events });
        expect(seen).toEqual(['denied:done->start:no-such-transition']);
    });

    test('emits guard evaluation with externalKey for attached request transitions', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: Array<{ from: string; to: string; kind: string; passed: boolean; externalKey?: string }> = [];
        events.on('workflow.guard.evaluated', (d) =>
            seen.push({
                from: d.from,
                to: d.to,
                kind: d.kind,
                passed: d.passed,
                externalKey: d.externalKey,
            }),
        );

        const hostWithGuard = new WorkflowEngineHost();
        hostWithGuard.registerGuard(new FlagGuardRunner());
        const svc = new WorkflowService(hostWithGuard, adapter);
        await adapter.createRun(makeRecord({ id: 'e4-guard-allow', external_key: 'entity/e4-allow' }));
        await adapter.saveWorkflowState('e4-guard-allow', 'start', {});

        const result = await svc.requestTransition(workflowWithGuards(), 'e4-guard-allow', 'review', { events });

        expect(result.allowed).toBe(true);
        expect(seen).toEqual([
            {
                from: 'start',
                to: 'review',
                kind: 'allow-if-reviewed',
                passed: true,
                externalKey: 'entity/e4-allow',
            },
        ]);
    });

    test('emits guard failure and denial with externalKey for attached request transitions', async () => {
        const events = new EventBus<WorkflowEngineEvents>();
        const seen: string[] = [];
        events.on('workflow.guard.evaluated', (d) =>
            seen.push(`guard:${d.from}->${d.to}:${d.kind}:${d.passed}:${d.externalKey ?? ''}`),
        );
        events.on('workflow.transition.denied', (d) =>
            seen.push(`denied:${d.from}->${d.to}:${d.reason}:${d.externalKey ?? ''}`),
        );

        const hostWithGuard = new WorkflowEngineHost();
        hostWithGuard.registerGuard(new FlagGuardRunner());
        const svc = new WorkflowService(hostWithGuard, adapter);
        const wf: StateMachineWorkflowDef = {
            name: 'test-wf',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'review' }],
            transitions: [
                {
                    from: 'start',
                    to: 'review',
                    trigger: 'submit',
                    guard: { kind: 'allow-if-reviewed', options: { flag: 'no' } },
                },
            ],
        };
        await adapter.createRun(makeRecord({ id: 'e4-guard-deny', external_key: 'entity/e4-deny' }));
        await adapter.saveWorkflowState('e4-guard-deny', 'start', {});

        const result = await svc.requestTransition(wf, 'e4-guard-deny', 'review', { events });

        expect(result.allowed).toBe(false);
        expect(seen).toEqual([
            'guard:start->review:allow-if-reviewed:false:entity/e4-deny',
            'denied:start->review:guard-failed:entity/e4-deny',
        ]);
    });
});

// ─── Concurrency serialization tests ──────────────────────────────────

describe('requestTransition — concurrency', () => {
    const adapter = new MemoryWorkflowPersistenceAdapter();
    const host = createDefaultWorkflowEngineHost();
    const service = new WorkflowService(host, adapter);

    const wf: StateMachineWorkflowDef = {
        name: 'test-wf',
        initialState: 'start',
        terminalStates: ['done'],
        states: [{ id: 'start' }, { id: 'middle' }, { id: 'done' }],
        transitions: [
            { from: 'start', to: 'middle', trigger: 'step1' },
            { from: 'middle', to: 'done', trigger: 'step2' },
        ],
    };

    test('serializes concurrent requests — loser re-evaluates against new state', async () => {
        const record = makeRecord({ id: 'concurrent-r1' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('concurrent-r1', 'start', {});

        // Fire two requests simultaneously, both trying start → middle.
        // The winner moves the state to 'middle'; the loser re-evaluates
        // against 'middle' and finds no transition middle → middle, so it denies.
        const [a, b] = await Promise.all([
            service.requestTransition(wf, 'concurrent-r1', 'middle'),
            service.requestTransition(wf, 'concurrent-r1', 'middle'),
        ]);

        // Exactly one should succeed, the other should fail.
        const allowed = [a, b].filter((r) => r.allowed);
        const denied = [a, b].filter((r) => !r.allowed);
        expect(allowed.length).toBe(1);
        expect(denied.length).toBe(1);
        if (denied[0] && !denied[0].allowed) {
            expect(denied[0].reason).toBe('no-such-transition');
        }
    });

    test('serialized winner moves state — second request sees new state', async () => {
        const record = makeRecord({ id: 'concurrent-r2' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('concurrent-r2', 'start', {});

        // First: start→middle succeeds
        const first = await service.requestTransition(wf, 'concurrent-r2', 'middle');
        expect(first.allowed).toBe(true);

        // Second: middle→done succeeds (now sees the new state)
        const second = await service.requestTransition(wf, 'concurrent-r2', 'done');
        expect(second.allowed).toBe(true);
        if (second.allowed) {
            expect(second.fromState).toBe('middle');
            expect(second.toState).toBe('done');
        }
    });
});

// ─── DB adapter tests ─────────────────────────────────────────────────

describe('requestTransition — DB adapter', () => {
    let db: DbAdapter;
    let adapter: DbWorkflowPersistenceAdapter;
    let service: WorkflowService;

    beforeEach(async () => {
        db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        adapter = new DbWorkflowPersistenceAdapter(db);
        service = new WorkflowService(createDefaultWorkflowEngineHost(), adapter);
    });

    afterEach(() => {
        db.close();
    });

    test('allows a valid transition and persists', async () => {
        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'db-r1' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('db-r1', 'start', {});

        const result = await service.requestTransition(wf, 'db-r1', 'done');
        expect(result.allowed).toBe(true);
        if (result.allowed) {
            expect(result.fromState).toBe('start');
            expect(result.toState).toBe('done');
        }

        // Verify persistence
        const transitions = await db.queryAll<{ from_state: string; to_state: string; trigger: string | null }>(
            'SELECT from_state, to_state, trigger FROM transition_runs WHERE run_id = ?',
            'db-r1',
        );
        expect(transitions.length).toBe(1);
        expect(transitions[0]?.from_state).toBe('start');
        expect(transitions[0]?.to_state).toBe('done');
    });

    test('denies when no transition exists', async () => {
        const wf = workflowWithGuards();
        const record = makeRecord({ id: 'db-r2' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('db-r2', 'done', {});

        const result = await service.requestTransition(wf, 'db-r2', 'start');
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('no-such-transition');
        }

        // Verify no transition persisted
        const transitions = await db.queryAll('SELECT * FROM transition_runs WHERE run_id = ?', 'db-r2');
        expect(transitions.length).toBe(0);
    });

    test('denies when guard fails and does not persist', async () => {
        const hostWithGuard = new WorkflowEngineHost();
        hostWithGuard.registerGuard(new FlagGuardRunner());
        const svc = new WorkflowService(hostWithGuard, adapter);

        // Guard will fail because options.flag is 'no'.
        const wf: StateMachineWorkflowDef = {
            name: 'test-wf',
            initialState: 'start',
            terminalStates: ['done'],
            states: [{ id: 'start' }, { id: 'review' }],
            transitions: [
                {
                    from: 'start',
                    to: 'review',
                    trigger: 'submit',
                    guard: { kind: 'allow-if-reviewed', options: { flag: 'no' } },
                },
            ],
        };
        const record = makeRecord({ id: 'db-r3' });
        await adapter.createRun(record);
        await adapter.saveWorkflowState('db-r3', 'start', {});

        const result = await svc.requestTransition(wf, 'db-r3', 'review');
        expect(result.allowed).toBe(false);
        if (!result.allowed) {
            expect(result.reason).toBe('guard-failed');
        }

        const transitions = await db.queryAll('SELECT * FROM transition_runs WHERE run_id = ?', 'db-r3');
        expect(transitions.length).toBe(0);
    });
});
