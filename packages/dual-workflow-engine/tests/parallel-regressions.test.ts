import { describe, expect, test } from 'bun:test';
import { createDbAdapter } from '@gobing-ai/ts-db';
import { validateWorkflowDef } from '../src/config';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { DbWorkflowPersistenceAdapter, MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { TransitionFlowWorkflowDef } from '../src/types';

function workflow(): TransitionFlowWorkflowDef {
    return {
        kind: 'transition-flow',
        name: 'parallel-regressions',
        initialNode: 'fork',
        nodes: [
            {
                id: 'fork',
                type: 'parallel',
                resumeRerun: true,
                branches: [
                    { id: 'a', startNode: 'a' },
                    { id: 'b', startNode: 'b' },
                ],
                join: 'join',
            },
            { id: 'a', action: { kind: 'record' } },
            { id: 'pause', pause: true, action: { kind: 'record' } },
            { id: 'after', action: { kind: 'record' } },
            { id: 'b', action: { kind: 'record' } },
            { id: 'join', action: { kind: 'record' } },
        ],
        edges: [
            { from: 'a', to: 'pause' },
            { from: 'pause', to: 'after' },
            { from: 'after', to: 'join' },
            { from: 'b', to: 'join' },
        ],
    };
}

describe('C2 re-audit regressions', () => {
    test('resume preserves a later pause position and branch-local output', async () => {
        const seen: string[] = [];
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'record',
            async execute(_, ctx) {
                seen.push(ctx.stateOrNodeId);
                if (ctx.stateOrNodeId === 'pause') return { ok: true, setVars: { local: 'kept' } };
                if (ctx.stateOrNodeId === 'after') expect(ctx.vars.local).toBe('kept');
                if (ctx.stateOrNodeId === 'join') expect(ctx.vars.local).toBe('kept');
                return { ok: true };
            },
        });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);
        const first = await service.run(workflow());
        expect(first.status).toBe('paused');
        expect((await persistence.listRunBranches(first.runId, 'fork')).find((b) => b.branch_id === 'a')?.node).toBe(
            'pause',
        );
        expect((await service.resumeRun(workflow(), first.runId)).status).toBe('done');
        expect(seen.filter((n) => n === 'a')).toHaveLength(1);
        expect(seen.filter((n) => n === 'pause')).toHaveLength(1);
        expect(seen.filter((n) => n === 'b')).toHaveLength(1);
    });

    test('interrupted recovery refuses an unsafe branch before claiming the run', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(createDefaultWorkflowEngineHost(), persistence);
        await persistence.createRun({
            id: 'interrupted',
            workflow_name: 'parallel-regressions',
            mode: 'transition-flow',
            status: 'interrupted',
            started_at: new Date().toISOString(),
            completed_at: null,
            metadata_json: '{}',
        });
        await persistence.saveWorkflowState('interrupted', 'fork', {});
        await persistence.saveBranchStart('interrupted', 'fork', 'a', 'pause');
        await expect(service.resumeRun(workflow(), 'interrupted')).rejects.toThrow('resumeRerun');
        expect((await persistence.loadRun('interrupted'))?.status).toBe('interrupted');
    });

    test('fail-fast preserves the failing reason when an earlier sibling is cancelled', async () => {
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'record',
            async execute(_, ctx) {
                if (ctx.stateOrNodeId === 'b') return { ok: false, error: 'original-failure' };
                return await new Promise((resolve) =>
                    ctx.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), {
                        once: true,
                    }),
                );
            },
        });
        const wf = workflow();
        const result = await new WorkflowService(host, new MemoryWorkflowPersistenceAdapter()).run({
            ...wf,
            nodes: wf.nodes.map((node) =>
                node.id === 'fork' ? { ...node, failurePolicy: 'fail-fast' as const } : node,
            ),
        });
        expect(result.reason).toBe('original-failure');
    });

    for (const driver of ['memory', 'sqlite'] as const) {
        test(`${driver} branch finalization only updates the selected parallel region`, async () => {
            const db =
                driver === 'sqlite' ? await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' }) : undefined;
            const persistence = db ? new DbWorkflowPersistenceAdapter(db) : new MemoryWorkflowPersistenceAdapter();
            try {
                await persistence.createRun({
                    id: 'regions',
                    workflow_name: 'regions',
                    mode: 'transition-flow',
                    status: 'running',
                    started_at: new Date().toISOString(),
                    completed_at: null,
                    metadata_json: '{}',
                });
                await persistence.saveBranchStart('regions', 'fork-one', 'a', 'a');
                await persistence.saveBranchStart('regions', 'fork-two', 'a', 'b');
                await persistence.saveBranchFinalize('regions', 'a', 'done', 1, {}, undefined, {
                    parallelNode: 'fork-two',
                    node: 'b',
                });
                expect((await persistence.listRunBranches('regions', 'fork-one'))[0]?.status).toBe('running');
                expect((await persistence.listRunBranches('regions', 'fork-two'))[0]?.status).toBe('done');
            } finally {
                db?.close();
            }
        });
    }
});

