import { expect, test } from 'bun:test';
import { createDbAdapter } from '@gobing-ai/ts-db';
import { validateWorkflowDef } from '../src/config';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { DbWorkflowPersistenceAdapter, MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { WorkflowDef } from '../src/types';

for (const kind of ['state-machine', 'transition-flow'] as const) {
    function workflow(pause = false): WorkflowDef {
        return kind === 'state-machine'
            ? {
                  kind,
                  name: kind,
                  initialState: 'a',
                  states: [{ id: 'a', pause, onEnter: [{ kind: 'probe' }] }, { id: 'b' }],
                  transitions: [{ from: 'a', to: 'b', guard: { kind: 'action-ok' } }],
              }
            : {
                  kind,
                  name: kind,
                  initialNode: 'a',
                  nodes: [{ id: 'a', type: 'action', pause, action: { kind: 'probe' } }, { id: 'b' }],
                  edges: [{ from: 'a', to: 'b', condition: { kind: 'action-ok' } }],
              };
    }
    test(`${kind}: thrown action follows continue policy and records failure`, async () => {
        const store = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'probe',
            async execute() {
                throw new Error('provider unavailable');
            },
        });
        const service = new WorkflowService(host, store);
        const result = await service.run(workflow(), { onError: 'continue' });
        expect(result.status).toBe('failed');
        expect(result.reason).toMatch(/no-passing/);
        expect(store.actionRuns[0]?.status).toBe('failed');
        expect((await store.loadRun(result.runId))?.status).toBe('failed');
    });
    test(`${kind}: pause restores action-ok without leaking redacted data and attach never replays`, async () => {
        const store = new MemoryWorkflowPersistenceAdapter();
        let calls = 0;
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'probe',
            async execute() {
                calls++;
                return { ok: true, data: { token: 'secret' } };
            },
        });
        const service = new WorkflowService(host, store);
        const wf = workflow(true);
        const paused = await service.run(wf, { runId: 'same', externalKey: 'key', redactor: () => ({ ok: true }) });
        expect(JSON.stringify(await store.loadLatestStateSnapshot(paused.runId))).not.toContain('secret');
        expect(await service.run(wf, { runId: 'same', externalKey: 'key' })).toEqual(paused);
        const done = await service.resumeRun(wf, paused.runId);
        expect(done.status).toBe('done');
        expect(done.transitionsTaken).toBe(1);
        expect((await service.run(wf, { externalKey: 'key' })).status).toBe('done');
        expect(calls).toBe(1);
    });
    test(`${kind}: resume preserves the run-wide iteration bound`, async () => {
        const store = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'probe',
            async execute() {
                return { ok: true };
            },
        });
        const service = new WorkflowService(host, store);
        const base = workflow(true);
        const wf: WorkflowDef =
            base.kind === 'transition-flow'
                ? { ...base, iterationBound: 1, edges: [{ from: 'a', to: 'a' }] }
                : { ...base, iterationBound: 1, transitions: [{ from: 'a', to: 'a' }] };
        const initial = await service.run(wf);
        expect((await service.resumeRun(wf, initial.runId)).transitionsTaken).toBe(1);
        const failed = await service.resumeRun(wf, initial.runId);
        expect(failed.reason).toBe('iteration-bound-exceeded');
        expect(failed.transitionsTaken).toBe(2);
    });
    test(`${kind}: unexpected guard and evidence failures finalize then reject`, async () => {
        const store = new MemoryWorkflowPersistenceAdapter();
        const host = createDefaultWorkflowEngineHost().registerAction({
            kind: 'probe',
            async execute() {
                return { ok: true };
            },
        });
        host.registerGuard({
            kind: 'action-ok',
            async evaluate() {
                throw new Error('guard failure');
            },
        });
        const service = new WorkflowService(host, store);
        await expect(service.run(workflow(), { runId: 'guard' })).rejects.toThrow('guard failure');
        expect((await store.loadRun('guard'))?.status).toBe('failed');
        store.saveActionFinalize = async () => {
            throw new Error('evidence failure');
        };
        await expect(service.run(workflow(), { runId: 'audit' })).rejects.toThrow('evidence failure');
        expect((await store.loadRun('audit'))?.status).toBe('failed');
    });
}

