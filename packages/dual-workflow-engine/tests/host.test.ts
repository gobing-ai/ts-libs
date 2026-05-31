import { describe, expect, test } from 'bun:test';
import { WorkflowValidationError } from '../src/errors';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import type { ActionRunner, GuardRunner } from '../src/types';

describe('WorkflowEngineHost', () => {
    test('registers and runs an action', async () => {
        const host = new WorkflowEngineHost();
        const action: ActionRunner = {
            kind: 'greet',
            async execute(options) {
                return { ok: true, data: { greeting: `Hello, ${options.name}` } };
            },
        };
        host.registerAction(action);
        const result = await host.runAction(
            'greet',
            { name: 'world' },
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
            },
        );
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ greeting: 'Hello, world' });
    });

    test('registerAction returns this for chaining', () => {
        const host = new WorkflowEngineHost();
        const action: ActionRunner = {
            kind: 'nop',
            async execute() {
                return { ok: true };
            },
        };
        const result = host.registerAction(action);
        expect(result).toBe(host);
    });

    test('overwrites action with same kind', async () => {
        const host = new WorkflowEngineHost();
        const first: ActionRunner = {
            kind: 'test',
            async execute() {
                return { ok: true, data: { version: 1 } };
            },
        };
        const second: ActionRunner = {
            kind: 'test',
            async execute() {
                return { ok: true, data: { version: 2 } };
            },
        };
        host.registerAction(first).registerAction(second);
        const result = await host.runAction(
            'test',
            {},
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
            },
        );
        expect(result.data).toEqual({ version: 2 });
    });

    test('throws on unknown action', async () => {
        const host = new WorkflowEngineHost();
        await expect(
            host.runAction('missing', {}, { runId: 'r1', stateOrNodeId: 's1', vars: {}, env: {} }),
        ).rejects.toThrow(WorkflowValidationError);
    });

    test('registers and evaluates a guard', async () => {
        const host = new WorkflowEngineHost();
        const guard: GuardRunner = {
            kind: 'isAdmin',
            async evaluate(options) {
                return options.role === 'admin';
            },
        };
        host.registerGuard(guard);
        const pass = await host.evaluateGuard(
            'isAdmin',
            { role: 'admin' },
            {
                runId: 'r1',
                current: 's1',
                vars: {},
            },
        );
        const fail = await host.evaluateGuard(
            'isAdmin',
            { role: 'user' },
            {
                runId: 'r2',
                current: 's1',
                vars: {},
            },
        );
        expect(pass).toBe(true);
        expect(fail).toBe(false);
    });

    test('registerGuard returns this for chaining', () => {
        const host = new WorkflowEngineHost();
        const guard: GuardRunner = {
            kind: 'yes',
            async evaluate() {
                return true;
            },
        };
        expect(host.registerGuard(guard)).toBe(host);
    });

    test('throws on unknown guard', async () => {
        const host = new WorkflowEngineHost();
        await expect(host.evaluateGuard('ghost', {}, { runId: 'r1', current: 's1', vars: {} })).rejects.toThrow(
            WorkflowValidationError,
        );
    });
});

describe('createDefaultWorkflowEngineHost', () => {
    test('creates host with built-in actions and guards', async () => {
        const host = createDefaultWorkflowEngineHost();

        const noteResult = await host.runAction(
            'note',
            { message: 'hello' },
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
            },
        );
        expect(noteResult.ok).toBe(true);
        expect(noteResult.data).toEqual({ message: 'hello' });

        const alwaysTrue = await host.evaluateGuard(
            'always',
            {},
            {
                runId: 'r1',
                current: 's1',
                vars: {},
            },
        );
        expect(alwaysTrue).toBe(true);

        const neverTrue = await host.evaluateGuard(
            'never',
            {},
            {
                runId: 'r1',
                current: 's1',
                vars: {},
            },
        );
        expect(neverTrue).toBe(false);
    });
});