test('fail-fast aborts an active shell process group and records the failure', async () => {
    const wf = workflow();
    const persistence = new MemoryWorkflowPersistenceAdapter();
    const started = Date.now();
    const result = await new WorkflowService(createDefaultWorkflowEngineHost(), persistence).run({
        ...wf,
        nodes: wf.nodes.map((node) => {
            if (node.id === 'fork') return { ...node, failurePolicy: 'fail-fast' as const };
            if (node.id === 'a') return { id: 'a', action: { kind: 'shell', options: { command: 'sleep 5' } } };
            if (node.id === 'b')
                return { id: 'b', action: { kind: 'shell', options: { command: 'sleep 0.05; exit 9' } } };
            return { ...node, action: undefined };
        }),
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('9');
    expect(Date.now() - started).toBeLessThan(1000);
    const branches = await persistence.listRunBranches(result.runId, 'fork');
    expect(branches.find((branch) => branch.branch_id === 'a')?.status).toBe('cancelled');
    expect(branches.find((branch) => branch.branch_id === 'b')?.status).toBe('failed');
});

test('collect enters the join with successful sibling output before aggregate failure', async () => {
    let joined = false;
    const host = createDefaultWorkflowEngineHost().registerAction({
        kind: 'record',
        async execute(_, ctx) {
            if (ctx.stateOrNodeId === 'a') return { ok: false, error: 'collected-failure' };
            if (ctx.stateOrNodeId === 'b') return { ok: true, setVars: { successful: 'output' } };
            if (ctx.stateOrNodeId === 'join') {
                joined = true;
                expect(ctx.vars.successful).toBe('output');
            }
            return { ok: true };
        },
    });
    const result = await new WorkflowService(host, new MemoryWorkflowPersistenceAdapter()).run(workflow());
    expect(joined).toBe(true);
    expect(result.status).toBe('failed');
    expect(result.finalState).toBe('join');
    expect(result.reason).toBe('collected-failure');
});

test('SQLite recovery after branch completion does not replay successful siblings', async () => {
    const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    const persistence = new DbWorkflowPersistenceAdapter(db);
    const entered: string[] = [];
    const host = createDefaultWorkflowEngineHost().registerAction({
        kind: 'record',
        async execute(_, ctx) {
            entered.push(ctx.stateOrNodeId);
            expect(ctx.vars.a).toBe('saved-a');
            expect(ctx.vars.b).toBe('saved-b');
            return { ok: true };
        },
    });
    try {
        await persistence.createRun({
            id: 'crash',
            workflow_name: 'parallel-regressions',
            mode: 'transition-flow',
            status: 'interrupted',
            started_at: new Date().toISOString(),
            completed_at: null,
            metadata_json: '{}',
        });
        await persistence.saveWorkflowState('crash', 'fork', { effectiveVars: {} });
        for (const branch of ['a', 'b']) {
            await persistence.saveBranchStart('crash', 'fork', branch, branch);
            await persistence.saveBranchFinalize('crash', branch, 'done', 1, { [branch]: `saved-${branch}` });
        }
        const result = await new WorkflowService(host, persistence).resumeRun(workflow(), 'crash');
        expect(result.status).toBe('done');
        expect(entered).toEqual(['join']);
    } finally {
        db.close();
    }
});

for (const driver of ['memory', 'sqlite'] as const) {
    test(`${driver} rejects stale branch and join writes after ownership changes`, async () => {
        const db = driver === 'sqlite' ? await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' }) : undefined;
        const persistence = db ? new DbWorkflowPersistenceAdapter(db) : new MemoryWorkflowPersistenceAdapter();
        try {
            await persistence.createRun({
                id: 'fenced',
                workflow_name: 'fenced',
                mode: 'transition-flow',
                status: 'running',
                owner_attempt: 'old',
                started_at: new Date().toISOString(),
                completed_at: null,
                metadata_json: '{}',
            });
            await persistence.saveBranchStart('fenced', 'fork', 'a', 'a', 'old');
            await persistence.interruptRun('fenced', 'lost-owner');
            await persistence.claimRunOwnership('fenced', { attemptId: 'new' }, ['interrupted']);
            await expect(persistence.saveBranchStart('fenced', 'fork', 'b', 'b', 'old')).rejects.toThrow(
                'Stale branch owner',
            );
            await expect(
                persistence.saveBranchFinalize('fenced', 'a', 'done', 1, { stale: 'yes' }, undefined, {
                    parallelNode: 'fork',
                    node: 'a',
                    ownerAttempt: 'old',
                }),
            ).rejects.toThrow('Stale branch owner');
            await expect(persistence.commitJoin('fenced', 'fork', 'join', {}, undefined, 'old')).rejects.toThrow(
                'Stale branch owner',
            );
            expect((await persistence.listRunBranches('fenced', 'fork'))[0]?.status).toBe('running');
            expect(await persistence.loadCurrentState('fenced')).toBeUndefined();
        } finally {
            db?.close();
        }
    });
}

test('SQLite joins commit branch outcomes, transition and snapshot in one fenced batch', async () => {
    const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
    const persistence = new DbWorkflowPersistenceAdapter(db);
    try {
        await persistence.createRun({
            id: 'atomic',
            workflow_name: 'atomic',
            mode: 'transition-flow',
            status: 'running',
            owner_attempt: 'owner',
            started_at: new Date().toISOString(),
            completed_at: null,
            metadata_json: '{}',
        });
        await persistence.saveBranchStart('atomic', 'fork', 'a', 'a', 'owner');
        await persistence.saveBranchFinalize('atomic', 'a', 'done', 1, { output: 'kept' }, undefined, {
            parallelNode: 'fork',
            node: 'a',
            ownerAttempt: 'owner',
        });
        const batch = db.batch.bind(db);
        let branchWrites = 0;
        db.batch = async (ops) => {
            branchWrites = ops.filter((op) => op.sql.startsWith('UPDATE workflow_branches')).length;
            return await batch(ops);
        };
        await persistence.commitJoin(
            'atomic',
            'fork',
            'join',
            { output: 'kept' },
            { phase: 'join', status: 'running' },
            'owner',
            3,
        );
        expect(branchWrites).toBe(1);
        expect((await persistence.loadLatestStateSnapshot('atomic'))?.data).toEqual({
            effectiveVars: { output: 'kept' },
            transitionsTaken: 3,
        });
        // Steal ownership after the preliminary check, immediately before the batch.
        db.batch = async (ops) => {
            await db.run("UPDATE runs SET owner_attempt = 'replacement' WHERE id = 'atomic'");
            return await batch(ops);
        };
        await expect(persistence.commitJoin('atomic', 'fork', 'stale-join', {}, undefined, 'owner')).rejects.toThrow(
            'Stale branch owner',
        );
        expect(await persistence.loadCurrentState('atomic')).toBe('join');
    } finally {
        db.close();
    }
});

test('fail-fast cancels siblings when a branch guard throws', async () => {
    let siblingAborted = false;
    const host = createDefaultWorkflowEngineHost()
        .registerAction({
            kind: 'record',
            async execute(_, ctx) {
                if (ctx.stateOrNodeId === 'a') return { ok: true };
                return await new Promise((resolve) => {
                    const timer = setTimeout(() => resolve({ ok: true }), 100);
                    ctx.signal?.addEventListener(
                        'abort',
                        () => {
                            siblingAborted = true;
                            clearTimeout(timer);
                            resolve({ ok: false });
                        },
                        { once: true },
                    );
                });
            },
        })
        .registerGuard({
            kind: 'throwing',
            async evaluate() {
                throw new Error('guard-failure');
            },
        });
    const wf = workflow();
    const persistence = new MemoryWorkflowPersistenceAdapter();
    const result = await new WorkflowService(host, persistence).run({
        ...wf,
        nodes: wf.nodes.map((node) => (node.id === 'fork' ? { ...node, failurePolicy: 'fail-fast' as const } : node)),
        edges: wf.edges.map((edge) => (edge.from === 'a' ? { ...edge, condition: { kind: 'throwing' } } : edge)),
    });
    expect(result.reason).toBe('guard-failure');
    expect(siblingAborted).toBe(true);
    const branches = await persistence.listRunBranches(result.runId, 'fork');
    expect(branches.find((branch) => branch.branch_id === 'a')?.status).toBe('failed');
    expect(branches.find((branch) => branch.branch_id === 'b')?.status).toBe('cancelled');
});

for (const driver of ['memory', 'sqlite'] as const) {
    test(`${driver} action failure does not overwrite a previous fork with reused branch IDs`, async () => {
        const db = driver === 'sqlite' ? await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' }) : undefined;
        const persistence = db ? new DbWorkflowPersistenceAdapter(db) : new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'fail',
            async execute() {
                return { ok: false, error: 'second-fork' };
            },
        });
        try {
            await persistence.createRun({
                id: 'reused',
                workflow_name: 'reused',
                mode: 'transition-flow',
                status: 'interrupted',
                started_at: new Date().toISOString(),
                completed_at: null,
                metadata_json: '{}',
            });
            for (const branch of ['a', 'b']) {
                await persistence.saveBranchStart('reused', 'previous', branch, 'previous-node');
                await persistence.saveBranchFinalize('reused', branch, 'done', 1, { saved: 'previous' });
            }
            await persistence.saveWorkflowState('reused', 'fork', {});
            const wf = workflow();
            const result = await new WorkflowService(host, persistence).resumeRun(
                {
                    ...wf,
                    nodes: wf.nodes.map((node) =>
                        node.id === 'a'
                            ? { ...node, action: { kind: 'fail' } }
                            : node.id === 'b'
                              ? { ...node, action: { kind: 'shell', options: { command: 'sleep 5' } } }
                              : node.id === 'fork'
                                ? { ...node, failurePolicy: 'fail-fast' as const }
                                : { ...node, action: undefined },
                    ),
                },
                'reused',
            );
            expect(result.status).toBe('failed');
            expect(
                (await persistence.listRunBranches('reused', 'previous')).every((branch) => branch.status === 'done'),
            ).toBe(true);
            expect(
                (await persistence.listRunBranches('reused', 'fork')).find((branch) => branch.branch_id === 'a')
                    ?.status,
            ).toBe('failed');
        } finally {
            db?.close();
        }
    });

    test(`${driver} preserves collected failure when recovering at the join`, async () => {
        const db = driver === 'sqlite' ? await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' }) : undefined;
        const persistence = db ? new DbWorkflowPersistenceAdapter(db) : new MemoryWorkflowPersistenceAdapter();
        try {
            await persistence.createRun({
                id: 'join-crash',
                workflow_name: 'parallel-regressions',
                mode: 'transition-flow',
                status: 'interrupted',
                started_at: new Date().toISOString(),
                completed_at: null,
                metadata_json: '{}',
            });
            await persistence.commitJoin(
                'join-crash',
                'fork',
                'join',
                {},
                undefined,
                undefined,
                1,
                'collected-before-crash',
            );
            const wf = workflow();
            const result = await new WorkflowService(createDefaultWorkflowEngineHost(), persistence).resumeRun(
                { ...wf, nodes: wf.nodes.map((node) => ({ ...node, action: undefined, resumeRerun: true })) },
                'join-crash',
            );
            expect(result.status).toBe('failed');
            expect(result.reason).toBe('collected-before-crash');
        } finally {
            db?.close();
        }
    });
}

