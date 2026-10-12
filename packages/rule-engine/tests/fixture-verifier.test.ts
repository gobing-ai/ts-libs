import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setLoggerMuted } from '@gobing-ai/ts-infra';
import type {
    PipeProcess,
    PipeProcessOptions,
    ProcessExecutor,
    ProcessOptions,
    ProcessResult,
} from '@gobing-ai/ts-runtime';
import { verifyRuleFixtures } from '../src/fixture-verifier';

setLoggerMuted(true);

/** Rule that reports a violation when a scanned line contains `NEEDLE`. */
const REGEX_RULE = [
    'rules:',
    '  - id: no-needle',
    '    description: no needle',
    '    include:',
    '      - "src/**/*.ts"',
    '    evaluator:',
    '      type: regex',
    '      config:',
    '        pattern: "NEEDLE"',
    '',
].join('\n');

/** Exit-code rule whose configured success code varies per test. */
function exitRule(successCode: number, enabled = true): string {
    return [
        'rules:',
        '  - id: check-exit',
        '    description: check exit',
        `    enabled: ${enabled}`,
        '    evaluator:',
        '      type: exit-code',
        '      config:',
        '        command: probe',
        `        successCode: ${successCode}`,
        '',
    ].join('\n');
}

/** Executor returning canned results, mirroring the engine test double. */
class FakeExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(private readonly respond: (options: ProcessOptions) => Partial<ProcessResult> = () => ({})) {}

    async run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            outcome: 'exit',
            ...this.respond(options),
        };
    }

    runStreaming(options: PipeProcessOptions): PipeProcess {
        throw new Error(`runStreaming is not exercised by the verifier: ${options.command}`);
    }
}

interface Workspace {
    readonly root: string;
    readonly ruleFile: string;
    readonly fixtureDir: string;
}

/** Temporary rule file plus fixture root; callers stage case files and workdirs. */
async function makeWorkspace(ruleYaml: string): Promise<Workspace> {
    const root = await mkdtemp(join(tmpdir(), 'rule-fixture-verifier-'));
    const ruleFile = join(root, 'rule.yaml');
    await writeFile(ruleFile, ruleYaml);
    const fixtureDir = join(root, 'fixtures');
    await mkdir(fixtureDir, { recursive: true });
    return { root, ruleFile, fixtureDir };
}

