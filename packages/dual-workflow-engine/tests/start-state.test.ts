import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { FSMError } from '../src/errors';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { WorkflowService } from '../src/service';
import type { StateMachineWorkflowDef, TransitionFlowWorkflowDef, WorkflowDef } from '../src/types';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

/** Counts snapshot reads so a fresh `startState` run can prove it never took the resume path. */
class CountingPersistence extends MemoryWorkflowPersistenceAdapter {
    snapshotReads = 0;

    override async loadLatestStateSnapshot(
        runId: string,
    ): Promise<{ state: string; data: Record<string, unknown> } | undefined> {
        this.snapshotReads += 1;
        return await super.loadLatestStateSnapshot(runId);
    }
}

const tempDirs: string[] = [];

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

/** A service whose `mark` action appends its `id` option to a real marker file (AC1/AC2 observable). */
async function makeFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'wf-start-state-'));
    tempDirs.push(dir);
    const marker = join(dir, 'marker.txt');
    const host = createDefaultWorkflowEngineHost();
    host.registerAction({
        kind: 'mark',
        async execute(options) {
            appendFileSync(marker, `${String(options.id)}\n`);
            return { ok: true };
        },
    });
    const persistence = new CountingPersistence();
    return { service: new WorkflowService(host, persistence), persistence, marker, dir };
}

async function markerLines(marker: string): Promise<string[]> {
    try {
        const raw = await readFile(marker, 'utf8');
        return raw.split('\n').filter((line) => line !== '');
    } catch {
        return [];
    }
}

function stateMachineFixture(overrides: Partial<StateMachineWorkflowDef> = {}): StateMachineWorkflowDef {
    return {
        kind: 'state-machine',
        name: 'sm-start-state',
        initialState: 's1',
        terminalStates: ['done'],
        states: [
            { id: 's1', onEnter: [{ kind: 'mark', options: { id: 's1' } }] },
            { id: 's2', onEnter: [{ kind: 'mark', options: { id: 's2' } }], startable: true },
            { id: 's3', onEnter: [{ kind: 'mark', options: { id: 's3' } }] },
            { id: 'done' },
        ],
        transitions: [
            { from: 's1', to: 's2' },
            { from: 's2', to: 's3' },
            { from: 's3', to: 'done' },
        ],
        ...overrides,
    };
}

function transitionFlowFixture(overrides: Partial<TransitionFlowWorkflowDef> = {}): TransitionFlowWorkflowDef {
    return {
        kind: 'transition-flow',
        name: 'tf-start-state',
        initialNode: 'n1',
        terminalNodes: ['end'],
        nodes: [
            { id: 'n1', action: { kind: 'mark', options: { id: 'n1' } } },
            { id: 'n2', action: { kind: 'mark', options: { id: 'n2' } }, startable: true },
            { id: 'n3', action: { kind: 'mark', options: { id: 'n3' } } },
            { id: 'end' },
        ],
        edges: [
            { from: 'n1', to: 'n2' },
            { from: 'n2', to: 'n3' },
            { from: 'n3', to: 'end' },
        ],
        ...overrides,
    };
}

