import { describe, expect, test } from 'bun:test';
import {
    type LoadWorkflowExtensionsOptions,
    loadWorkflowExtensionsIntoHost,
    type WorkflowExtensionRef,
} from '../src/extensions';
import { createDefaultWorkflowEngineHost, WorkflowEngineHost } from '../src/host';
import type { ActionRunner, GuardRunner } from '../src/types';

function defaultOptions(overrides: Partial<LoadWorkflowExtensionsOptions> = {}): LoadWorkflowExtensionsOptions {
    return {
        allowExtensions: true,
        moduleLoader: async () => {
            throw new Error('moduleLoader should not be called');
        },
        ...overrides,
    };
}

describe('loadWorkflowExtensionsIntoHost trust gate', () => {
    test('is a no-op for empty refs', async () => {
        const host = createDefaultWorkflowEngineHost();
        await expect(loadWorkflowExtensionsIntoHost(host, [], defaultOptions())).resolves.toBeUndefined();
    });

    test('throws when extensions are present but allowExtensions is not true (default)', async () => {
        const host = createDefaultWorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/x/custom.ts', sourceName: 'test' }];
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                ...defaultOptions(),
                allowExtensions: undefined,
            }),
        ).rejects.toThrow('extensions are disabled');
    });

    test('throws when allowExtensions is explicitly false', async () => {
        const host = createDefaultWorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [{ kind: 'guards', absPath: '/x/custom.ts', sourceName: 'test' }];
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                ...defaultOptions(),
                allowExtensions: false,
            }),
        ).rejects.toThrow('extensions are disabled');
    });

    test('throws before moduleLoader is called when gate is disabled', async () => {
        const host = createDefaultWorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/x/custom.ts', sourceName: 'test' }];
        let called = false;
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                allowExtensions: false,
                moduleLoader: async () => {
                    called = true;
                    return {};
                },
            }),
        ).rejects.toThrow('extensions are disabled');
        // The loader must throw BEFORE calling moduleLoader — the gate is fail-closed.
        expect(called).toBe(false);
    });
});

describe('loadWorkflowExtensionsIntoHost action registration', () => {
    test('registers actions from extension module', async () => {
        const host = new WorkflowEngineHost();
        const greetAction: ActionRunner = {
            kind: 'greet',
            async execute(options) {
                return { ok: true, data: { message: `Hello, ${options.name}` } };
            },
        };

        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/ext/greet.ts', sourceName: 'greet-ext' }];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            moduleLoader: async () => ({
                default: {
                    name: 'greet-extension',
                    actions: [greetAction],
                },
            }),
        });

        expect(host.hasAction('greet')).toBe(true);
        expect(host.actionOrigin('greet')).toBe('extension');
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
        expect(result.data).toEqual({ message: 'Hello, world' });
    });

    test('registers multiple actions from one extension module', async () => {
        const host = new WorkflowEngineHost();
        const actionA: ActionRunner = {
            kind: 'a',
            async execute() {
                return { ok: true };
            },
        };
        const actionB: ActionRunner = {
            kind: 'b',
            async execute() {
                return { ok: true };
            },
        };

        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/ext/multi.ts', sourceName: 'multi-ext' }];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            moduleLoader: async () => ({
                default: {
                    name: 'multi',
                    actions: [actionA, actionB],
                },
            }),
        });

        expect(host.listActions().sort()).toEqual(['a', 'b']);
    });
});

describe('loadWorkflowExtensionsIntoHost guard registration', () => {
    test('registers guards from extension module', async () => {
        const host = new WorkflowEngineHost();
        const isEvenGuard: GuardRunner = {
            kind: 'isEven',
            async evaluate(options) {
                return Number(options.value) % 2 === 0;
            },
        };

        const refs: WorkflowExtensionRef[] = [{ kind: 'guards', absPath: '/ext/guard.ts', sourceName: 'is-even-ext' }];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            moduleLoader: async () => ({
                default: {
                    name: 'is-even',
                    guards: [isEvenGuard],
                },
            }),
        });

        expect(host.hasGuard('isEven')).toBe(true);
        expect(host.guardOrigin('isEven')).toBe('extension');
        const pass = await host.evaluateGuard(
            'isEven',
            { value: 4 },
            {
                runId: 'r1',
                current: 's1',
                vars: {},
            },
        );
        const fail = await host.evaluateGuard(
            'isEven',
            { value: 3 },
            {
                runId: 'r2',
                current: 's1',
                vars: {},
            },
        );
        expect(pass).toBe(true);
        expect(fail).toBe(false);
    });
});

