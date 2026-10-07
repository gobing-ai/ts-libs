import { describe, expect, test } from 'bun:test';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { BranchStatus, DagWorkflowDef, Vars, WorkflowStatus } from '../src/types';

describe('DagDriver — ready-queue scheduling and execution (task 0100)', () => {
    test('executes diamond DAG with dependency ordering and concurrency', async () => {
        const events: string[] = [];
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'timed-step',
            async execute(options) {
                const id = String(options.id);
                events.push(`start:${id}`);
                await new Promise((r) => setTimeout(r, 25));
                events.push(`end:${id}`);
                return { ok: true, setVars: { [`var_${id}`]: `val_${id}` } };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        const diamond: DagWorkflowDef = {
            kind: 'dag',
            name: 'diamond-dag',
            nodes: [
                { id: 'start', action: { kind: 'timed-step', options: { id: 'start' } } },
                { id: 'left', dependsOn: ['start'], action: { kind: 'timed-step', options: { id: 'left' } } },
                { id: 'right', dependsOn: ['start'], action: { kind: 'timed-step', options: { id: 'right' } } },
                { id: 'join', dependsOn: ['left', 'right'], action: { kind: 'timed-step', options: { id: 'join' } } },
            ],
        };

        const result = await service.run(diamond);
        expect(result.status).toBe('done');
        expect(result.mode).toBe('dag');

        // start must finish before left and right start
        const endStart = events.indexOf('end:start');
        const startLeft = events.indexOf('start:left');
        const startRight = events.indexOf('start:right');
        expect(endStart).toBeLessThan(startLeft);
        expect(endStart).toBeLessThan(startRight);

        // left and right run concurrently (both start before either ends)
        const endLeft = events.indexOf('end:left');
        const endRight = events.indexOf('end:right');
        expect(startLeft).toBeLessThan(endRight);
        expect(startRight).toBeLessThan(endLeft);

        // join runs only after both left and right finish
        const startJoin = events.indexOf('start:join');
        expect(endLeft).toBeLessThan(startJoin);
        expect(endRight).toBeLessThan(startJoin);
    });

    test('propagates skips when upstream condition fails without deadlocking join', async () => {
        let leftRan = false;
        let rightRan = false;
        let joinRan = false;

        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'left-action',
                async execute() {
                    leftRan = true;
                    return { ok: true };
                },
            })
            .registerAction({
                kind: 'right-action',
                async execute() {
                    rightRan = true;
                    return { ok: true };
                },
            })
            .registerAction({
                kind: 'join-action',
                async execute() {
                    joinRan = true;
                    return { ok: true };
                },
            });

        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'skip-propagation-dag',
            nodes: [
                { id: 'root' },
                {
                    id: 'left',
                    dependsOn: ['root'],
                    condition: { kind: 'never' },
                    action: { kind: 'left-action' },
                },
                {
                    id: 'right',
                    dependsOn: ['root'],
                    condition: { kind: 'always' },
                    action: { kind: 'right-action' },
                },
                {
                    id: 'join',
                    dependsOn: ['left', 'right'],
                    action: { kind: 'join-action' },
                },
            ],
        };

        const result = await service.run(wf);
        expect(result.status).toBe('done');
        expect(leftRan).toBe(false); // skipped!
        expect(rightRan).toBe(true);
        expect(joinRan).toBe(true); // completed without deadlock!
    });

    test('pauses at node with pause: true and resumes cleanly', async () => {
        let afterPauseRan = false;
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'post-pause',
            async execute() {
                afterPauseRan = true;
                return { ok: true };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'pause-resume-dag',
            nodes: [
                { id: 'step1' },
                { id: 'step2', dependsOn: ['step1'], pause: true },
                { id: 'step3', dependsOn: ['step2'], action: { kind: 'post-pause' } },
            ],
        };

        const initial = await service.run(wf, { runId: 'dag-pause-1' });
        expect(initial.status).toBe('paused');
        expect(afterPauseRan).toBe(false);

        const resumed = await service.resumeRun(wf, 'dag-pause-1');
        expect(resumed.status).toBe('done');
        expect(afterPauseRan).toBe(true);
    });

    test('does not re-execute completed nodes on resume (task 0101)', async () => {
        const executions: Record<string, number> = {};
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'counted',
            async execute(options) {
                const id = String(options.id);
                executions[id] = (executions[id] ?? 0) + 1;
                return { ok: true };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'resume-no-replay',
            nodes: [
                { id: 'a', action: { kind: 'counted', options: { id: 'a' } } },
                { id: 'gate', dependsOn: ['a'], pause: true },
                { id: 'b', dependsOn: ['gate'], action: { kind: 'counted', options: { id: 'b' } } },
            ],
        };

        const initial = await service.run(wf, { runId: 'dag-replay-1' });
        expect(initial.status).toBe('paused');
        expect(executions.a).toBe(1);

        const resumed = await service.resumeRun(wf, 'dag-replay-1');
        expect(resumed.status).toBe('done');
        expect(executions).toEqual({ a: 1, b: 1 });
    });

    test('fails loudly when a resumed definition leaves a node unreachable (task 0101)', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(createDefaultWorkflowEngineHost(), persistence);

        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'unreachable-on-resume',
            nodes: [{ id: 'a' }, { id: 'gate', dependsOn: ['a'], pause: true }, { id: 'b', dependsOn: ['gate'] }],
        };
        const initial = await service.run(wf, { runId: 'dag-unreach-1' });
        expect(initial.status).toBe('paused');

        // Definition drift between pause and resume: b's dependency no longer exists.
        const drifted: DagWorkflowDef = {
            ...wf,
            nodes: [{ id: 'a' }, { id: 'gate', dependsOn: ['a'], pause: true }, { id: 'b', dependsOn: ['ghost'] }],
        };
        const resumed = await service.resumeRun(drifted, 'dag-unreach-1');
        expect(resumed.status).toBe('failed');
        expect(resumed.reason).toBe('dag-unreachable-nodes: b');
    });

    test('dependencyPolicy any dispatches on the first completed prerequisite', async () => {
        const events: string[] = [];
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'step',
            async execute(options) {
                const id = String(options.id);
                events.push(`start:${id}`);
                await new Promise((r) => setTimeout(r, 20));
                events.push(`end:${id}`);
                return { ok: true };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        // `consumer` depends on both `a` (settles in wave 1) and `slow` (depends on `a`).
        // Under 'any', one satisfied prerequisite is enough, so the consumer starts
        // before the slow sibling finishes. Under 'all' it would wait for both.
        const build = (policy: 'any' | 'all'): DagWorkflowDef => ({
            kind: 'dag',
            name: `${policy}-policy-dag`,
            nodes: [
                { id: 'a', action: { kind: 'step', options: { id: 'a' } } },
                { id: 'slow', dependsOn: ['a'], action: { kind: 'step', options: { id: 'slow' } } },
                {
                    id: 'consumer',
                    dependsOn: ['a', 'slow'],
                    dependencyPolicy: policy,
                    action: { kind: 'step', options: { id: 'consumer' } },
                },
            ],
        });

        expect((await service.run(build('any'))).status).toBe('done');
        const anyStart = events.indexOf('start:consumer');
        const anySlowEnd = events.indexOf('end:slow');
        expect(anyStart).toBeGreaterThan(events.indexOf('end:a'));
        expect(anyStart).toBeLessThan(anySlowEnd); // dispatched early, did not wait for `slow`

        events.length = 0;
        expect((await service.run(build('all'))).status).toBe('done');
        expect(events.indexOf('start:consumer')).toBeGreaterThan(events.indexOf('end:slow'));
    });

    test('fails the run when a node action fails and holds back its dependents', async () => {
        let dependentRan = false;
        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'failing',
                async execute() {
                    return { ok: false, error: 'boom' };
                },
            })
            .registerAction({
                kind: 'dependent',
                async execute() {
                    dependentRan = true;
                    return { ok: true };
                },
            });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'failed-dep-dag',
            nodes: [
                { id: 'failed-dep', action: { kind: 'failing' } },
                { id: 'dependent', dependsOn: ['failed-dep'], action: { kind: 'dependent' } },
            ],
        };

        const result = await service.run(wf);
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('boom');
        expect(dependentRan).toBe(false);
    });

    test('dryRun walks the DAG without executing actions', async () => {
        let ran = false;
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'tracked',
            async execute() {
                ran = true;
                return { ok: true };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'dry-run-dag',
            nodes: [
                { id: 'step1', action: { kind: 'tracked' } },
                { id: 'step2', dependsOn: ['step1'], action: { kind: 'tracked' } },
            ],
        };

        const result = await service.run(wf, { dryRun: true });
        expect(result.status).toBe('done');
        expect(ran).toBe(false);
    });
});