describe('WorkflowRunOptions.startState — fresh-run start point (task 0102)', () => {
    test('AC1: a state-machine run starting at s2 executes s2 and its successors only', async () => {
        const { service, persistence, marker } = await makeFixture();

        const result = await service.run(stateMachineFixture(), { runId: 'sm-from-s2', startState: 's2' });

        expect(await markerLines(marker)).toEqual(['s2', 's3']);
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(result.transitionsTaken).toBe(2);
        // Fresh-run semantics: the resume branch (and its snapshot load) was never entered.
        expect(persistence.snapshotReads).toBe(0);
    });

    test('AC2: a transition-flow run starting at n2 executes n2 and its successors only', async () => {
        const { service, persistence, marker } = await makeFixture();

        const result = await service.run(transitionFlowFixture(), { runId: 'tf-from-n2', startState: 'n2' });

        expect(await markerLines(marker)).toEqual(['n2', 'n3']);
        expect(result.status).toBe('done');
        expect(result.finalState).toBe('end');
        expect(persistence.snapshotReads).toBe(0);
    });

    test('AC3: an undeclared start state is refused, lists the startable ids, and writes no run row', async () => {
        const { service, persistence } = await makeFixture();

        await expect(service.run(stateMachineFixture(), { runId: 'bad-1', startState: 'nope' })).rejects.toThrow(
            FSMError,
        );
        await expect(service.run(stateMachineFixture(), { runId: 'bad-1b', startState: 'nope' })).rejects.toThrow(
            /Startable ids: s2/,
        );
        expect(await persistence.listRuns()).toHaveLength(0);
    });

    test('AC3: a terminal start state is refused without a run row', async () => {
        const { service, persistence } = await makeFixture();

        await expect(service.run(stateMachineFixture(), { runId: 'bad-2', startState: 'done' })).rejects.toThrow(
            /terminal state/,
        );
        expect(await persistence.listRuns()).toHaveLength(0);
    });

    test('AC3: a failure start state is refused without a run row', async () => {
        const { service, persistence } = await makeFixture();
        const def = stateMachineFixture({
            terminalStates: ['done', 'broken'],
            failureStates: ['broken'],
            states: [{ id: 's1' }, { id: 's2', startable: true }, { id: 'broken', startable: true }, { id: 'done' }],
            transitions: [{ from: 's2', to: 'done' }],
        });

        await expect(service.run(def, { runId: 'bad-3', startState: 'broken' })).rejects.toThrow(/failure state/);
        expect(await persistence.listRuns()).toHaveLength(0);
    });

    test('AC3: a declared but non-startable state is refused without a run row', async () => {
        const { service, persistence } = await makeFixture();

        await expect(service.run(stateMachineFixture(), { runId: 'bad-4', startState: 's1' })).rejects.toThrow(
            /not marked startable/,
        );
        expect(await persistence.listRuns()).toHaveLength(0);
    });

    test('AC3: a DAG workflow refuses startState without a run row', async () => {
        const { service, persistence } = await makeFixture();
        const dag: WorkflowDef = {
            kind: 'dag',
            name: 'dag-no-start-state',
            nodes: [{ id: 'start' }, { id: 'next', dependsOn: ['start'] }],
        };

        await expect(service.run(dag, { runId: 'bad-5', startState: 'next' })).rejects.toThrow(/kind: "dag"/);
        expect(await persistence.listRuns()).toHaveLength(0);
    });

    test('AC4: omitting startState runs the declared initialState unchanged', async () => {
        const { service, persistence, marker } = await makeFixture();

        const result = await service.run(stateMachineFixture(), { runId: 'sm-default' });

        expect(await markerLines(marker)).toEqual(['s1', 's2', 's3']);
        expect(result.finalState).toBe('done');
        expect(persistence.snapshotReads).toBe(0);
    });

    test('AC5: dryRun with startState walks from the start state and executes nothing', async () => {
        const { service, persistence, marker } = await makeFixture();

        const result = await service.run(stateMachineFixture(), {
            runId: 'sm-dry-from-s2',
            startState: 's2',
            dryRun: true,
        });

        expect(result.status).toBe('done');
        expect(result.finalState).toBe('done');
        expect(await markerLines(marker)).toEqual([]);
        expect(persistence.snapshotReads).toBe(0);
    });

    test('AC5: startState does not imply resume semantics for a state without resumeRerun', async () => {
        const { service } = await makeFixture();

        // s2 is `startable` but NOT `resumeRerun`; a resume-style enter would refuse it.
        await expect(
            service.run(stateMachineFixture(), { runId: 'sm-not-resume', startState: 's2' }),
        ).resolves.toMatchObject({ status: 'done' });
    });
});
