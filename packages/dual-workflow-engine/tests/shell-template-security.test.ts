import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import { createDefaultWorkflowEngineHost } from '../src/host';
import { MemoryWorkflowPersistenceAdapter } from '../src/persistence';
import { StateMachineDriver } from '../src/state-machine';
import type { ActionResult, ActionRunContext, ActionRunner, WorkflowPersistenceAdapter } from '../src/types';
import { resolveShellCommandTemplates, SHELL_ENV_OPTION } from '../src/variables';

// Workflow runs emit structured run-lifecycle logs by design; mute them in tests.
setLoggerMuted(true);

// `REF(expr)` builds a literal `${expr}` template placeholder without writing `${` in
// a string literal (which would trip the noTemplateCurlyInString lint on these fixtures).
// Same pattern as tests/config.test.ts; produced values are byte-identical.
const REF = (expr: string) => `\${${expr}}`;

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

/** Persistence wrapper that captures what the driver persists for actions. */
class CapturingPersistence extends MemoryWorkflowPersistenceAdapter {
    readonly startedOptions: Array<{ runId: string; node: string; kind: string; options?: Record<string, unknown> }> =
        [];
    readonly finalizedResults: unknown[] = [];

    override async saveActionStart(
        runId: string,
        node: string,
        kind: string,
        options?: Record<string, unknown>,
    ): Promise<string> {
        this.startedOptions.push({ runId, node, kind, options });
        return await super.saveActionStart(runId, node, kind, options);
    }

    override async saveActionFinalize(
        actionId: string,
        status: Parameters<WorkflowPersistenceAdapter['saveActionFinalize']>[1],
        durationMs: number,
        ok: boolean,
        kind: string,
        result?: unknown,
    ): Promise<void> {
        this.finalizedResults.push(result);
        return await super.saveActionFinalize(actionId, status, durationMs, ok, kind, result);
    }
}