describe('loadWorkflowExtensionsIntoHost export validation', () => {
    test('throws when module lacks a string name (shared loader check)', async () => {
        const host = new WorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/ext/bad.ts', sourceName: 'bad-ext' }];
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                allowExtensions: true,
                moduleLoader: async () => ({ default: { notName: true } }),
            }),
        ).rejects.toThrow('must export an object with a string "name"');
    });

    test('throws when actions ref points to module without actions[]', async () => {
        const host = new WorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/ext/no-actions.ts', sourceName: 'no-act' }];
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                allowExtensions: true,
                moduleLoader: async () => ({
                    default: {
                        name: 'guard-only',
                        guards: [
                            {
                                kind: 'g',
                                async evaluate() {
                                    return true;
                                },
                            },
                        ],
                    },
                }),
            }),
        ).rejects.toThrow(/does not export an actions\[\] array/);
    });

    test('throws when guards ref points to module without guards[]', async () => {
        const host = new WorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [{ kind: 'guards', absPath: '/ext/no-guards.ts', sourceName: 'no-grd' }];
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                allowExtensions: true,
                moduleLoader: async () => ({
                    default: {
                        name: 'action-only',
                        actions: [
                            {
                                kind: 'a',
                                async execute() {
                                    return { ok: true };
                                },
                            },
                        ],
                    },
                }),
            }),
        ).rejects.toThrow(/does not export a guards\[\] array/);
    });

    test('registers only actions when module exports both arrays and ref is actions', async () => {
        const host = new WorkflowEngineHost();
        const action: ActionRunner = {
            kind: 'dual-action',
            async execute() {
                return { ok: true };
            },
        };
        const guard: GuardRunner = {
            kind: 'dual-guard',
            async evaluate() {
                return true;
            },
        };

        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/ext/dual.ts', sourceName: 'dual-ext' }];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            moduleLoader: async () => ({
                default: {
                    name: 'dual-bundle',
                    actions: [action],
                    guards: [guard],
                },
            }),
        });

        expect(host.hasAction('dual-action')).toBe(true);
        expect(host.hasGuard('dual-guard')).toBe(false);
    });

    test('registers only guards when module exports both arrays and ref is guards', async () => {
        const host = new WorkflowEngineHost();
        const action: ActionRunner = {
            kind: 'dual-action',
            async execute() {
                return { ok: true };
            },
        };
        const guard: GuardRunner = {
            kind: 'dual-guard',
            async evaluate() {
                return true;
            },
        };

        const refs: WorkflowExtensionRef[] = [{ kind: 'guards', absPath: '/ext/dual.ts', sourceName: 'dual-ext' }];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            moduleLoader: async () => ({
                default: {
                    name: 'dual-bundle',
                    actions: [action],
                    guards: [guard],
                },
            }),
        });

        expect(host.hasGuard('dual-guard')).toBe(true);
        expect(host.hasAction('dual-action')).toBe(false);
    });
});

describe('loadWorkflowExtensionsIntoHost override warnings', () => {
    test('warns when extension action overrides a built-in', async () => {
        const warnings: string[] = [];
        const host = createDefaultWorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [
            { kind: 'actions', absPath: '/ext/override.ts', sourceName: 'override-ext' },
        ];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            logger: { warn: (msg) => warnings.push(msg) },
            moduleLoader: async () => ({
                default: {
                    name: 'note-override',
                    actions: [
                        {
                            kind: 'note',
                            async execute() {
                                return { ok: true };
                            },
                        },
                    ],
                },
            }),
        });

        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('overrides built-in action "note"');
    });

    test('warns when extension guard overrides a built-in', async () => {
        const warnings: string[] = [];
        const host = createDefaultWorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [
            { kind: 'guards', absPath: '/ext/override.ts', sourceName: 'override-ext' },
        ];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            logger: { warn: (msg) => warnings.push(msg) },
            moduleLoader: async () => ({
                default: {
                    name: 'always-override',
                    guards: [
                        {
                            kind: 'always',
                            async evaluate() {
                                return false;
                            },
                        },
                    ],
                },
            }),
        });

        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain('overrides built-in guard "always"');
    });

    test('does not warn when extension adds a new (non-override) capability', async () => {
        const warnings: string[] = [];
        const host = createDefaultWorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [{ kind: 'actions', absPath: '/ext/new.ts', sourceName: 'new-ext' }];
        await loadWorkflowExtensionsIntoHost(host, refs, {
            allowExtensions: true,
            logger: { warn: (msg) => warnings.push(msg) },
            moduleLoader: async () => ({
                default: {
                    name: 'new-action',
                    actions: [
                        {
                            kind: 'new-action',
                            async execute() {
                                return { ok: true };
                            },
                        },
                    ],
                },
            }),
        });

        expect(warnings.length).toBe(0);
    });

    test('does not warn when extension overrides a previously extension-registered capability', async () => {
        const warnings: string[] = [];
        const host = new WorkflowEngineHost();

        await loadWorkflowExtensionsIntoHost(
            host,
            [{ kind: 'actions', absPath: '/ext/first.ts', sourceName: 'first-ext' }],
            {
                allowExtensions: true,
                moduleLoader: async () => ({
                    default: {
                        name: 'first',
                        actions: [
                            {
                                kind: 'x',
                                async execute() {
                                    return { ok: true };
                                },
                            },
                        ],
                    },
                }),
            },
        );

        // Second extension overrides 'x' — origin is 'extension', not 'builtin', so no warning.
        await loadWorkflowExtensionsIntoHost(
            host,
            [{ kind: 'actions', absPath: '/ext/second.ts', sourceName: 'second-ext' }],
            {
                allowExtensions: true,
                logger: { warn: (msg) => warnings.push(msg) },
                moduleLoader: async () => ({
                    default: {
                        name: 'second',
                        actions: [
                            {
                                kind: 'x',
                                async execute() {
                                    return { ok: true };
                                },
                            },
                        ],
                    },
                }),
            },
        );

        expect(warnings.length).toBe(0);
    });
});

describe('loadWorkflowExtensionsIntoHost path traversal guard', () => {
    test('rejects absPath containing .. traversal (R6 pre-check)', async () => {
        const host = new WorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [
            { kind: 'actions', absPath: '/ext/../escape.ts', sourceName: 'escape-ext' },
        ];
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                allowExtensions: true,
                moduleLoader: async () => ({ default: { name: 'x', actions: [] } }),
            }),
        ).rejects.toThrow('".." traversal');
    });

    test('rejects .. traversal in deep paths', async () => {
        const host = new WorkflowEngineHost();
        const refs: WorkflowExtensionRef[] = [
            { kind: 'actions', absPath: '/a/b/../../../etc/passwd.ts', sourceName: 'bad' },
        ];
        await expect(
            loadWorkflowExtensionsIntoHost(host, refs, {
                allowExtensions: true,
                moduleLoader: async () => ({}),
            }),
        ).rejects.toThrow('".." traversal');
    });
});
