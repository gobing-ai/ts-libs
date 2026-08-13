import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    ActionDefSchema,
    GuardDefSchema,
    StateMachineWorkflowDefSchema,
    TransitionFlowWorkflowDefSchema,
    WorkflowDefSchema,
    WorkflowExtensionsSchema,
} from '../src/schema';

describe('ActionDefSchema', () => {
    test('accepts minimal action with kind only', () => {
        const result = ActionDefSchema.safeParse({ kind: 'shell' });
        expect(result.success).toBe(true);
        expect(result.data?.kind).toBe('shell');
        expect(result.data?.options).toBeUndefined();
    });

    test('accepts action with options', () => {
        const result = ActionDefSchema.safeParse({
            kind: 'shell',
            options: { command: 'echo hello' },
        });
        expect(result.success).toBe(true);
    });

    test('rejects empty kind', () => {
        const result = ActionDefSchema.safeParse({ kind: '' });
        expect(result.success).toBe(false);
    });
    test('rejects missing kind', () => {
        const result = ActionDefSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    test('accepts onError: "continue"', () => {
        const result = ActionDefSchema.safeParse({ kind: 'shell', onError: 'continue' });
        expect(result.success).toBe(true);
        expect(result.data?.onError).toBe('continue');
    });

    test('accepts onError: "fail"', () => {
        const result = ActionDefSchema.safeParse({ kind: 'shell', onError: 'fail' });
        expect(result.success).toBe(true);
        expect(result.data?.onError).toBe('fail');
    });

    test('rejects invalid onError value', () => {
        const result = ActionDefSchema.safeParse({ kind: 'shell', onError: 'retry' });
        expect(result.success).toBe(false);
    });

    test('omits onError by default', () => {
        const result = ActionDefSchema.safeParse({ kind: 'shell' });
        expect(result.success).toBe(true);
        expect(result.data?.onError).toBeUndefined();
    });
});

describe('GuardDefSchema', () => {
    test('accepts guard with kind and options', () => {
        const result = GuardDefSchema.safeParse({ kind: 'always' });
        expect(result.success).toBe(true);
    });

    test('rejects empty kind', () => {
        const result = GuardDefSchema.safeParse({ kind: '' });
        expect(result.success).toBe(false);
    });
});

describe('StateMachineWorkflowDefSchema', () => {
    const minimal = {
        name: 'wf',
        initialState: 'start',
        states: [{ id: 'start' }, { id: 'end' }],
        transitions: [{ from: 'start', to: 'end' }],
    };

    test('parses minimal valid state-machine definition', () => {
        const result = StateMachineWorkflowDefSchema.safeParse(minimal);
        expect(result.success).toBe(true);
    });

    test('parses with optional fields', () => {
        const full = {
            name: 'full',
            initialState: 'init',
            terminalStates: ['done'],
            iterationBound: 100,
            vars: { HOME: '/tmp' },
            env: { allow: ['PATH'] },
            states: [{ id: 'init', onEnter: [{ kind: 'note' }], onExit: [{ kind: 'shell' }] }, { id: 'done' }],
            transitions: [{ from: 'init', to: 'done', guard: { kind: 'always' } }],
        };
        const result = StateMachineWorkflowDefSchema.safeParse(full);
        expect(result.success).toBe(true);
    });

    test('rejects missing states', () => {
        const result = StateMachineWorkflowDefSchema.safeParse({
            name: 'wf',
            initialState: 's',
            transitions: [],
        });
        expect(result.success).toBe(false);
    });

    test('rejects missing transitions', () => {
        const result = StateMachineWorkflowDefSchema.safeParse({
            name: 'wf',
            initialState: 's',
            states: [{ id: 's' }],
        });
        expect(result.success).toBe(false);
    });

    test('rejects empty state id', () => {
        const result = StateMachineWorkflowDefSchema.safeParse({
            name: 'wf',
            initialState: '',
            states: [],
            transitions: [],
        });
        expect(result.success).toBe(false);
    });

    test('accepts defaultOnError: "continue"', () => {
        const result = StateMachineWorkflowDefSchema.safeParse({
            name: 'wf',
            initialState: 's',
            defaultOnError: 'continue',
            states: [{ id: 's' }, { id: 'done' }],
            transitions: [{ from: 's', to: 'done' }],
        });
        expect(result.success).toBe(true);
        expect(result.data?.defaultOnError).toBe('continue');
    });

    test('rejects invalid defaultOnError', () => {
        const result = StateMachineWorkflowDefSchema.safeParse({
            name: 'wf',
            initialState: 's',
            defaultOnError: 'skip',
            states: [{ id: 's' }],
            transitions: [],
        });
        expect(result.success).toBe(false);
    });
});
describe('TransitionFlowWorkflowDefSchema', () => {
    const minimal = {
        kind: 'transition-flow' as const,
        name: 'flow',
        initialNode: 'a',
        nodes: [{ id: 'a' }, { id: 'b' }],
        edges: [{ from: 'a', to: 'b' }],
    };

    test('parses minimal valid transition-flow definition', () => {
        const result = TransitionFlowWorkflowDefSchema.safeParse(minimal);
        expect(result.success).toBe(true);
    });

    test('parses with node types and conditions', () => {
        const full = {
            kind: 'transition-flow' as const,
            name: 'full-flow',
            initialNode: 'start',
            terminalNodes: ['end'],
            iterationBound: 200,
            vars: { key: 'val' },
            nodes: [
                { id: 'start', type: 'action', action: { kind: 'note' } },
                { id: 'gate', type: 'gate' },
                { id: 'end' },
            ],
            edges: [
                { from: 'start', to: 'gate' },
                { from: 'gate', to: 'end', condition: { kind: 'always' } },
            ],
        };
        const result = TransitionFlowWorkflowDefSchema.safeParse(full);
        expect(result.success).toBe(true);
    });

    test('rejects missing kind', () => {
        const result = TransitionFlowWorkflowDefSchema.safeParse({
            name: 'flow',
            initialNode: 'a',
            nodes: [{ id: 'a' }],
            edges: [],
        });
        expect(result.success).toBe(false);
    });

    test('rejects invalid node type', () => {
        const result = TransitionFlowWorkflowDefSchema.safeParse({
            ...minimal,
            nodes: [{ id: 'a', type: 'invalid' }],
        });
        expect(result.success).toBe(false);
    });

    test('accepts defaultOnError: "continue"', () => {
        const result = TransitionFlowWorkflowDefSchema.safeParse({
            ...minimal,
            defaultOnError: 'continue',
        });
        expect(result.success).toBe(true);
        expect(result.data?.defaultOnError).toBe('continue');
    });
});

describe('WorkflowDefSchema', () => {
    test('parses a state-machine workflow through union schema', () => {
        const result = WorkflowDefSchema.safeParse({
            name: 'union-sm',
            initialState: 'a',
            states: [{ id: 'a' }, { id: 'b' }],
            transitions: [{ from: 'a', to: 'b' }],
        });
        expect(result.success).toBe(true);
        expect(result.data?.kind).toBeUndefined();
    });

    test('parses a transition-flow workflow through union schema', () => {
        const result = WorkflowDefSchema.safeParse({
            kind: 'transition-flow',
            name: 'union-tf',
            initialNode: 'x',
            nodes: [{ id: 'x' }, { id: 'y' }],
            edges: [{ from: 'x', to: 'y' }],
        });
        expect(result.success).toBe(true);
        expect(result.data?.kind).toBe('transition-flow');
    });

    test('rejects invalid shape', () => {
        const result = WorkflowDefSchema.safeParse({ foo: 'bar' });
        expect(result.success).toBe(false);
    });
});

describe('WorkflowExtensionsSchema', () => {
    test('accepts actions and guards arrays', () => {
        const result = WorkflowExtensionsSchema.safeParse({ actions: ['./exts/audit.ts'], guards: ['./exts/flag.ts'] });
        expect(result.success).toBe(true);
        expect(result.data).toEqual({ actions: ['./exts/audit.ts'], guards: ['./exts/flag.ts'] });
    });

    test('accepts an empty object', () => {
        expect(WorkflowExtensionsSchema.safeParse({}).success).toBe(true);
    });

    test('rejects an unknown kind key', () => {
        // rule-engine analog key; must fail, not be silently ignored
        const result = WorkflowExtensionsSchema.safeParse({ evaluators: ['./x.ts'] });
        expect(result.success).toBe(false);
    });

    test('rejects plugins kind', () => {
        expect(WorkflowExtensionsSchema.safeParse({ plugins: ['./p.ts'] }).success).toBe(false);
    });
});

describe.each(['state-machine', 'transition-flow'] as const)('%s dialect extensions', (dialect) => {
    const schema = dialect === 'state-machine' ? StateMachineWorkflowDefSchema : TransitionFlowWorkflowDefSchema;
    const base = (extensions: unknown) =>
        dialect === 'state-machine'
            ? {
                  name: 'wf',
                  initialState: 'a',
                  states: [{ id: 'a' }, { id: 'b' }],
                  transitions: [{ from: 'a', to: 'b' }],
                  ...(extensions === undefined ? {} : { extensions }),
              }
            : {
                  kind: 'transition-flow',
                  name: 'wf',
                  initialNode: 'x',
                  nodes: [{ id: 'x' }, { id: 'y' }],
                  edges: [{ from: 'x', to: 'y' }],
                  ...(extensions === undefined ? {} : { extensions }),
              };

    test('accepts extensions.actions and extensions.guards unchanged', () => {
        const result = schema.safeParse(base({ actions: ['./exts/audit.ts'], guards: ['./exts/flag.ts'] }));
        expect(result.success).toBe(true);
        expect(result.data?.extensions).toEqual({ actions: ['./exts/audit.ts'], guards: ['./exts/flag.ts'] });
    });

    test('a def with no extensions key still parses', () => {
        expect(schema.safeParse(base(undefined)).success).toBe(true);
    });

    test('rejects an empty extension path', () => {
        expect(schema.safeParse(base({ actions: [''] })).success).toBe(false);
    });

    test.each([
        '/abs.ts',
        '\\abs.ts',
        'C:\\x.ts',
        'C:/x.ts',
        '../escape.ts',
        'a/../../x.ts',
    ])('rejects absolute or traversing path %s', (path) => {
        expect(schema.safeParse(base({ actions: [path] })).success).toBe(false);
    });

    test('rejects unknown key inside extensions', () => {
        expect(schema.safeParse(base({ evaluators: ['./x.ts'] })).success).toBe(false);
    });

    test('rejects unknown top-level keys even with extensions present', () => {
        const def = base(undefined) as Record<string, unknown>;
        def.extensions = { actions: ['./exts/audit.ts'] };
        def.initial = 'a'; // old field name must still fail .strict() parse
        expect(schema.safeParse(def).success).toBe(false);
    });
});

describe('packaged JSON schemas declare extensions', () => {
    test.each(['state-machine-workflow', 'transition-flow-workflow'])('%s', async (name) => {
        const json = JSON.parse(await readFile(join(import.meta.dir, '..', 'schemas', `${name}.schema.json`), 'utf8'));
        expect(json.properties.extensions).toBeDefined();
        expect(json.$defs.relativeExtensionPath).toBeDefined();
        expect(json.$defs.extensions.properties.actions.items.$ref).toBe('#/$defs/relativeExtensionPath');
        expect(json.$defs.extensions.additionalProperties).toBe(false);
    });
});