describe('DagDriver — wave-drain error barrier (task 0103)', () => {
    /** Records persistence call order while delegating to the real memory adapter. */
    class RecordingAdapter extends MemoryWorkflowPersistenceAdapter {
        readonly calls: string[] = [];
        /** Branch ids whose finalize write resolves to a rejection after logging. */
        rejectFinalizeFor?: (branchId: string, status: BranchStatus) => unknown;
        /** Branch ids whose finalize write is held until the returned promise resolves. */
        holdFinalizeFor?: (branchId: string, status: BranchStatus) => Promise<void> | undefined;
        /** When true, failed-run finalization is refused (fence-miss simulation). */
        failFailedFinalize = false;
        override async saveBranchStart(
            runId: string,
            parallelNode: string,
            branchId: string,
            startNode: string,
        ): Promise<string> {
            this.calls.push(`start:${branchId}`);
            return await super.saveBranchStart(runId, parallelNode, branchId, startNode);
        }
        override async saveBranchFinalize(
            runId: string,
            branchId: string,
            status: BranchStatus,
            durationMs: number,
            outputVars?: Vars,
            error?: string,
        ): Promise<void> {
            const hold = this.holdFinalizeFor?.(branchId, status);
            if (hold) await hold;
            this.calls.push(`finalize:${branchId}:${status}`);
            const rejection = this.rejectFinalizeFor?.(branchId, status);
            if (rejection !== undefined) throw rejection;
            await super.saveBranchFinalize(runId, branchId, status, durationMs, outputVars, error);
        }
        override async finalizeRun(
            runId: string,
            status: WorkflowStatus,
            completedAt: string,
            fence?: { readonly ownerAttempt: string },
            reason?: string,
        ): Promise<boolean> {
            this.calls.push(`finalizeRun:${status}`);
            if (status === 'failed' && this.failFailedFinalize) return false;
            return await super.finalizeRun(runId, status, completedAt, fence, reason);
        }
    }

    /** Bounded wait until every wanted persistence call has landed (floating settles). */
    const waitForCalls = async (adapter: RecordingAdapter, wanted: readonly string[]): Promise<void> => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline && !wanted.every((w) => adapter.calls.includes(w))) {
            await new Promise((r) => setTimeout(r, 5));
        }
    };

    test('drains the whole ready wave and settles sibling persistence before failing the run', async () => {
        // Node a rejects only after b and c have both started; b/c actions stay slow so
        // an early-rejecting barrier (Promise.all) would finalizeRun while b/c work is
        // still in flight and strand their persistence writes after the run closed.
        let started = 0;
        let bRan = false;
        let cRan = false;
        let lateRan = false;
        let releaseA: (() => void) | undefined;
        const aGate = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const boom = new Error('boom-from-a');

        const host = createDefaultWorkflowEngineHost()
            .registerGuard({
                kind: 'boom',
                evaluate: async () => {
                    await aGate;
                    throw boom;
                },
            })
            .registerAction({
                kind: 'slow-counter',
                async execute(options) {
                    const id = String(options.id);
                    if (id === 'b') bRan = true;
                    if (id === 'c') cRan = true;
                    started += 1;
                    if (started === 2) releaseA?.();
                    await new Promise((r) => setTimeout(r, 15));
                    return { ok: true };
                },
            })
            .registerAction({
                kind: 'late-action',
                async execute() {
                    lateRan = true;
                    return { ok: true };
                },
            });

        const persistence = new RecordingAdapter();
        const service = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'wave-drain-dag',
            nodes: [
                { id: 'root' },
                { id: 'a', dependsOn: ['root'], condition: { kind: 'boom' } },
                { id: 'b', dependsOn: ['root'], action: { kind: 'slow-counter', options: { id: 'b' } } },
                { id: 'c', dependsOn: ['root'], action: { kind: 'slow-counter', options: { id: 'c' } } },
                { id: 'late', dependsOn: ['b', 'c'], action: { kind: 'late-action' } },
            ],
        };

        const error = await service.run(wf).then(
            () => undefined,
            (e) => e,
        );
        // Single rejection reason rethrown unchanged (task 0103 R2/R3).
        expect(error).toBe(boom);
        // Started sibling work drained to completion (task 0103 R1).
        expect(bRan).toBe(true);
        expect(cRan).toBe(true);
        // No follow-up wave was dispatched after the rejection (task 0103 R4).
        expect(lateRan).toBe(false);
        // Wait for the sibling branch settles to land before asserting write order —
        // under an early-rejecting barrier they would land as floating promises.
        await waitForCalls(persistence, ['finalize:b:done', 'finalize:c:done']);
        // Sibling branch persistence settled before the run finalized as failed (task 0103 R1/AC2).
        expect(persistence.calls).toContain('start:b');
        expect(persistence.calls).toContain('start:c');
        const finalizedRunAt = persistence.calls.indexOf('finalizeRun:failed');
        expect(finalizedRunAt).toBeGreaterThan(-1);
        expect(persistence.calls.indexOf('finalize:b:done')).toBeLessThan(finalizedRunAt);
        expect(persistence.calls.indexOf('finalize:c:done')).toBeLessThan(finalizedRunAt);
    });

    test('drains admitted work when a persistence hook rejects, holding the run open until settle', async () => {
        // Node p's branch-finalize write rejects with the exact sentinel; node q's
        // branch-finalize write is held so the wave cannot settle until we release it.
        let lateRan = false;
        let releaseQ: (() => void) | undefined;
        const qGate = new Promise<void>((resolve) => {
            releaseQ = resolve;
        });
        const persistErr = new Error('branch-finalize-write-failed');

        const host = createDefaultWorkflowEngineHost()
            .registerAction({
                kind: 'noop-ok',
                async execute() {
                    return { ok: true };
                },
            })
            .registerAction({
                kind: 'late-action',
                async execute() {
                    lateRan = true;
                    return { ok: true };
                },
            });

        const persistence = new RecordingAdapter();
        persistence.rejectFinalizeFor = (branchId) => (branchId === 'p' ? persistErr : undefined);
        persistence.holdFinalizeFor = (branchId) => (branchId === 'q' ? qGate : undefined);
        const service = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'persist-reject-drain-dag',
            nodes: [
                { id: 'root' },
                { id: 'p', dependsOn: ['root'], action: { kind: 'noop-ok' } },
                { id: 'q', dependsOn: ['root'], action: { kind: 'noop-ok' } },
                { id: 'late', dependsOn: ['p', 'q'], action: { kind: 'late-action' } },
            ],
        };

        let settled = false;
        const runPromise = service.run(wf).then(
            () => {
                settled = true;
                return undefined as unknown;
            },
            (e) => {
                settled = true;
                return e as unknown;
            },
        );
        // Drain all pending microtasks while q's write is still held: the run must
        // stay pending. The gate (not this timer) is the ordering oracle — a timer is
        // only used so an early-rejecting barrier cannot hide behind tick counts.
        await new Promise((r) => setTimeout(r, 5));
        expect(settled).toBe(false);
        expect(persistence.calls).not.toContain('finalizeRun:failed');

        releaseQ?.();
        const error = await runPromise;
        // Exact original persistence rejection reason (task 0103 R2/R3).
        expect(error).toBe(persistErr);
        expect(lateRan).toBe(false);
        await waitForCalls(persistence, ['finalize:q:done']);
        // q's held write landed before the run finalized as failed.
        expect(persistence.calls.indexOf('finalize:q:done')).toBeLessThan(
            persistence.calls.indexOf('finalizeRun:failed'),
        );
    });

    test('resume path shares the drain barrier', async () => {
        let yRan = false;
        let lateRan = false;
        let releaseX: (() => void) | undefined;
        const xGate = new Promise<void>((resolve) => {
            releaseX = resolve;
        });
        const resumeBoom = new Error('resume-wave-sentinel');

        const host = createDefaultWorkflowEngineHost()
            .registerGuard({
                kind: 'boom-resume',
                evaluate: async () => {
                    await xGate;
                    throw resumeBoom;
                },
            })
            .registerAction({
                kind: 'y-slow',
                async execute() {
                    yRan = true;
                    releaseX?.();
                    await new Promise((r) => setTimeout(r, 15));
                    return { ok: true };
                },
            })
            .registerAction({
                kind: 'late-action',
                async execute() {
                    lateRan = true;
                    return { ok: true };
                },
            });

        const persistence = new RecordingAdapter();
        const service = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'resume-drain-dag',
            nodes: [
                { id: 'seed' },
                { id: 'gate', dependsOn: ['seed'], pause: true },
                { id: 'x', dependsOn: ['gate'], condition: { kind: 'boom-resume' } },
                { id: 'y', dependsOn: ['gate'], action: { kind: 'y-slow' } },
                { id: 'late', dependsOn: ['x', 'y'], action: { kind: 'late-action' } },
            ],
        };

        const initial = await service.run(wf, { runId: 'dag-resume-drain-1' });
        expect(initial.status).toBe('paused');
        const error = await service.resumeRun(wf, 'dag-resume-drain-1').then(
            () => undefined,
            (e) => e,
        );
        expect(error).toBe(resumeBoom);
        expect(yRan).toBe(true);
        expect(lateRan).toBe(false);
        await waitForCalls(persistence, ['finalize:y:done']);
        expect(persistence.calls.indexOf('finalize:y:done')).toBeLessThan(
            persistence.calls.indexOf('finalizeRun:failed'),
        );
    });

    test('a rejected failed-run finalization stays combined by the existing RunLifecycle contract', async () => {
        const sentinel = new Error('wave-sentinel');
        const host = createDefaultWorkflowEngineHost().registerGuard({
            kind: 'throw-sentinel',
            evaluate: async () => {
                throw sentinel;
            },
        });
        const persistence = new RecordingAdapter();
        persistence.failFailedFinalize = true;
        const service = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'finalize-reject-dag',
            nodes: [{ id: 'root' }, { id: 'solo', dependsOn: ['root'], condition: { kind: 'throw-sentinel' } }],
        };
        const error = await service.run(wf).then(
            () => undefined,
            (e) => e,
        );
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toBe('Workflow execution and failure persistence failed');
        expect((error as AggregateError).errors[0]).toBe(sentinel);
    });

    test('aggregates multiple wave rejections in ready-node declaration order', async () => {
        const e1 = new Error('e1');
        const e2 = new Error('e2');
        const host = createDefaultWorkflowEngineHost()
            .registerGuard({
                kind: 'throw-1',
                evaluate: async () => {
                    throw e1;
                },
            })
            .registerGuard({
                kind: 'throw-2',
                evaluate: async () => {
                    throw e2;
                },
            });
        const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'ordered-rejections-dag',
            nodes: [
                { id: 'root' },
                { id: 'w1', dependsOn: ['root'], condition: { kind: 'throw-1' } },
                { id: 'w2', dependsOn: ['root'], condition: { kind: 'throw-2' } },
            ],
        };
        const error = await service.run(wf).then(
            () => undefined,
            (e) => e,
        );
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).message).toBe('DAG node execution failed');
        expect((error as AggregateError).errors).toEqual([e1, e2]);
    });

    test('rethrows a single non-Error rejection reason unchanged', async () => {
        const runCase = async (reason: unknown): Promise<unknown> => {
            const host = createDefaultWorkflowEngineHost().registerGuard({
                kind: 'throw-arbitrary',
                evaluate: async () => {
                    throw reason;
                },
            });
            const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
            const wf: DagWorkflowDef = {
                kind: 'dag',
                name: 'identity-rejection-dag',
                nodes: [{ id: 'root' }, { id: 'solo', dependsOn: ['root'], condition: { kind: 'throw-arbitrary' } }],
            };
            return await service.run(wf).then(
                () => undefined,
                (e) => e,
            );
        };
        expect(await runCase('plain-string-reason')).toBe('plain-string-reason');
        // undefined is a legal rejection reason; truthiness filtering would swallow it.
        expect(await runCase(undefined)).toBeUndefined();
    });
});

