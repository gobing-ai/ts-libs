import { describe, expect, test } from 'bun:test';
import { EventBus } from '@gobing-ai/ts-infra';
import { WorkflowValidationError } from '../src/errors';
import type { WorkflowEngineEvents } from '../src/events';
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

describe('WorkflowEngineHost introspection', () => {
    test('hasAction / hasGuard reflect registration', () => {
        const host = new WorkflowEngineHost();
        expect(host.hasAction('a')).toBe(false);
        host.registerAction({
            kind: 'a',
            async execute() {
                return { ok: true };
            },
        });
        expect(host.hasAction('a')).toBe(true);
        expect(host.hasGuard('g')).toBe(false);
        host.registerGuard({
            kind: 'g',
            async evaluate() {
                return true;
            },
        });
        expect(host.hasGuard('g')).toBe(true);
    });

    test('listActions / listGuards return kinds in registration order', () => {
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'second',
                async execute() {
                    return { ok: true };
                },
            })
            .registerAction({
                kind: 'first',
                async execute() {
                    return { ok: true };
                },
            })
            .registerGuard({
                kind: 'gb',
                async evaluate() {
                    return true;
                },
            })
            .registerGuard({
                kind: 'ga',
                async evaluate() {
                    return false;
                },
            });
        expect(host.listActions()).toEqual(['second', 'first']);
        expect(host.listGuards()).toEqual(['gb', 'ga']);
    });

    test('re-registering the same kind replaces without duplicating the listing', () => {
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'x',
                async execute() {
                    return { ok: true };
                },
            })
            .registerAction({
                kind: 'x',
                async execute() {
                    return { ok: true };
                },
            });
        expect(host.listActions()).toEqual(['x']);
    });
});

describe('createDefaultWorkflowEngineHost', () => {
    test('registers all built-ins with origin "builtin"', () => {
        const host = createDefaultWorkflowEngineHost();
        expect(host.listActions().sort()).toEqual(['event.emit', 'note', 'shell']);
        expect(host.listGuards().sort()).toEqual(['action-ok', 'always', 'never', 'shell']);
        for (const kind of host.listActions()) expect(host.actionOrigin(kind)).toBe('builtin');
        for (const kind of host.listGuards()) expect(host.guardOrigin(kind)).toBe('builtin');
    });

    test('extension-registered capabilities carry origin "extension" by default', () => {
        const host = new WorkflowEngineHost()
            .registerAction({
                kind: 'ext-action',
                async execute() {
                    return { ok: true };
                },
            })
            .registerGuard({
                kind: 'ext-guard',
                async evaluate() {
                    return true;
                },
            });
        expect(host.actionOrigin('ext-action')).toBe('extension');
        expect(host.guardOrigin('ext-guard')).toBe('extension');
        expect(host.actionOrigin('nonexistent')).toBeUndefined();
    });

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
        expect(host.hasGuard('shell')).toBe(true);
    });

    test('event.emit emits workflow.custom with name and payload via context.events', async () => {
        const emitted: Array<{ name: string; payload: Record<string, unknown>; severity: string }> = [];
        const events = new EventBus<WorkflowEngineEvents>();
        events.on('workflow.custom', (data) => emitted.push(data));

        const host = createDefaultWorkflowEngineHost();
        const result = await host.runAction(
            'event.emit',
            { name: 'checkpoint', payload: { task: 'build' } },
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
                events,
            },
        );
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ name: 'checkpoint', payload: { task: 'build' } });
        // The event may have been emitted async (void); give microtask queue a tick.
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(emitted).toEqual([{ name: 'checkpoint', payload: { task: 'build' }, severity: 'info' }]);
    });

    test('event.emit returns failure when name is missing', async () => {
        const host = createDefaultWorkflowEngineHost();
        const result = await host.runAction(
            'event.emit',
            {},
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
            },
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain('name');
    });

    test('event.emit with empty name returns failure', async () => {
        const host = createDefaultWorkflowEngineHost();
        const result = await host.runAction(
            'event.emit',
            { name: '' },
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
            },
        );
        expect(result.ok).toBe(false);
    });

    test('event.emit is a no-op when no EventBus in context (no events field)', async () => {
        const host = createDefaultWorkflowEngineHost();
        const result = await host.runAction(
            'event.emit',
            { name: 'checkpoint' },
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
            },
        );
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ name: 'checkpoint', payload: {} });
    });

    test('note emits workflow.hitl.note event while staying a no-op success', async () => {
        const notes: Array<{ runId: string; node: string; message: string; severity: string }> = [];
        const events = new EventBus<WorkflowEngineEvents>();
        events.on('workflow.hitl.note', (data) => notes.push(data));

        const host = createDefaultWorkflowEngineHost();
        const result = await host.runAction(
            'note',
            { message: 'hello world' },
            {
                runId: 'r1',
                stateOrNodeId: 'checkpoint-1',
                vars: {},
                env: {},
                events,
            },
        );
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ message: 'hello world' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(notes).toEqual([{ runId: 'r1', node: 'checkpoint-1', message: 'hello world', severity: 'info' }]);
    });

    test('note still works without EventBus in context (backward-compatible)', async () => {
        const host = createDefaultWorkflowEngineHost();
        const result = await host.runAction(
            'note',
            { message: 'hello' },
            {
                runId: 'r1',
                stateOrNodeId: 's1',
                vars: {},
                env: {},
            },
        );
        expect(result.ok).toBe(true);
        expect(result.data).toEqual({ message: 'hello' });
    });
});