test('parallel join hops enforce the workflow iteration bound', async () => {
    const wf = workflow();
    const result = await new WorkflowService(
        createDefaultWorkflowEngineHost(),
        new MemoryWorkflowPersistenceAdapter(),
    ).run(
        {
            ...wf,
            iterationBound: 1,
            nodes: [
                ...wf.nodes.map((node) =>
                    node.id === 'join'
                        ? {
                              ...wf.nodes[0],
                              id: 'join',
                              join: 'fork',
                              branches: [
                                  { id: 'c', startNode: 'c' },
                                  { id: 'd', startNode: 'd' },
                              ],
                          }
                        : { ...node, action: undefined },
                ),
                { id: 'c' },
                { id: 'd' },
            ],
        },
        { dryRun: true },
    );
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('iteration-bound-exceeded');
    expect(result.transitionsTaken).toBe(2);
});

test('validation rejects a parallel fork used as its own branch start', () => {
    const wf = workflow();
    expect(() =>
        validateWorkflowDef({
            ...wf,
            nodes: wf.nodes.map((node) =>
                node.id === 'fork'
                    ? {
                          ...node,
                          branches: [
                              { id: 'recursive', startNode: 'fork' },
                              { id: 'b', startNode: 'b' },
                          ],
                      }
                    : node,
            ),
        }),
    ).toThrow('nested parallel');
});
