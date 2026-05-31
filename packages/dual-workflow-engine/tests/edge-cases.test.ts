import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DbAdapter } from '@gobing-ai/ts-db';
import {
    createDefaultWorkflowEngineHost,
    DbWorkflowPersistenceAdapter,
    FSMError,
    loadWorkflowDefFromText,
    MemoryWorkflowPersistenceAdapter,
    RunCollisionError,
    resolveTemplateString,
    resolveTemplates,
    ShellActionRunner,
    StateMachineDriver,
    TransitionFlowDriver,
    type WorkflowDef,
    WorkflowService,
    WorkflowValidationError,
} from '../src';

describe('dual workflow edge cases', () => {
    test('rejects malformed JSON and undeclared transition endpoints', () => {
        expect(() => loadWorkflowDefFromText('{', 'bad.json')).toThrow(SyntaxError);
        expect(
            loadWorkflowDefFromText(
                JSON.stringify({
                    name: 'json-workflow',
                    initialState: 'start',
                    states: [{ id: 'start' }],
                    transitions: [],
                }),
                'workflow.json',
            ),
        ).toMatchObject({ name: 'json-workflow' });
        expect(() =>
            loadWorkflowDefFromText(JSON.stringify({ name: 'invalid-json-workflow' }), 'invalid.json'),
        ).toThrow(WorkflowValidationError);
        expect(() =>
            loadWorkflowDefFromText(`
name: bad-transition
initialState: start
states:
  - id: start
transitions:
  - from: start
    to: missing
`),
        ).toThrow(WorkflowValidationError);
        expect(() =>
            loadWorkflowDefFromText(`
kind: transition-flow
name: bad-edge
initialNode: start
nodes:
  - id: start
edges:
  - from: start
    to: missing
`),
        ).toThrow(WorkflowValidationError);
    });

    test('surfaces FSM errors and run id collisions', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });

        await expect(
            driver.run(
                {
                    name: 'bad-start',
                    initialState: 'missing',
                    states: [{ id: 'start' }],
                    transitions: [],
                },
                { runId: 'bad-start-run' },
            ),
        ).rejects.toThrow(FSMError);

        const workflow: WorkflowDef = {
            name: 'collision',
            initialState: 'start',
            states: [{ id: 'start' }],
            transitions: [],
        };
        await driver.run(workflow, { runId: 'same-run' });
        await expect(driver.run(workflow, { runId: 'same-run' })).rejects.toThrow(RunCollisionError);
    });

    test('covers transition-flow failure branches', async () => {
        const host = createDefaultWorkflowEngineHost();
        const noEdge = await new TransitionFlowDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        }).run(
            {
                kind: 'transition-flow',
                name: 'no-edge',
                initialNode: 'start',
                nodes: [{ id: 'start' }, { id: 'done' }],
                edges: [{ from: 'start', to: 'done', condition: { kind: 'never' } }],
            },
            { runId: 'no-edge-run' },
        );
        expect(noEdge).toMatchObject({ status: 'failed', reason: 'no-passing-edge' });

        const bound = await new TransitionFlowDriver({
            host,
            persistence: new MemoryWorkflowPersistenceAdapter(),
        }).run(
            {
                kind: 'transition-flow',
                name: 'bound',
                initialNode: 'start',
                iterationBound: 1,
                nodes: [{ id: 'start' }, { id: 'middle' }, { id: 'done' }],
                edges: [
                    { from: 'start', to: 'middle' },
                    { from: 'middle', to: 'done' },
                ],
            },
            { runId: 'bound-run' },
        );
        expect(bound).toMatchObject({ status: 'failed', reason: 'iteration-bound-exceeded' });
    });

    test('covers host shell action success, failure, and option validation', async () => {
        const host = createDefaultWorkflowEngineHost();
        const context = { runId: 'r', stateOrNodeId: 's', vars: {}, env: {}, workdir: process.cwd() };

        await expect(host.runAction('missing', {}, context)).rejects.toThrow(WorkflowValidationError);
        await expect(host.evaluateGuard('missing', {}, { runId: 'r', current: 's', vars: {} })).rejects.toThrow(
            WorkflowValidationError,
        );
        await expect(host.runAction('note', { message: 'hello' }, context)).resolves.toMatchObject({
            ok: true,
            data: { message: 'hello' },
        });
        await expect(host.evaluateGuard('always', {}, { runId: 'r', current: 's', vars: {} })).resolves.toBe(true);
        await expect(host.evaluateGuard('never', {}, { runId: 'r', current: 's', vars: {} })).resolves.toBe(false);
        await expect(
            host.evaluateGuard('action-ok', {}, { runId: 'r', current: 's', vars: {}, lastActionResult: { ok: true } }),
        ).resolves.toBe(true);

        const shell = new ShellActionRunner({
            async run(options) {
                return {
                    command: options.command,
                    args: options.args ?? [],
                    exitCode: options.command === 'fail' ? 2 : 0,
                    stdout: 'out',
                    stderr: 'err',
                    durationMs: 1,
                };
            },
        });
        await expect(shell.execute({ command: 'ok', args: ['a'] }, context)).resolves.toMatchObject({ ok: true });
        await expect(shell.execute({ command: 'fail' }, context)).resolves.toMatchObject({ ok: false });
        await expect(shell.execute({ args: ['a'] }, context)).rejects.toThrow(WorkflowValidationError);
        await expect(shell.execute({ command: 'ok', args: [1] }, context)).rejects.toThrow(WorkflowValidationError);
    });

    test('covers variable resolution branches', () => {
        expect(
            resolveTemplates(
                {
                    array: ['${env' + '.VALUE}', '${state' + '}'],
                    nested: { raw: 1 },
                    flag: true,
                },
                { vars: {}, env: { VALUE: 'env-value' }, builtins: { state: 'ready' } },
            ),
        ).toEqual({ array: ['env-value', 'ready'], nested: { raw: 1 }, flag: true });
        expect(resolveTemplateString('plain', { vars: {}, env: {} })).toBe('plain');
        expect(() => resolveTemplateString('${env' + '.MISSING}', { vars: {}, env: {} })).toThrow(
            WorkflowValidationError,
        );
        expect(() => resolveTemplateString('${missing' + '}', { vars: {}, env: {} })).toThrow(WorkflowValidationError);
    });

    test('covers memory persistence helper methods', async () => {
        const persistence = new MemoryWorkflowPersistenceAdapter();
        await persistence.createRun({
            id: 'memory-run',
            workflow_name: 'memory-workflow',
            mode: 'state-machine',
            status: 'running',
            started_at: 'start',
            completed_at: null,
            metadata_json: '{}',
        });
        await persistence.savePhase('memory-run', 'phase-a', 'done');
        await persistence.saveTransition('memory-run', 'phase-a', 'phase-b', 'next');
        await persistence.saveWorkflowState('memory-run', 'phase-b', { value: 1 });
        await persistence.finalizeRun('memory-run', 'done', 'end');
        await persistence.finalizeRun('missing-run', 'done', 'end');

        expect(await persistence.loadRun('memory-run')).toMatchObject({ status: 'done', completed_at: 'end' });
        expect(await persistence.loadRun('missing-run')).toBeUndefined();
        expect(await persistence.listRuns()).toHaveLength(1);
        expect(persistence.phases).toEqual([{ runId: 'memory-run', phase: 'phase-a', status: 'done' }]);
        expect(persistence.transitions).toEqual([
            { runId: 'memory-run', from: 'phase-a', to: 'phase-b', trigger: 'next' },
        ]);
        expect(persistence.states).toEqual([{ runId: 'memory-run', state: 'phase-b', data: { value: 1 } }]);
    });

    test('covers service load/runFile and DB helper branches', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dual-workflow-service-'));
        const file = join(directory, 'workflow.yaml');
        await writeFile(
            file,
            `
name: run-file
initialState: start
states:
  - id: start
transitions: []
`,
        );
        const service = new WorkflowService(createDefaultWorkflowEngineHost(), new MemoryWorkflowPersistenceAdapter());
        expect(await service.load(file)).toMatchObject({ name: 'run-file' });
        expect(await service.runFile(file, { runId: 'run-file-id' })).toMatchObject({ status: 'done' });

        const db = new DbWorkflowPersistenceAdapter({
            async exec() {},
            async run() {},
            async queryFirst() {
                return undefined;
            },
            async queryAll<T>() {
                return [
                    {
                        id: 'r',
                        workflow_name: 'w',
                        mode: 'm',
                        status: 'done',
                        started_at: 's',
                        completed_at: null,
                        metadata_json: '{}',
                    },
                ] as T[];
            },
            // ts-db 0.2.0: adapters expose the internal typed db via `db` (was getDb()).
            // This persistence adapter only uses the string-SQL methods, so `db` is an
            // unused stub here; the whole literal is cast to DbAdapter below.
            db: {} as DbAdapter['db'],
            close() {},
        } satisfies Partial<DbAdapter> as DbAdapter);
        await db.saveTransition('r', 'a', 'b', null);
        expect(await db.listRuns()).toHaveLength(1);
    });
});