test('external hop uses persisted variables, caller overrides, and preserves counter', async () => {
    const store = new MemoryWorkflowPersistenceAdapter();
    const host = createDefaultWorkflowEngineHost().registerGuard({
        kind: 'route',
        async evaluate(options, context) {
            return options.route === 'override' && context.vars.saved === 'yes';
        },
    });
    const service = new WorkflowService(host, store);
    const wf = {
        name: 'external',
        initialState: 'a',
        vars: { route: 'default' },
        states: [{ id: 'a', pause: true }, { id: 'b' }],
        transitions: [{ from: 'a', to: 'b', guard: { kind: 'route', options: { route: `\${vars.route}` } } }],
    };
    const run = await service.run(wf, { vars: { route: 'saved', saved: 'yes' } });
    expect((await service.requestTransition(wf, run.runId, 'b', { vars: { route: 'override' } })).allowed).toBe(true);
    expect((await store.loadLatestStateSnapshot(run.runId))?.data).toEqual({
        transitionsTaken: 1,
        effectiveVars: { route: 'override', saved: 'yes' },
    });
});

test('terminal onExit halts before the next state', async () => {
    const store = new MemoryWorkflowPersistenceAdapter();
    const host = createDefaultWorkflowEngineHost().registerAction({
        kind: 'stop',
        async execute() {
            return { ok: true, terminal: true };
        },
    });
    const result = await new WorkflowService(host, store).run({
        name: 'exit',
        initialState: 'a',
        states: [{ id: 'a', onExit: [{ kind: 'stop' }] }, { id: 'b' }],
        transitions: [{ from: 'a', to: 'b' }],
    });
    expect(result.finalState).toBe('a');
    expect(result.transitionsTaken).toBe(0);
});

test('flow validation rejects missing terminals and shadowed edges', () => {
    const wf: Extract<WorkflowDef, { kind: 'transition-flow' }> = {
        kind: 'transition-flow',
        name: 'bad',
        initialNode: 'a',
        nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
        terminalNodes: ['missing'],
        edges: [
            { from: 'a', to: 'b' },
            { from: 'a', to: 'c', condition: { kind: 'action-ok' } },
        ],
    };
    expect(() => validateWorkflowDef(wf)).toThrow('Terminal node "missing" is not declared');
    expect(() => validateWorkflowDef({ ...wf, terminalNodes: [] })).toThrow('unreachable');
});

for (const storage of ['memory', 'db'] as const) {
    test(`${storage}: concurrent attachment executes exactly once even with identical explicit run IDs`, async () => {
        const db = storage === 'db' ? await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' }) : undefined;
        try {
            const store = db ? new DbWorkflowPersistenceAdapter(db) : new MemoryWorkflowPersistenceAdapter();
            let calls = 0;
            const host = createDefaultWorkflowEngineHost().registerAction({
                kind: 'probe',
                async execute() {
                    calls++;
                    return { ok: true };
                },
            });
            const service = new WorkflowService(host, store);
            const wf = {
                name: 'concurrent',
                initialState: 'a',
                states: [{ id: 'a', onEnter: [{ kind: 'probe' }] }],
                transitions: [],
            };
            await Promise.all([
                service.run(wf, { runId: 'same', externalKey: '' }),
                service.run(wf, { runId: 'same', externalKey: '' }),
                service.run(wf, { runId: 'different', externalKey: '' }),
            ]);
            expect(calls).toBe(1);
            expect(await store.listRuns()).toHaveLength(1);
        } finally {
            db?.close();
        }
    });
}
