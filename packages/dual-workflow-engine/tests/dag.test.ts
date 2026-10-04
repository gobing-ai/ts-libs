import { describe, expect, test } from 'bun:test';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { DagWorkflowDef } from '../src/types';

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
