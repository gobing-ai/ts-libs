import { describe, expect, test } from 'bun:test';
import { createDbAdapter } from '@gobing-ai/ts-db';
import { assertDagResumeAllowed, DagDriver, dagTopoOrder } from '../src/dag';
import { FSMError, WorkflowResumeError } from '../src/errors';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { DbWorkflowPersistenceAdapter, MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { DagWorkflowDef, Vars, WorkflowPersistenceAdapter } from '../src/types';

const T0 = '2026-01-01T00:00:00.000Z';

/** Probe action: counts executions per id and echoes caller-supplied vars into setVars. */
function makeHost() {
    const host = createDefaultWorkflowEngineHost();
    const calls = new Map<string, number>();
    host.registerAction(
        {
            kind: 'probe',
            async execute(options) {
                const id = String(options.id ?? 'x');
                calls.set(id, (calls.get(id) ?? 0) + 1);
                const setVars = options.setVars as Vars | undefined;
                return { ok: true, setVars: setVars ? { ...setVars } : undefined };
            },
        },
        'builtin',
    );
    return { host, calls };
}

/** Records checkpoint-vs-ledger write order without changing behavior. */
class OrderAdapter extends MemoryWorkflowPersistenceAdapter {
    readonly order: string[] = [];
    override async saveWorkflowState(runId: string, state: string, data: Record<string, unknown>): Promise<void> {
        this.order.push(`state:${state}`);
        await super.saveWorkflowState(runId, state, data);
    }
    override async saveBranchStart(
        runId: string,
        parallelNode: string,
        branchId: string,
        node: string,
    ): Promise<string> {
        this.order.push(`start:${branchId}`);
        return await super.saveBranchStart(runId, parallelNode, branchId, node);
    }
}

/** Corrupts one persisted delta to prove malformed payloads fail loudly. */
class TamperedLedgerAdapter extends MemoryWorkflowPersistenceAdapter {
    override async listRunBranches(runId: string, parallelNode?: string) {
        const rows = await super.listRunBranches(runId, parallelNode);
        return rows.map((row) => (row.branch_id === 'producer' ? { ...row, output_vars_json: '{bad' } : row));
    }
}

async function seedRunRecord(persistence: WorkflowPersistenceAdapter, workflowName: string, runId: string) {
    await persistence.createRun({
        id: runId,
        workflow_name: workflowName,
        mode: 'dag',
        status: 'running',
        started_at: T0,
        completed_at: null,
        metadata_json: '{}',
    });
}

/** Dead-owner fixture (task 0104 AC1): settled producer row, unfinished dependent, interrupted run, no snapshot. */
async function seedInterruptedRun(
    persistence: WorkflowPersistenceAdapter,
    workflowName: string,
    runId: string,
    options: { producerDelta?: Vars; dependentRunning?: boolean } = {},
) {
    await seedRunRecord(persistence, workflowName, runId);
    await persistence.saveBranchStart(runId, '__dag__', 'producer', 'producer');
    await persistence.saveBranchFinalize(runId, 'producer', 'done', 1, options.producerDelta ?? { produced: 'P1' });
    if (options.dependentRunning !== false) {
        await persistence.saveBranchStart(runId, '__dag__', 'dependent', 'dependent');
    }
    await persistence.interruptRun(runId, 'owner-lost');
}

async function branchRow(persistence: WorkflowPersistenceAdapter, runId: string, branchId: string) {
    const rows = await persistence.listRunBranches(runId, '__dag__');
    return rows.find((row) => row.branch_id === branchId);
}

describe('dagTopoOrder (task 0104 Design 4)', () => {
    test('orders by dependencies with declaration-order tie-breaking', () => {
        const nodes = [
            { id: 'consumer', dependsOn: ['pb', 'pa'] },
            { id: 'pb' },
            { id: 'pa' },
            { id: 'witness', dependsOn: ['consumer'] },
        ];
        expect(dagTopoOrder(nodes as never)).toEqual(['pb', 'pa', 'consumer', 'witness']);
    });
});

describe('recovery regressions (task 0104)', () => {
    test('AC2/R1: pause node completes action, persists its delta, and checkpoints before the first wave', async () => {
        const { host } = makeHost();
        const persistence = new OrderAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'anchor-order',
            nodes: [
                {
                    id: 'gate',
                    pause: true,
                    action: { kind: 'probe', options: { id: 'gate', setVars: { gateVar: 'G' } } },
                },
            ],
        };
        const result = await svc.run(wf);
        expect(result.status).toBe('paused');
        // Anchor checkpoint precedes any node ledger start (Design 1).
        expect(persistence.order[0]).toBe('state:gate');
        expect(persistence.order.indexOf('start:gate')).toBeGreaterThan(0);
        // Pause happens after the action: delta persisted as a 'paused' row (Design 8/R1).
        const row = await branchRow(persistence, result.runId, 'gate');
        expect(row?.status).toBe('paused');
        expect(JSON.parse(row?.output_vars_json ?? '{}')).toEqual({ gateVar: 'G' });
        const snapshot = await persistence.loadLatestStateSnapshot(result.runId);
        expect(snapshot?.state).toBe('gate');
        expect((snapshot?.data?.effectiveVars as Vars)?.gateVar).toBe('G');
    });

    test('AC2: skip-enter resume acknowledges the paused row and finishes evidence exactly once', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'ack-skip',
            nodes: [
                {
                    id: 'gate',
                    pause: true,
                    action: { kind: 'probe', options: { id: 'gate', setVars: { gateVar: 'G' } } },
                },
                { id: 'after', dependsOn: ['gate'], action: { kind: 'probe', options: { id: 'after' } } },
            ],
        };
        const paused = await svc.run(wf);
        expect(paused.status).toBe('paused');
        expect(calls.get('gate')).toBe(1);
        const done = await svc.resumeRun(wf, paused.runId);
        expect(done.status).toBe('done');
        expect(done.transitionsTaken).toBe(2); // gate + after, counted once each
        expect(calls.get('gate')).toBe(1); // ack never re-executes
        expect(calls.get('after')).toBe(1);
        const row = await branchRow(persistence, paused.runId, 'gate');
        expect(row?.status).toBe('done');
        expect(JSON.parse(row?.output_vars_json ?? '{}')).toEqual({ gateVar: 'G' }); // delta survives the ack
    });

    test('AC1: interrupted run without a snapshot recovers from the ledger and never replays done nodes', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'ledger-recovery',
            vars: { seen: 'DEF' },
            nodes: [
                { id: 'producer', action: { kind: 'probe', options: { id: 'producer', setVars: { produced: 'P1' } } } },
                {
                    id: 'dependent',
                    dependsOn: ['producer'],
                    resumeRerun: true,
                    action: { kind: 'probe', options: { id: 'dependent', setVars: { seen: `\${vars.produced}` } } },
                },
                { id: 'witness', dependsOn: ['dependent'], pause: true },
            ],
        };
        await seedInterruptedRun(persistence, wf.name, 'run-ledger-recovery');
        const result = await svc.resumeRun(wf, 'run-ledger-recovery');
        expect(result.status).toBe('paused'); // parked at witness
        expect(calls.get('producer')).toBeUndefined(); // done row never replays
        expect(calls.get('dependent')).toBe(1); // unfinished node re-runs exactly once
        const snapshot = await persistence.loadLatestStateSnapshot('run-ledger-recovery');
        expect((snapshot?.data?.effectiveVars as Vars)?.seen).toBe('P1'); // delta recovered via ledger
        // Anchor derived from the ledger was persisted after the CAS (Design 1).
        expect(snapshot?.state).toBe('witness');
    });

    test('Design 6/R3: unfinished action without resumeRerun refuses admission before the ownership claim', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'unsafe-replay',
            nodes: [
                { id: 'producer', action: { kind: 'probe', options: { id: 'producer' } } },
                { id: 'dependent', dependsOn: ['producer'], action: { kind: 'probe', options: { id: 'dependent' } } },
            ],
        };
        await seedInterruptedRun(persistence, wf.name, 'run-unsafe');
        let error: unknown;
        try {
            await svc.resumeRun(wf, 'run-unsafe');
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(FSMError);
        expect((error as Error).message).toContain('dependent');
        // Admission precedes the CAS: the run stays interrupted with no owner.
        const run = await persistence.loadRun('run-unsafe');
        expect(run?.status).toBe('interrupted');
        expect(run?.owner_attempt ?? null).toBeNull();
        expect(calls.size).toBe(0);
    });

    test('AC5: persisted deltas merge in topological order, so the later producer wins a collision', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'delta-collision',
            nodes: [
                { id: 'pb', action: { kind: 'probe', options: { id: 'pb', setVars: { k: 'TOPB' } } } },
                { id: 'pa', action: { kind: 'probe', options: { id: 'pa', setVars: { k: 'TOPA' } } } },
                { id: 'gate', dependsOn: ['pb', 'pa'], pause: true },
                {
                    id: 'consumer',
                    dependsOn: ['gate'],
                    action: { kind: 'probe', options: { id: 'consumer', setVars: { seen: `\${vars.k}` } } },
                },
                { id: 'witness', dependsOn: ['consumer'], pause: true },
            ],
        };
        const first = await svc.run(wf);
        expect(first.status).toBe('paused');
        const resumed = await svc.resumeRun(wf, first.runId);
        expect(resumed.status).toBe('paused'); // parked at witness
        const snapshot = await persistence.loadLatestStateSnapshot(first.runId);
        expect((snapshot?.data?.effectiveVars as Vars)?.seen).toBe('TOPA'); // topo order: pa after pb
        expect(calls.get('consumer')).toBe(1);
    });

    test('Design 4/R4: caller vars override ledger deltas on resume', async () => {
        const { host } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'caller-precedence',
            nodes: [
                { id: 'pb', action: { kind: 'probe', options: { id: 'pb', setVars: { k: 'TOPB' } } } },
                { id: 'gate', dependsOn: ['pb'], pause: true },
                { id: 'witness', dependsOn: ['gate'], pause: true },
            ],
        };
        const first = await svc.run(wf);
        expect(first.status).toBe('paused');
        const resumed = await svc.resumeRun(wf, first.runId, { vars: { k: 'CALLER' } });
        expect(resumed.status).toBe('paused');
        const snapshot = await persistence.loadLatestStateSnapshot(first.runId);
        expect((snapshot?.data?.effectiveVars as Vars)?.k).toBe('CALLER');
    });

    test('AC5: a null legacy output delta is an empty delta', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'null-delta',
            vars: { k: 'DEF' },
            nodes: [
                { id: 'producer', action: { kind: 'probe', options: { id: 'producer' } } },
                {
                    id: 'consumer',
                    dependsOn: ['producer'],
                    action: { kind: 'probe', options: { id: 'consumer', setVars: { seen: `\${vars.k}` } } },
                },
                { id: 'witness', dependsOn: ['consumer'], pause: true },
            ],
        };
        await seedInterruptedRun(persistence, wf.name, 'run-null-delta', {
            producerDelta: undefined,
            dependentRunning: false,
        });
        const result = await svc.resumeRun(wf, 'run-null-delta');
        expect(result.status).toBe('paused');
        const snapshot = await persistence.loadLatestStateSnapshot('run-null-delta');
        expect((snapshot?.data?.effectiveVars as Vars)?.seen).toBe('DEF');
        expect(calls.get('producer')).toBeUndefined();
    });

    test('AC5: malformed stored delta fails loudly with WorkflowResumeError before execution', async () => {
        const { host, calls } = makeHost();
        const persistence = new TamperedLedgerAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'malformed-delta',
            nodes: [
                { id: 'producer', action: { kind: 'probe', options: { id: 'producer' } } },
                { id: 'consumer', dependsOn: ['producer'], action: { kind: 'probe', options: { id: 'consumer' } } },
            ],
        };
        await seedInterruptedRun(persistence, wf.name, 'run-malformed');
        let error: unknown;
        try {
            await svc.resumeRun(wf, 'run-malformed');
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(WorkflowResumeError);
        expect((error as Error).message).toContain('producer');
        expect(calls.size).toBe(0);
    });

    test('Design 5: transitionsTaken counts distinct done/paused nodes across a pause boundary', async () => {
        const { host } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'distinct-count',
            nodes: [
                { id: 'p1', action: { kind: 'probe', options: { id: 'p1' } } },
                { id: 'p2', action: { kind: 'probe', options: { id: 'p2' } } },
                { id: 'gate', dependsOn: ['p1', 'p2'], pause: true },
                { id: 'after', dependsOn: ['gate'], action: { kind: 'probe', options: { id: 'after' } } },
            ],
        };
        const paused = await svc.run(wf);
        expect(paused.status).toBe('paused');
        expect(paused.transitionsTaken).toBe(3); // p1, p2 (done) + gate (paused)
        const done = await svc.resumeRun(wf, paused.runId);
        expect(done.status).toBe('done');
        expect(done.transitionsTaken).toBe(4); // no double-count for the acknowledged gate
    });

    test('Design 7: a second outstanding pause surfaces once after the acknowledged one drains', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'multi-pause',
            nodes: [
                { id: 'pa', pause: true },
                { id: 'pb', pause: true },
                { id: 'join', dependsOn: ['pa', 'pb'], action: { kind: 'probe', options: { id: 'join' } } },
            ],
        };
        const first = await svc.run(wf);
        expect(first.status).toBe('paused');
        const second = await svc.resumeRun(wf, first.runId);
        expect(second.status).toBe('paused'); // the other branch's pause, not done
        const third = await svc.resumeRun(wf, first.runId);
        expect(third.status).toBe('done');
        expect(calls.get('join')).toBe(1);
        for (const id of ['pa', 'pb']) {
            const row = await branchRow(persistence, first.runId, id);
            expect(row?.status).toBe('done');
        }
    });

    test('AC3: rerun-enter re-executes a marked paused action exactly once and continues past it', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'rerun-ack',
            nodes: [
                {
                    id: 'gate',
                    pause: true,
                    resumeRerun: true,
                    action: { kind: 'probe', options: { id: 'gate', setVars: { gateVar: 'G' } } },
                },
                { id: 'after', dependsOn: ['gate'], action: { kind: 'probe', options: { id: 'after' } } },
            ],
        };
        const paused = await svc.run(wf);
        expect(paused.status).toBe('paused');
        const done = await svc.resumeRun(wf, paused.runId, { resumeMode: 'rerun-enter' });
        expect(done.status).toBe('done');
        expect(calls.get('gate')).toBe(2); // original + exactly one replay
        expect(calls.get('after')).toBe(1);
        expect(done.transitionsTaken).toBe(2); // replay never double-counts
        const row = await branchRow(persistence, paused.runId, 'gate');
        expect(row?.status).toBe('done');
    });

    test('AC3: rerun-enter into an unmarked pause target is refused by service and direct driver', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'rerun-unmarked',
            nodes: [
                { id: 'gate', pause: true, action: { kind: 'probe', options: { id: 'gate' } } },
                { id: 'after', dependsOn: ['gate'], action: { kind: 'probe', options: { id: 'after' } } },
            ],
        };
        const paused = await svc.run(wf);
        expect(paused.status).toBe('paused');
        for (const attempt of [
            () => svc.resumeRun(wf, paused.runId, { resumeMode: 'rerun-enter' }),
            () =>
                new DagDriver({ host, persistence }).resume(wf, paused.runId, undefined, { resumeMode: 'rerun-enter' }),
        ]) {
            let error: unknown;
            try {
                await attempt();
            } catch (caught) {
                error = caught;
            }
            expect(error).toBeInstanceOf(FSMError);
            expect((error as Error).message).toContain('gate');
        }
        expect(calls.get('gate')).toBe(1);
    });

    test('Design 6: direct DagDriver.resume honors the same admission contract (happy path)', async () => {
        const { host, calls } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'direct-driver',
            nodes: [
                { id: 'gate', pause: true },
                { id: 'after', dependsOn: ['gate'], action: { kind: 'probe', options: { id: 'after' } } },
            ],
        };
        const paused = await svc.run(wf);
        expect(paused.status).toBe('paused');
        const done = await new DagDriver({ host, persistence }).resume(wf, paused.runId, undefined, {
            resumeMode: 'skip-enter',
        });
        expect(done.status).toBe('done');
        expect(calls.get('after')).toBe(1);
    });

    test('AC4: competing service resumes serialize — exactly one claim wins', async () => {
        const { host } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'cas-race',
            nodes: [
                { id: 'gate', pause: true },
                { id: 'after', dependsOn: ['gate'], pause: true },
            ],
        };
        const paused = await svc.run(wf);
        expect(paused.status).toBe('paused');
        const settled = await Promise.allSettled([svc.resumeRun(wf, paused.runId), svc.resumeRun(wf, paused.runId)]);
        const fulfilled = settled.filter((s) => s.status === 'fulfilled');
        const rejected = settled.filter((s) => s.status === 'rejected');
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(WorkflowResumeError);
    });

    test('AC4: dryRun performs no node-ledger or driver-checkpoint writes', async () => {
        const { host } = makeHost();
        const persistence = new OrderAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'dry-run-clean',
            nodes: [
                { id: 'solo', action: { kind: 'probe', options: { id: 'solo' } } },
                { id: 'gate', dependsOn: ['solo'], pause: true },
            ],
        };
        const result = await svc.run(wf, { dryRun: true });
        expect(result.status).toBe('paused');
        expect(await persistence.listRunBranches(result.runId, '__dag__')).toHaveLength(0);
        // No ledger starts and no driver anchor checkpoint — the only workflow_state
        // write is the pre-existing terminal pause record from RunLifecycle.pause.
        expect(persistence.order.filter((entry) => entry.startsWith('start:'))).toHaveLength(0);
        expect(persistence.order.every((entry) => entry === 'state:gate')).toBe(true);
    });

    test('AC4: the same recovery loop holds over the Bun-SQLite persistence adapter', async () => {
        const { host, calls } = makeHost();
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        try {
            const persistence = new DbWorkflowPersistenceAdapter(db);
            const svc = new WorkflowService(host, persistence);
            const wf: DagWorkflowDef = {
                kind: 'dag',
                name: 'sqlite-parity',
                nodes: [
                    {
                        id: 'producer',
                        action: { kind: 'probe', options: { id: 'producer', setVars: { produced: 'P1' } } },
                    },
                    { id: 'gate', dependsOn: ['producer'], pause: true },
                    {
                        id: 'consumer',
                        dependsOn: ['gate'],
                        action: { kind: 'probe', options: { id: 'consumer', setVars: { seen: `\${vars.produced}` } } },
                    },
                ],
            };
            const paused = await svc.run(wf);
            expect(paused.status).toBe('paused');
            const done = await svc.resumeRun(wf, paused.runId);
            expect(done.status).toBe('done');
            expect(calls.get('producer')).toBe(1);
            expect(calls.get('consumer')).toBe(1);
            const row = await branchRow(persistence, paused.runId, 'producer');
            expect(row?.status).toBe('done');
            expect(JSON.parse(row?.output_vars_json ?? '{}')).toEqual({ produced: 'P1' });
            const acked = await branchRow(persistence, paused.runId, 'gate');
            expect(acked?.status).toBe('done');
        } finally {
            db.close();
        }
    });

    test('admission helper surfaces the ledger anchor and paused target for the service', async () => {
        const { host } = makeHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const svc = new WorkflowService(host, persistence);
        const wf: DagWorkflowDef = {
            kind: 'dag',
            name: 'admission-shape',
            nodes: [
                { id: 'producer', action: { kind: 'probe', options: { id: 'producer' } } },
                {
                    id: 'dependent',
                    dependsOn: ['producer'],
                    resumeRerun: true,
                    action: { kind: 'probe', options: { id: 'dependent' } },
                },
            ],
        };
        await seedInterruptedRun(persistence, wf.name, 'run-admission');
        const admission = await assertDagResumeAllowed(wf, 'run-admission', persistence, 'rerun-enter');
        expect(admission.anchor).toBe('dependent'); // first unfinished declared row
        expect(admission.pausedTarget).toBeUndefined();

        const pausedWf: DagWorkflowDef = {
            kind: 'dag',
            name: 'admission-paused',
            nodes: [{ id: 'gate', pause: true }],
        };
        const paused = await svc.run(pausedWf);
        const pausedAdmission = await assertDagResumeAllowed(pausedWf, paused.runId, persistence, 'skip-enter');
        expect(pausedAdmission.anchor).toBe('gate');
        expect(pausedAdmission.pausedTarget).toBe('gate');
    });
});