describe('DagDriver — completion-driven admission (task 0105)', () => {
    interface Gate {
        resolve: () => void;
        promise: Promise<void>;
    }
    const makeGate = (): Gate => {
        let resolve!: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        return { resolve, promise };
    };

    /** Gated actions block on per-id gates; `fail`/`throw` simulate terminal outcomes. */
    const makeGatedHost = () => {
        const gates = new Map<string, Gate>();
        const starts: string[] = [];
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'gated',
            async execute(options) {
                const id = String(options.id);
                starts.push(id);
                const gate = gates.get(id);
                if (gate) await gate.promise;
                if (options.fail === true) return { ok: false, error: String(options.errorText ?? 'boom') };
                return { ok: true };
            },
        });
        // Guards run outside runActionStep, so a throwing guard rejects the
        // whole node promise — the 0103 'node exception' surface.
        host.registerGuard({
            kind: 'explode',
            evaluate: async (options) => {
                if (options.rawUndefined === true) throw undefined;
                throw new Error(String(options.errorText ?? 'kapow'));
            },
        });
        return {
            host,
            starts,
            gate: (id: string) => gates.set(id, makeGate()),
            release: (id: string) => gates.get(id)?.resolve(),
        };
    };

    /** Persistence subclass that can hold a node's terminal branch write open. */
    class RecordingPersistence extends MemoryWorkflowPersistenceAdapter {
        readonly finalizeEvents: string[] = [];
        holds = new Map<string, Promise<void>>();
        override async saveBranchFinalize(
            runId: string,
            branchId: string,
            status: BranchStatus,
            durationMs: number,
            outputVars?: Vars,
            error?: string,
        ): Promise<void> {
            const hold = this.holds.get(branchId);
            if (hold) await hold;
            this.finalizeEvents.push(`${branchId}:${status}`);
            return super.saveBranchFinalize(runId, branchId, status, durationMs, outputVars, error);
        }
    }

    const waitFor = async (predicate: () => boolean): Promise<void> => {
        for (let i = 0; i < 500 && !predicate(); i++) await new Promise((r) => setTimeout(r, 2));
        expect(predicate()).toBe(true);
    };

    test('AC1: dependent dispatches while an unrelated root is still in flight', async () => {
        const { host, starts, gate, release } = makeGatedHost();
        const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
        gate('fast-root');
        gate('slow-root');
        const runPromise = service.run({
            kind: 'dag',
            name: 'admission',
            nodes: [
                { id: 'fast-root', action: { kind: 'gated', options: { id: 'fast-root' } } },
                { id: 'slow-root', action: { kind: 'gated', options: { id: 'slow-root' } } },
                { id: 'child', dependsOn: ['fast-root'], action: { kind: 'gated', options: { id: 'child' } } },
            ],
        });
        await waitFor(() => starts.includes('fast-root') && starts.includes('slow-root'));
        release('fast-root');
        await waitFor(() => starts.includes('child'));
        // slow-root is still gated (never released): the child dispatched anyway.
        expect(starts.includes('child')).toBe(true);
        release('slow-root');
        const result = await runPromise;
        expect(result.status).toBe('done');
    });

    test('AC1b: readiness publishes only after the node chain durably settles (held terminal write)', async () => {
        const { host, starts, gate, release } = makeGatedHost();
        const persistence = new RecordingPersistence();
        const writeHold = makeGate();
        persistence.holds.set('fast-root', writeHold.promise);
        const service = new WorkflowService(host, persistence);
        gate('fast-root');
        const runPromise = service.run({
            kind: 'dag',
            name: 'durable-settlement',
            nodes: [
                { id: 'fast-root', action: { kind: 'gated', options: { id: 'fast-root' } } },
                { id: 'child', dependsOn: ['fast-root'], action: { kind: 'gated', options: { id: 'child' } } },
            ],
        });
        await waitFor(() => starts.includes('fast-root'));
        release('fast-root');
        // Host returned and even the held write is pending — the child must wait.
        await new Promise((r) => setTimeout(r, 10));
        expect(starts.includes('child')).toBe(false);
        writeHold.resolve();
        await waitFor(() => starts.includes('child'));
        const result = await runPromise;
        expect(result.status).toBe('done');
        expect(persistence.finalizeEvents).toContain('fast-root:done');
    });

    test('AC2: policy=any admits on first satisfied parent; policy=all waits for every parent', async () => {
        const { host, starts, gate, release } = makeGatedHost();
        const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
        gate('p1');
        gate('p2');
        const runPromise = service.run({
            kind: 'dag',
            name: 'join-policies',
            nodes: [
                { id: 'p1', action: { kind: 'gated', options: { id: 'p1' } } },
                { id: 'p2', action: { kind: 'gated', options: { id: 'p2' } } },
                {
                    id: 'anyChild',
                    dependsOn: ['p1', 'p2'],
                    dependencyPolicy: 'any',
                    action: { kind: 'gated', options: { id: 'anyChild' } },
                },
                { id: 'allChild', dependsOn: ['p1', 'p2'], action: { kind: 'gated', options: { id: 'allChild' } } },
            ],
        });
        await waitFor(() => starts.includes('p1') && starts.includes('p2'));
        release('p1');
        await waitFor(() => starts.includes('anyChild'));
        expect(starts.includes('allChild')).toBe(false);
        release('p2');
        await waitFor(() => starts.includes('allChild'));
        expect((await runPromise).status).toBe('done');
    });

    test('AC2b: mixed done/skipped all-join waits for the done parent; skipped node never runs', async () => {
        const { host, starts, gate, release } = makeGatedHost();
        const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
        gate('donor');
        const runPromise = service.run({
            kind: 'dag',
            name: 'mixed-join',
            nodes: [
                { id: 'donor', action: { kind: 'gated', options: { id: 'donor' } } },
                { id: 'skipper', condition: { kind: 'never' }, action: { kind: 'gated', options: { id: 'skipper' } } },
                {
                    id: 'joinAll',
                    dependsOn: ['skipper', 'donor'],
                    action: { kind: 'gated', options: { id: 'joinAll' } },
                },
            ],
        });
        await waitFor(() => starts.includes('donor'));
        // skipper settles as skipped immediately; joinAll must still wait for donor.
        await new Promise((r) => setTimeout(r, 10));
        expect(starts.includes('joinAll')).toBe(false);
        release('donor');
        await waitFor(() => starts.includes('joinAll'));
        expect(starts.includes('skipper')).toBe(false);
        expect((await runPromise).status).toBe('done');
    });

    test('AC2c: backward-declared all-skipped chain reaches skip fixed point without deadlock', async () => {
        const { host, starts } = makeGatedHost();
        const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
        const result = await service.run({
            kind: 'dag',
            name: 'backward-skip',
            nodes: [
                { id: 'zChild', dependsOn: ['s1'], action: { kind: 'gated', options: { id: 'zChild' } } },
                {
                    id: 's2',
                    dependsOn: ['s1'],
                    condition: { kind: 'never' },
                    action: { kind: 'gated', options: { id: 's2' } },
                },
                { id: 's1', condition: { kind: 'never' }, action: { kind: 'gated', options: { id: 's1' } } },
            ],
        });
        expect(result.status).toBe('done');
        expect(starts).toHaveLength(0);
    });

    test('AC3: simultaneous fatal outcomes drain the surviving sibling; no dispatch after latch', async () => {
        const { host, starts, gate, release } = makeGatedHost();
        const persistence = new RecordingPersistence();
        const service = new WorkflowService(host, persistence);
        gate('survivor');
        const runPromise = service.run({
            kind: 'dag',
            name: 'simultaneous-fatal',
            nodes: [
                {
                    id: 'thrower',
                    condition: { kind: 'explode', options: { errorText: 'kapow' } },
                    action: { kind: 'gated', options: { id: 'thrower' } },
                },
                { id: 'failer', action: { kind: 'gated', options: { id: 'failer', fail: true, errorText: 'boom' } } },
                { id: 'survivor', action: { kind: 'gated', options: { id: 'survivor' } } },
                { id: 'child', dependsOn: ['survivor'], action: { kind: 'gated', options: { id: 'child' } } },
            ],
        });
        await waitFor(() => starts.length === 2); // thrower's guard rejects before its action
        release('failer');
        expect(starts.includes('child')).toBe(false);
        release('survivor');
        // Exception outranks the fail result: rethrown unchanged.
        try {
            await runPromise;
            expect.unreachable();
        } catch (error) {
            expect((error as Error).message).toBe('kapow');
        }
        // Every admitted sibling settled its terminal write before finalization.
        expect(persistence.finalizeEvents).toContain('survivor:done');
        expect(starts.includes('child')).toBe(false);
    });

    test('AC3b: multi-exception aggregates in declaration order regardless of settle order', async () => {
        const { host } = makeGatedHost();
        const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
        const runPromise = service.run({
            kind: 'dag',
            name: 'aggregate-order',
            nodes: [
                { id: 'a', condition: { kind: 'explode', options: { errorText: 'first' } } },
                { id: 'b', condition: { kind: 'explode', options: { errorText: 'second' } } },
                { id: 'u', condition: { kind: 'explode', options: { rawUndefined: true } } },
            ],
        });
        try {
            await runPromise;
            expect.unreachable();
        } catch (error) {
            const aggregate = error as AggregateError;
            expect(aggregate).toBeInstanceOf(AggregateError);
            expect(aggregate.message).toBe('DAG node execution failed');
            expect((aggregate.errors[0] as Error).message).toBe('first');
            expect((aggregate.errors[1] as Error).message).toBe('second');
            expect(aggregate.errors[2]).toBeUndefined();
        }
    });

    test('AC3c: fail-policy outcomes fail the run with the declaration-order last error', async () => {
        const { host } = makeGatedHost();
        const service = new WorkflowService(host, new MemoryWorkflowPersistenceAdapter());
        const result = await service.run({
            kind: 'dag',
            name: 'fail-routing',
            nodes: [
                { id: 'f1', action: { kind: 'gated', options: { id: 'f1', fail: true, errorText: 'boom-1' } } },
                { id: 'f2', action: { kind: 'gated', options: { id: 'f2', fail: true, errorText: 'boom-2' } } },
            ],
        });
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('boom-2');
    });

    test('AC4: pause result latches stop-dispatch; admitted sibling settles before pause surfaces', async () => {
        const { host, starts, gate, release } = makeGatedHost();
        const persistence = new RecordingPersistence();
        const service = new WorkflowService(host, persistence);
        gate('pworker');
        const runPromise = service.run({
            kind: 'dag',
            name: 'pause-barrier',
            nodes: [
                { id: 'pauser', pause: true, action: { kind: 'gated', options: { id: 'pauser' } } },
                { id: 'pworker', action: { kind: 'gated', options: { id: 'pworker' } } },
                { id: 'child', dependsOn: ['pworker'], action: { kind: 'gated', options: { id: 'child' } } },
            ],
        });
        await waitFor(() => starts.includes('pworker'));
        release('pworker');
        const result = await runPromise;
        // pworker's own child is NOT dispatched after the pause latch, and the
        // admitted sibling's terminal write lands before the pause surfaces.
        expect(starts.includes('child')).toBe(false);
        expect(persistence.finalizeEvents).toContain('pworker:done');
        expect(result.status).toBe('paused');
    });
});
