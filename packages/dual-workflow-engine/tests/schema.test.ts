import { describe, expect, test } from 'bun:test';
import {
    ActionDefSchema,
    GuardDefSchema,
    StateMachineWorkflowDefSchema,
    TransitionFlowWorkflowDefSchema,
    WorkflowDefSchema,
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