describe('shell template binding (task 0086 AC3/AC4/AC5)', () => {
    test('template values cannot inject shell code (AC3)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-'));
        try {
            for (const [index, x] of ['a; touch pwned-1', '$(touch pwned-2)'].entries()) {
                const persistence = new CapturingPersistence();
                const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
                const result = await driver.run(
                    {
                        name: 'shellsec-injection',
                        initialState: 's1',
                        terminalStates: ['done'],
                        states: [
                            {
                                id: 's1',
                                onEnter: [
                                    {
                                        kind: 'shell',
                                        options: {
                                            command: `printf '%s' "\${vars.x}" > out-${index}.txt; echo \${vars.x} >/dev/null`,
                                        },
                                    },
                                ],
                            },
                            { id: 'done' },
                        ],
                        transitions: [{ from: 's1', to: 'done', guard: { kind: 'always' } }],
                    },
                    { workdir: dir, vars: { x } },
                );
                expect(result.status).toBe('done');
                // Substitution must not execute as shell syntax.
                expect(await exists(join(dir, 'pwned-1'))).toBe(false);
                expect(await exists(join(dir, 'pwned-2'))).toBe(false);
                // The double-quoted ref still delivers the value byte-for-byte.
                expect(await readFile(join(dir, `out-${index}.txt`), 'utf8')).toBe(x);
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('persisted action-start options carry the binding, not the value (AC3)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-persist-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            await driver.run(
                {
                    name: 'shellsec-persist',
                    initialState: 's1',
                    terminalStates: ['done'],
                    states: [
                        {
                            id: 's1',
                            onEnter: [{ kind: 'shell', options: { command: `printf %s "${REF('vars.x')}"` } }],
                        },
                        { id: 'done' },
                    ],
                    transitions: [{ from: 's1', to: 'done', guard: { kind: 'always' } }],
                },
                { workdir: dir, vars: { x: 's3cr3t-value' } },
            );
            const started = persistence.startedOptions.filter((entry) => entry.kind === 'shell');
            expect(started.length).toBeGreaterThan(0);
            for (const entry of started) {
                const serialized = JSON.stringify(entry.options);
                expect(serialized).toContain('${__WF_');
                expect(serialized).not.toContain('s3cr3t-value');
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('failed shell action does not leak resolved secrets in its error (AC4)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-leak-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            const result = await driver.run(
                {
                    name: 'shellsec-leak',
                    initialState: 's1',
                    terminalStates: ['done'],
                    env: { allow: ['SECRET_TOKEN'] },
                    states: [
                        {
                            id: 's1',
                            onEnter: [{ kind: 'shell', options: { command: `exit 3 # ${REF('env.SECRET_TOKEN')}` } }],
                        },
                        { id: 'done' },
                    ],
                    transitions: [{ from: 's1', to: 'done', guard: { kind: 'always' } }],
                },
                { workdir: dir, env: { SECRET_TOKEN: 's3cr3t-value' } },
            );
            expect(result.status).toBe('failed');
            const failures = persistence.finalizedResults.filter(
                (entry) => typeof entry === 'object' && entry !== null && (entry as ActionResult).ok === false,
            ) as ActionResult[];
            expect(failures.length).toBeGreaterThan(0);
            for (const failure of failures) {
                expect(String(failure.error)).not.toContain('s3cr3t-value');
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('shell guard gets the same injection guarantee (AC3)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-guard-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            const result = await driver.run(
                {
                    name: 'shellsec-guard',
                    initialState: 's1',
                    terminalStates: ['done'],
                    states: [{ id: 's1' }, { id: 'done' }],
                    transitions: [
                        {
                            from: 's1',
                            to: 'done',
                            guard: {
                                kind: 'shell',
                                options: {
                                    command: `test ! -f pwned-guard && printf '%s' "\${vars.x}" > guard-out.txt`,
                                },
                            },
                        },
                    ],
                },
                { workdir: dir, vars: { x: 'b; touch pwned-guard' } },
            );
            expect(result.status).toBe('done');
            expect(await exists(join(dir, 'pwned-guard'))).toBe(false);
            expect(await readFile(join(dir, 'guard-out.txt'), 'utf8')).toBe('b; touch pwned-guard');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('setVars value produced by an earlier action gets the same guarantee (AC3)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-setvars-'));
        try {
            const setter: ActionRunner = {
                kind: 'evil-setter',
                async execute(_options: Record<string, unknown>, _context?: ActionRunContext): Promise<ActionResult> {
                    return { ok: true, setVars: { x: 'c; touch pwned-setvars' } };
                },
            };
            const host = createDefaultWorkflowEngineHost();
            host.registerAction(setter);
            const driver = new StateMachineDriver({ host, persistence: new CapturingPersistence() });
            const result = await driver.run(
                {
                    name: 'shellsec-setvars',
                    initialState: 's1',
                    terminalStates: ['done'],
                    states: [
                        { id: 's1', onEnter: [{ kind: 'evil-setter' }] },
                        {
                            id: 's2',
                            onEnter: [{ kind: 'shell', options: { command: `printf '%s' "\${vars.x}" > out.txt` } }],
                        },
                        { id: 'done' },
                    ],
                    transitions: [
                        { from: 's1', to: 's2', guard: { kind: 'always' } },
                        { from: 's2', to: 'done', guard: { kind: 'always' } },
                    ],
                },
                { workdir: dir },
            );
            expect(result.status).toBe('done');
            expect(await exists(join(dir, 'pwned-setvars'))).toBe(false);
            expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe('c; touch pwned-setvars');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('argv form keeps raw substitution (AC5)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-argv-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            const result = await driver.run(
                {
                    name: 'shellsec-argv',
                    initialState: 's1',
                    terminalStates: ['done'],
                    states: [
                        {
                            id: 's1',
                            onEnter: [{ kind: 'shell', options: { command: 'printf', args: ['%s', REF('vars.x')] } }],
                        },
                        { id: 'done' },
                    ],
                    transitions: [{ from: 's1', to: 'done', guard: { kind: 'always' } }],
                },
                { workdir: dir, vars: { x: 'a; b' } },
            );
            expect(result.status).toBe('done');
            const shellResults = persistence.finalizedResults.filter(
                (entry) =>
                    typeof entry === 'object' &&
                    entry !== null &&
                    typeof (entry as { data?: unknown }).data === 'object' &&
                    (entry as { data?: object }).data !== null &&
                    'stdout' in (entry as { data: object }).data,
            ) as Array<{ data: { stdout: string } }>;
            expect(shellResults.at(-1)?.data.stdout).toBe('a; b');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('args: [] falls through to shell form: value rides as env, never executed (AC3)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-emptyargs-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            const result = await driver.run(
                {
                    name: 'shellsec-emptyargs',
                    initialState: 's1',
                    terminalStates: ['done'],
                    states: [
                        {
                            id: 's1',
                            onEnter: [
                                {
                                    kind: 'shell',
                                    options: { command: `printf '%s' "${REF('vars.x')}" > out.txt`, args: [] },
                                },
                            ],
                        },
                        { id: 'done' },
                    ],
                    transitions: [{ from: 's1', to: 'done', guard: { kind: 'always' } }],
                },
                { workdir: dir, vars: { x: '$(touch pwned-emptyargs); touch pwned-emptyargs2' } },
            );
            expect(result.status).toBe('done');
            // The metachar value must not execute as shell syntax (raw substitution would).
            expect(await exists(join(dir, 'pwned-emptyargs'))).toBe(false);
            expect(await exists(join(dir, 'pwned-emptyargs2'))).toBe(false);
            // Shell-form env binding still delivers the value byte-for-byte.
            expect(await readFile(join(dir, 'out.txt'), 'utf8')).toBe(
                '$(touch pwned-emptyargs); touch pwned-emptyargs2',
            );
            const started = persistence.startedOptions.filter((entry) => entry.kind === 'shell');
            expect(started.length).toBeGreaterThan(0);
            for (const entry of started) {
                const serialized = JSON.stringify(entry.options);
                expect(serialized).toContain('${__WF_');
                expect(serialized).not.toContain('touch pwned-emptyargs');
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('args: [] failing command does not leak the resolved value in its error (AC4)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-emptyleak-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            const result = await driver.run(
                {
                    name: 'shellsec-emptyargs-leak',
                    initialState: 's1',
                    terminalStates: ['done'],
                    env: { allow: ['SECRET_TOKEN'] },
                    states: [
                        {
                            id: 's1',
                            onEnter: [
                                {
                                    kind: 'shell',
                                    options: { command: `exit 3 # ${REF('env.SECRET_TOKEN')}`, args: [] },
                                },
                            ],
                        },
                        { id: 'done' },
                    ],
                    transitions: [{ from: 's1', to: 'done', guard: { kind: 'always' } }],
                },
                { workdir: dir, env: { SECRET_TOKEN: 's3cr3t-emptyargs' } },
            );
            expect(result.status).toBe('failed');
            const failures = persistence.finalizedResults.filter(
                (entry) => typeof entry === 'object' && entry !== null && (entry as ActionResult).ok === false,
            ) as ActionResult[];
            expect(failures.length).toBeGreaterThan(0);
            for (const failure of failures) {
                expect(String(failure.error)).not.toContain('s3cr3t-emptyargs');
            }
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('resolveShellCommandTemplates (task 0086 R3)', () => {
    const context = { vars: { x: 'a; b' }, env: { E: 'e-value' }, builtins: { __runId: 'r-1' } };

    test('binds refs to numbered env vars and rewrites the command', () => {
        const resolved = resolveShellCommandTemplates(
            { command: `echo "${REF('vars.x')}" ${REF('env.E')} ${REF('__runId')}` },
            context,
        );
        expect(resolved.command).toBe(`echo "${REF('__WF_0')}" ${REF('__WF_1')} ${REF('__WF_2')}`);
        expect(resolved[SHELL_ENV_OPTION]).toEqual({ __WF_0: 'a; b', __WF_1: 'e-value', __WF_2: 'r-1' });
    });

    test('is idempotent for already-bound __WF_n refs', () => {
        const once = resolveShellCommandTemplates({ command: `echo "${REF('vars.x')}"` }, context);
        const twice = resolveShellCommandTemplates(once, context);
        expect(twice.command).toBe(once.command);
    });

    test('leaves non-shell options untouched and tolerates a missing command', () => {
        expect(resolveShellCommandTemplates({ cwd: '/tmp', timeout: 5 }, context)).toEqual({
            cwd: '/tmp',
            timeout: 5,
        });
    });

    test('documented single-quote caveat: bound refs inside single quotes no longer expand', () => {
        const resolved = resolveShellCommandTemplates({ command: `echo '${REF('vars.x')}'` }, context);
        expect(resolved.command).toBe(`echo '${REF('__WF_0')}'`);
    });
});

describe('shell form selection hardening (task 0087 R1/R2/R5/R6)', () => {
    const context = { vars: { x: 'plain-value' }, env: {} as Record<string, string> };

    test('R1: defined non-array args fails closed with a validation error', () => {
        for (const bad of ['x', null, 5]) {
            expect(() => resolveShellCommandTemplates({ command: 'echo hi', args: bad }, context)).toThrow(
                /args.*string array/,
            );
        }
        // args omitted / args: [] stay shell form; non-empty arrays stay argv form
        const shellForm = resolveShellCommandTemplates({ command: `echo ${REF('vars.x')}` }, context);
        expect(SHELL_ENV_OPTION in shellForm).toBe(true);
        const emptyArgs = resolveShellCommandTemplates({ command: `echo ${REF('vars.x')}`, args: [] }, context);
        expect(SHELL_ENV_OPTION in emptyArgs).toBe(true);
        const argvForm = resolveShellCommandTemplates({ command: 'echo', args: [REF('vars.x')] }, context);
        expect(SHELL_ENV_OPTION in argvForm).toBe(false);
        expect(argvForm.args).toEqual(['plain-value']);
    });

    test('R2: authored reserved-namespace literal fails closed; re-resolution stays idempotent', () => {
        expect(() => resolveShellCommandTemplates({ command: `echo ${REF('__WF_0')}` }, context)).toThrow(
            /reserved \$__WF_ placeholder namespace/,
        );
        // Idempotent path: options already carrying a binding pass resolve without throwing,
        // and the binding map survives the second pass (ADV-1).
        const once = resolveShellCommandTemplates({ command: `echo ${REF('vars.x')}` }, context);
        const twice = resolveShellCommandTemplates(once, context);
        expect(twice.command).toBe(once.command);
        expect(twice[SHELL_ENV_OPTION]).toEqual(once[SHELL_ENV_OPTION]);
    });

    test('R2: unbraced $__WF_0 literal is also rejected (braced and unbraced both expand)', () => {
        expect(() => resolveShellCommandTemplates({ command: 'echo $__WF_0' }, context)).toThrow(
            /reserved \$__WF_ placeholder namespace/,
        );
    });

    test('R6: shell guard with args: [] runs shell form with env binding, no injection', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-guard-args-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            const result = await driver.run(
                {
                    name: 'shellsec-guard-args',
                    initialState: 's1',
                    terminalStates: ['done', 'blocked'],
                    states: [{ id: 's1' }, { id: 'done' }, { id: 'blocked' }],
                    transitions: [
                        {
                            from: 's1',
                            to: 'done',
                            guard: {
                                kind: 'shell',
                                options: {
                                    command: `test ! -f pwned-guard-args && printf '%s' "${REF('vars.x')}" > guard-args-out.txt`,
                                    args: [],
                                },
                            },
                        },
                        { from: 's1', to: 'blocked' },
                    ],
                },
                { workdir: dir, vars: { x: 'b; touch pwned-guard-args' } },
            );
            expect(result.status).toBe('done');
            expect(await exists(join(dir, 'pwned-guard-args'))).toBe(false);
            expect(await readFile(join(dir, 'guard-args-out.txt'), 'utf8')).toBe('b; touch pwned-guard-args');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test('R5: shell guard resolves env.MARKER from the run env, same as actions', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'wf-shellsec-guard-env-'));
        try {
            const persistence = new CapturingPersistence();
            const driver = new StateMachineDriver({ host: createDefaultWorkflowEngineHost(), persistence });
            const result = await driver.run(
                {
                    name: 'shellsec-guard-env',
                    initialState: 's1',
                    terminalStates: ['done', 'blocked'],
                    env: { allow: ['MARKER'] },
                    states: [{ id: 's1' }, { id: 'done' }, { id: 'blocked' }],
                    transitions: [
                        {
                            from: 's1',
                            to: 'done',
                            guard: {
                                kind: 'shell',
                                options: { command: `test "${REF('env.MARKER')}" = "known-value"` },
                            },
                        },
                        { from: 's1', to: 'blocked' },
                    ],
                },
                { workdir: dir, env: { MARKER: 'known-value' } },
            );
            expect(result.status).toBe('done');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});