/** Write one fixture source file the case points at for its existence check. */
async function writeFixtureSource(
    workspace: Workspace,
    path: string,
    content = 'export const x = 1;\n',
): Promise<void> {
    const target = join(workspace.fixtureDir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
}

/** Stage a prepared workdir containing the given relative files. */
async function stageWorkdir(workspace: Workspace, name: string, files: Record<string, string>): Promise<string> {
    const workdir = join(workspace.root, 'workdirs', name);
    for (const [rel, content] of Object.entries(files)) {
        const target = join(workdir, rel);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
    }
    return workdir;
}

describe('verifyRuleFixtures — ordinary evaluators', () => {
    test('passes isolated expected-fire and expected-pass cases', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts', 'const x = NEEDLE;\n');
            await writeFixtureSource(workspace, 'should-pass/b.ts', 'const x = 1;\n');
            const fireWorkdir = await stageWorkdir(workspace, 'fire', { 'src/a.ts': 'const x = NEEDLE;\n' });
            const passWorkdir = await stageWorkdir(workspace, 'pass', { 'src/b.ts': 'const x = 1;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [
                    { path: 'should-fire/a.ts', workdir: fireWorkdir, ruleIds: ['no-needle'], expect: 'fire' },
                    { path: 'should-pass/b.ts', workdir: passWorkdir, ruleIds: ['no-needle'], expect: 'pass' },
                ],
            });

            expect(result.skipped).toBe(false);
            expect(result.pass).toBe(true);
            expect(result.cases.map((c) => c.pass)).toEqual([true, true]);
            expect(result.cases[0]?.findings).toHaveLength(1);
            expect(result.cases[1]?.findings).toHaveLength(0);
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('fails an expected-fire case whose evaluator reports no violation', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            const workdir = await stageWorkdir(workspace, 'quiet', { 'src/a.ts': 'const x = 1;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [{ path: 'should-fire/a.ts', workdir, ruleIds: ['no-needle'], expect: 'fire' }],
            });

            expect(result.pass).toBe(false);
            expect(result.cases).toHaveLength(1);
            expect(result.cases[0]?.path).toBe('should-fire/a.ts');
            expect(result.cases[0]?.ruleId).toBe('no-needle');
            expect(result.cases[0]?.expect).toBe('fire');
            expect(result.cases[0]?.error).toContain('expected fire');
            expect(result.cases[0]?.error).toContain('no violation');
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('fails an expected-pass case that produces a finding', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            await writeFixtureSource(workspace, 'should-pass/b.ts');
            const workdir = await stageWorkdir(workspace, 'noisy', { 'src/b.ts': 'const x = NEEDLE;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [{ path: 'should-pass/b.ts', workdir, ruleIds: ['no-needle'], expect: 'pass' }],
            });

            expect(result.pass).toBe(false);
            expect(result.cases[0]?.error).toContain('expected pass');
            expect(result.cases[0]?.error).toContain('1 violation');
            expect(result.cases[0]?.findings).toHaveLength(1);
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('an evaluator error cannot satisfy an expected violation', async () => {
        const workspace = await makeWorkspace(
            [
                'rules:',
                '  - id: broken',
                '    description: broken',
                '    evaluator:',
                '      type: not-a-builtin',
                '',
            ].join('\n'),
        );
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            const workdir = await stageWorkdir(workspace, 'broken', { 'src/a.ts': 'const x = NEEDLE;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [{ path: 'should-fire/a.ts', workdir, ruleIds: ['broken'], expect: 'fire' }],
            });

            expect(result.pass).toBe(false);
            expect(result.cases[0]?.pass).toBe(false);
            expect(result.cases[0]?.error).toContain('evaluator error');
            expect(result.cases[0]?.findings.every((finding) => finding.kind === 'error')).toBe(true);
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });
});

describe('verifyRuleFixtures — exit-code rules', () => {
    test('compares the recorded exit against the configured successCode and reports it on mismatch', async () => {
        const workspace = await makeWorkspace(exitRule(1));
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            const workdir = await stageWorkdir(workspace, 'exit', { 'src/a.ts': 'export const x = 1;\n' });
            const executor = new FakeExecutor(() => ({ exitCode: 1, outcome: 'exit' }));

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [{ path: 'should-fire/a.ts', workdir, ruleIds: ['check-exit'], expect: 'fire' }],
                processExecutor: executor,
            });

            expect(result.pass).toBe(false);
            expect(result.cases[0]?.error).toContain('successCode 1');
            expect(result.cases[0]?.processes).toHaveLength(1);
            expect(result.cases[0]?.processes[0]?.exitCode).toBe(1);
            expect(executor.calls[0]?.cwd).toBe(workdir);
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('accepts expected-fire and expected-pass exit-code cases against the default successCode', async () => {
        const workspace = await makeWorkspace(exitRule(0));
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            await writeFixtureSource(workspace, 'should-pass/b.ts');
            const fireWorkdir = await stageWorkdir(workspace, 'fire', { 'src/a.ts': 'export const x = 1;\n' });
            const passWorkdir = await stageWorkdir(workspace, 'pass', { 'src/b.ts': 'export const x = 1;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [
                    { path: 'should-fire/a.ts', workdir: fireWorkdir, ruleIds: ['check-exit'], expect: 'fire' },
                    { path: 'should-pass/b.ts', workdir: passWorkdir, ruleIds: ['check-exit'], expect: 'pass' },
                ],
                processExecutor: new FakeExecutor((options) =>
                    options.cwd === fireWorkdir ? { exitCode: 1, outcome: 'exit' } : {},
                ),
            });

            expect(result.pass).toBe(true);
            expect(result.cases.map((c) => c.pass)).toEqual([true, true]);
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('retains stdout and stderr in failure diagnostics', async () => {
        const workspace = await makeWorkspace(exitRule(0));
        try {
            await writeFixtureSource(workspace, 'should-pass/b.ts');
            const workdir = await stageWorkdir(workspace, 'noisy', { 'src/b.ts': 'export const x = 1;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [{ path: 'should-pass/b.ts', workdir, ruleIds: ['check-exit'], expect: 'pass' }],
                processExecutor: new FakeExecutor(() => ({
                    exitCode: 1,
                    stdout: 'boom-out',
                    stderr: 'boom-err',
                })),
            });

            expect(result.pass).toBe(false);
            expect(result.cases[0]?.error).toContain('boom-out');
            expect(result.cases[0]?.error).toContain('boom-err');
            expect(result.cases[0]?.processes[0]?.stdout).toBe('boom-out');
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('fails on timeout, spawn error and launch failure even for expected fire', async () => {
        const workspace = await makeWorkspace(exitRule(0));
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            const timeouts = await stageWorkdir(workspace, 'timeout', { 'src/a.ts': 'export const x = 1;\n' });
            const spawnErrors = await stageWorkdir(workspace, 'spawn-error', { 'src/a.ts': 'export const x = 1;\n' });
            const launches = await stageWorkdir(workspace, 'launch', { 'src/a.ts': 'export const x = 1;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [
                    { path: 'should-fire/a.ts', workdir: timeouts, ruleIds: ['check-exit'], expect: 'fire' },
                    { path: 'should-fire/a.ts', workdir: spawnErrors, ruleIds: ['check-exit'], expect: 'fire' },
                    { path: 'should-fire/a.ts', workdir: launches, ruleIds: ['check-exit'], expect: 'fire' },
                ],
                processExecutor: {
                    run: async (options: ProcessOptions): Promise<ProcessResult> => {
                        if (options.cwd === launches) throw new Error('spawn probe ENOENT');
                        return {
                            command: options.command,
                            args: options.args ?? [],
                            exitCode: null,
                            stdout: '',
                            stderr: '',
                            durationMs: 1,
                            outcome: options.cwd === timeouts ? 'timeout' : 'error',
                        };
                    },
                    runStreaming: () => {
                        throw new Error('unused');
                    },
                },
            });

            expect(result.pass).toBe(false);
            expect(result.cases[0]?.error).toContain('timeout');
            expect(result.cases[1]?.error).toContain('error');
            expect(result.cases[2]?.error).toContain('evaluator error');
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });
});

describe('verifyRuleFixtures — absence and invalid declarations', () => {
    test('skips when the optional fixture directory is absent', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: join(workspace.root, 'does-not-exist'),
                cases: [{ path: 'should-fire/a.ts', workdir: workspace.root, ruleIds: ['no-needle'], expect: 'fire' }],
            });

            expect(result).toEqual({ pass: true, skipped: true, cases: [] });
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('fails an existing but empty case set', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [],
            });

            expect(result).toEqual({ pass: false, skipped: false, cases: [] });
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('rejects a fixture root that exists as a file instead of skipping it', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            const fixtureFile = join(workspace.root, 'fixture-file');
            await writeFile(fixtureFile, 'not a directory');
            await expect(
                verifyRuleFixtures({ ruleFile: workspace.ruleFile, fixtureDir: fixtureFile, cases: [] }),
            ).rejects.toThrow('not a directory');
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('fails an unknown rule ID and a disabled rule ID', async () => {
        const workspace = await makeWorkspace(exitRule(0, false));
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            const workdir = await stageWorkdir(workspace, 'ids', { 'src/a.ts': 'export const x = 1;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [{ path: 'should-fire/a.ts', workdir, ruleIds: ['missing-rule', 'check-exit'], expect: 'fire' }],
                processExecutor: new FakeExecutor(() => ({ exitCode: 1 })),
            });

            expect(result.pass).toBe(false);
            expect(result.cases[0]?.error).toContain('not an enabled rule');
            expect(result.cases[1]?.error).toContain('not an enabled rule');
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('fails an absent case workdir and a missing case source', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            const workdir = await stageWorkdir(workspace, 'staged', { 'src/a.ts': 'const x = NEEDLE;\n' });

            const result = await verifyRuleFixtures({
                ruleFile: workspace.ruleFile,
                fixtureDir: workspace.fixtureDir,
                cases: [
                    {
                        path: 'should-fire/a.ts',
                        workdir: join(workspace.root, 'missing-workdir'),
                        ruleIds: ['no-needle'],
                        expect: 'fire',
                    },
                    { path: 'should-fire/absent.ts', workdir, ruleIds: ['no-needle'], expect: 'fire' },
                ],
            });

            expect(result.pass).toBe(false);
            expect(result.cases[0]?.error).toContain('workdir');
            expect(result.cases[1]?.error).toContain('missing under');
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });

    test('throws on invalid configuration: no selected rule IDs, extension declarations, unreadable rule file', async () => {
        const workspace = await makeWorkspace(REGEX_RULE);
        try {
            await writeFixtureSource(workspace, 'should-fire/a.ts');
            const workdir = await stageWorkdir(workspace, 'staged', { 'src/a.ts': 'const x = NEEDLE;\n' });
            const base = { ruleFile: workspace.ruleFile, fixtureDir: workspace.fixtureDir };

            await expect(
                verifyRuleFixtures({
                    ...base,
                    cases: [{ path: 'should-fire/a.ts', workdir, ruleIds: [], expect: 'fire' }],
                }),
            ).rejects.toThrow('selects no rule IDs');

            const extensionRule = join(workspace.root, 'extension-rule.yaml');
            await writeFile(
                extensionRule,
                [
                    'extensions:',
                    '  evaluators:',
                    '    - ./custom-evaluator.ts',
                    'rules:',
                    '  - id: no-needle',
                    '    description: no needle',
                    '    evaluator:',
                    '      type: regex',
                    '      config:',
                    '        pattern: "NEEDLE"',
                    '',
                ].join('\n'),
            );
            await expect(
                verifyRuleFixtures({
                    ruleFile: extensionRule,
                    fixtureDir: workspace.fixtureDir,
                    cases: [{ path: 'should-fire/a.ts', workdir, ruleIds: ['no-needle'], expect: 'fire' }],
                }),
            ).rejects.toThrow('built-in rules only');

            await expect(
                verifyRuleFixtures({
                    ruleFile: join(workspace.root, 'absent-rule.yaml'),
                    fixtureDir: workspace.fixtureDir,
                    cases: [{ path: 'should-fire/a.ts', workdir, ruleIds: ['no-needle'], expect: 'fire' }],
                }),
            ).rejects.toThrow();
        } finally {
            await rm(workspace.root, { recursive: true, force: true });
        }
    });
});
