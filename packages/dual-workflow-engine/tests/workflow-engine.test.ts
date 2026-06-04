import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDbAdapter } from '@gobing-ai/ts-db';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import {
    type ActionRunner,
    applyWorkflowEngineSchema,
    createDefaultWorkflowEngineHost,
    DbWorkflowPersistenceAdapter,
    loadWorkflowDef,
    loadWorkflowDefFromText,
    MemoryWorkflowPersistenceAdapter,
    resolveTemplateString,
    StateMachineDriver,
    TransitionFlowDriver,
    WorkflowEngineHost,
    WorkflowService,
    WorkflowValidationError,
} from '../src';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

class CaptureAction implements ActionRunner {
    readonly kind = 'capture';
    readonly seen: unknown[] = [];

    async execute(options: Record<string, unknown>) {
        this.seen.push(options);
        return { ok: true, data: { captured: options } };
    }
}

describe('dual workflow engine', () => {
    test('runs a state-machine workflow with actions, guards, persistence, and variables', async () => {
        const capture = new CaptureAction();
        const host = new WorkflowEngineHost()
            .registerAction(capture)
            .registerGuard({ kind: 'always', evaluate: async () => true });
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const driver = new StateMachineDriver({ host, persistence });

        const result = await driver.run(
            {
                name: 'smoke',
                initialState: 'start',
                terminalStates: ['done'],
                vars: { message: 'hello' },
                states: [
                    { id: 'start', onEnter: [{ kind: 'capture', options: { message: '${vars' + '.message}' } }] },
                    { id: 'done' },
                ],
                transitions: [{ from: 'start', to: 'done', guard: { kind: 'always' } }],
            },
            { runId: 'run-sm', vars: { message: 'override' } },
        );

        expect(result).toMatchObject({ status: 'done', finalState: 'done', transitionsTaken: 1 });
        expect(capture.seen).toEqual([{ message: 'override' }]);
        expect(persistence.transitions).toEqual([{ runId: 'run-sm', from: 'start', to: 'done', trigger: null }]);
        expect(persistence.states.map((state) => state.state)).toEqual(['start', 'done']);
    });

    test('fails a state-machine workflow when no transition guard passes', async () => {
        const host = new WorkflowEngineHost().registerGuard({ kind: 'never', evaluate: async () => false });
        const driver = new StateMachineDriver({ host, persistence: new MemoryWorkflowPersistenceAdapter() });

        const result = await driver.run(
            {
                name: 'blocked',
                initialState: 'start',
                states: [{ id: 'start' }, { id: 'done' }],
                transitions: [{ from: 'start', to: 'done', guard: { kind: 'never' } }],
            },
            { runId: 'blocked' },
        );

        expect(result).toMatchObject({ status: 'failed', finalState: 'start', reason: 'no-passing-transition' });
    });

    test('runs a transition-flow workflow through the service', async () => {
        const host = createDefaultWorkflowEngineHost();
        const persistence = new MemoryWorkflowPersistenceAdapter();
        const service = new WorkflowService(host, persistence);

        const workflow = loadWorkflowDefFromText(`
kind: transition-flow
name: flow
initialNode: start
terminalNodes: [done]
nodes:
  - id: start
    action:
      kind: note
      options:
        message: flow-start
  - id: done
edges:
  - from: start
    to: done
`);
        const result = await service.run(workflow, { runId: 'run-flow' });

        expect(result).toMatchObject({
            mode: 'transition-flow',
            status: 'done',
            finalState: 'done',
            transitionsTaken: 1,
        });
        expect(await service.listRuns()).toHaveLength(1);
    });

    test('loads workflow files and rejects invalid definitions', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'dual-workflow-'));
        const file = join(directory, 'workflow.yaml');
        await writeFile(
            file,
            `
name: file-workflow
initialState: start
states:
  - id: start
transitions: []
`,
        );

        expect(await loadWorkflowDef(file)).toMatchObject({ name: 'file-workflow' });
        expect(() =>
            loadWorkflowDefFromText(`
name: invalid
initialState: missing
states:
  - id: start
transitions: []
`),
        ).toThrow(WorkflowValidationError);
    });

    test('resolves templates and reports missing variables', () => {
        expect(
            resolveTemplateString('run ${run' + 'Id}: ${vars' + '.name}', {
                vars: { name: 'alpha' },
                env: {},
                builtins: { runId: 'r1' },
            }),
        ).toBe('run r1: alpha');
        expect(() => resolveTemplateString('${vars' + '.missing}', { vars: {}, env: {} })).toThrow(
            WorkflowValidationError,
        );
    });

    test('applies package-owned schema through the DB persistence adapter', async () => {
        const db = await createDbAdapter({ driver: 'bun-sqlite', url: ':memory:' });
        await applyWorkflowEngineSchema(db);
        const persistence = new DbWorkflowPersistenceAdapter(db);
        const driver = new TransitionFlowDriver({
            host: createDefaultWorkflowEngineHost(),
            persistence,
        });

        const result = await driver.run(
            {
                kind: 'transition-flow',
                name: 'db-flow',
                initialNode: 'start',
                nodes: [{ id: 'start' }],
                edges: [],
            },
            { runId: 'db-run' },
        );

        expect(result.status).toBe('done');
        expect(await persistence.loadRun('db-run')).toMatchObject({ id: 'db-run', status: 'done' });
        expect(await persistence.listRuns()).toHaveLength(1);
    });
});
