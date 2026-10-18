import { describe, expect, test } from 'bun:test';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { WorkflowDef } from '../src/types';

// Failure modes: downstream actions run before host completion, prefixes replay on resume,
// repeated pauses lose their cursor, exit guards repeat, and failures are mistaken for pauses.
function harness() {
    const calls: string[] = [];
    const host = createDefaultWorkflowEngineHost().registerAction({
        kind: 'work',
        async execute(options) {
            calls.push(String(options.id));
            return { ok: options.fail !== true, pause: options.pause === true, setVars: { produced: 'yes' } };
        },
    });
    const persistence = new MemoryWorkflowPersistenceAdapter();
    return { calls, host, persistence, service: new WorkflowService(host, persistence) };
}

describe('action-requested pause', () => {
    test('state-machine resumes the unexecuted suffix, including repeated pauses', async () => {
        const { calls, service, persistence } = harness();
        const workflow: WorkflowDef = {
            name: 'action-pause',
            initialState: 'work',
            states: [
                {
                    id: 'work',
                    onEnter: [
                        { kind: 'work', options: { id: 'prefix' } },
                        { kind: 'work', options: { id: 'host-1', pause: true } },
                        { kind: 'work', options: { id: 'middle' } },
                        { kind: 'work', options: { id: 'host-2', pause: true } },
                        { kind: 'work', options: { id: ['$', '{vars.produced}'].join('') } },
                    ],
                },
                { id: 'done' },
            ],
            transitions: [{ from: 'work', to: 'done' }],
            terminalStates: ['done'],
        };
        const first = await service.run(workflow);
        expect(first.status).toBe('paused');
        expect(calls).toEqual(['prefix', 'host-1']);
        expect((await persistence.loadLatestStateSnapshot(first.runId))?.data.effectiveVars).toMatchObject({
            produced: 'yes',
        });
        expect((await service.resumeRun(workflow, first.runId)).status).toBe('paused');
        expect(calls).toEqual(['prefix', 'host-1', 'middle', 'host-2']);
        expect((await service.resumeRun(workflow, first.runId)).status).toBe('done');
        expect(calls).toEqual(['prefix', 'host-1', 'middle', 'host-2', 'yes']);
        await expect(service.resumeRun(workflow, first.runId)).rejects.toThrow('not resumable');
    });

    test('exit-action resume retains the chosen transition and does not repeat its guard', async () => {
        const { calls, host, service } = harness();
        let guards = 0;
        host.registerGuard({
            kind: 'count',
            async evaluate() {
                guards++;
                return true;
            },
        });
        const workflow: WorkflowDef = {
            name: 'exit-pause',
            initialState: 'work',
            states: [
                {
                    id: 'work',
                    onExit: [
                        { kind: 'work', options: { id: 'host', pause: true } },
                        { kind: 'work', options: { id: 'tail' } },
                    ],
                },
                { id: 'done' },
            ],
            transitions: [{ from: 'work', to: 'done', guard: { kind: 'count' } }],
            terminalStates: ['done'],
        };
        const run = await service.run(workflow);
        expect(run.status).toBe('paused');
        expect(calls).toEqual(['host']);
        expect((await service.resumeRun(workflow, run.runId)).status).toBe('done');
        expect(calls).toEqual(['host', 'tail']);
        expect(guards).toBe(1);
    });

    test('a failed action cannot request a successful pause', async () => {
        const { service } = harness();
        expect(
            (
                await service.run({
                    name: 'failed-pause',
                    initialState: 'work',
                    states: [
                        { id: 'work', onEnter: [{ kind: 'work', options: { id: 'bad', pause: true, fail: true } }] },
                    ],
                    transitions: [],
                })
            ).status,
        ).toBe('failed');
    });

    for (const kind of ['transition-flow', 'dag'] as const) {
        test(`${kind} pauses after its action and resumes without replay`, async () => {
            const { calls, service } = harness();
            const node = { id: 'work', action: { kind: 'work', options: { id: 'host', pause: true } } };
            const workflow: WorkflowDef =
                kind === 'dag'
                    ? { kind, name: 'dag-pause', nodes: [node, { id: 'done', dependsOn: ['work'] }] }
                    : {
                          kind,
                          name: 'flow-pause',
                          initialNode: 'work',
                          nodes: [node, { id: 'done' }],
                          edges: [{ from: 'work', to: 'done' }],
                          terminalNodes: ['done'],
                      };
            const run = await service.run(workflow);
            expect(run.status).toBe('paused');
            expect((await service.resumeRun(workflow, run.runId)).status).toBe('done');
            expect(calls).toEqual(['host']);
        });
    }
});
