import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProcessExecutor, ProcessOptions, ProcessResult } from '@gobing-ai/ts-runtime';
import {
    CapabilityRegistry,
    type ConstraintRule,
    createFinding,
    JsonFormatter,
    loadPresetRules,
    loadRuleFile,
    RuleEngine,
    TextFormatter,
} from '../src';
import { AgentDetectionEvaluator } from '../src/evaluators/agent-detection-evaluator';
import { matchesAny, relativeParent, relativeToWorkdir } from '../src/evaluators/file-utils';
import { RuleEngineHost } from '../src/host/rule-engine-host';

class FakeExecutor implements ProcessExecutor {
    readonly calls: ProcessOptions[] = [];

    constructor(private readonly responder: (options: ProcessOptions) => Partial<ProcessResult> = () => ({})) {}

    async run(options: ProcessOptions): Promise<ProcessResult> {
        this.calls.push(options);
        const response = this.responder(options);
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: 0,
            stdout: '',
            stderr: '',
            durationMs: 1,
            ...response,
        };
    }

    runStreaming(): never {
        throw new Error('FakeExecutor.runStreaming not implemented');
    }
}

describe('RuleEngine', () => {
    test('evaluates forbidden imports', async () => {
        const dir = await makeTempProject();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'index.ts'), "import { x } from '@spur/core';\nimport '@spur/contracts';\n");
        const rule: ConstraintRule = {
            id: 'no-spur-imports',
            description: 'No old package imports',
            enabled: true,
            severity: 'error',
            include: ['src'],
            evaluator: { type: 'forbidden-import', config: { patterns: ['@spur/'] } },
        };
        const result = await new RuleEngine().evaluate([rule], dir);
        expect(result.findings).toHaveLength(2);
        expect(result.findings[0]?.filePath).toBe('src/index.ts');
    });

    test('formats empty result', () => {
        expect(new TextFormatter().format({ findings: [], fixes: [] })).toBe('No rule findings.');
    });

    test('marks evaluator failures with kind "error", not as policy violations', async () => {
        const rule: ConstraintRule = {
            id: 'misconfigured',
            description: 'bad config',
            enabled: true,
            severity: 'error',
            evaluator: { type: 'forbidden-import' }, // no patterns/forbidden → throws
        };
        const result = await new RuleEngine().evaluate([rule], await makeTempProject());
        expect(result.findings).toHaveLength(1);
        expect(result.findings[0]?.kind).toBe('error');
        expect(result.findings[0]?.code).toBe('evaluator:forbidden-import');
    });

    test('evaluates path, regex, secrets, exit-code, and evaluator errors', async () => {
        const dir = await makeTempProject();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'index.ts'), 'const token = "sk-123456789012345678901234";\n');
        const rules: ConstraintRule[] = [
            {
                id: 'path-required',
                description: 'path',
                enabled: true,
                severity: 'error',
                evaluator: { type: 'path', config: { paths: ['missing.ts'] } },
            },
            {
                id: 'regex-required',
                description: 'regex',
                enabled: true,
                severity: 'warning',
                include: ['src'],
                evaluator: { type: 'regex', config: { mode: 'require', pattern: 'not-present' } },
            },
            {
                id: 'secret',
                description: 'secret',
                enabled: true,
                severity: 'error',
                include: ['src'],
                evaluator: { type: 'secrets-scanner' },
            },
            {
                id: 'exit',
                description: 'exit',
                enabled: true,
                severity: 'error',
                evaluator: { type: 'exit-code', config: { command: 'false' } },
            },
            {
                id: 'bad',
                description: 'bad',
                enabled: true,
                severity: 'error',
                evaluator: { type: 'missing' },
            },
            {
                id: 'disabled',
                description: 'disabled',
                enabled: false,
                severity: 'error',
                evaluator: { type: 'missing' },
            },
        ];
        const result = await new RuleEngine({ processExecutor: new FakeExecutor(() => ({ exitCode: 1 })) }).evaluate(
            rules,
            dir,
        );
        expect(result.findings.map((finding) => finding.ruleId)).toEqual([
            'path-required',
            'regex-required',
            'secret',
            'exit',
            'bad',
        ]);
    });

    test('handles successful exit-code rules and invalid exit-code config', async () => {
        const dir = await makeTempProject();
        const okRule: ConstraintRule = {
            id: 'exit-ok',
            description: 'exit ok',
            enabled: true,
            severity: 'error',
            evaluator: { type: 'exit-code', config: { command: 'true', args: ['--version'] } },
        };
        expect(
            (
                await new RuleEngine({ processExecutor: new FakeExecutor(() => ({ exitCode: 0 })) }).evaluate(
                    [okRule],
                    dir,
                )
            ).findings,
        ).toEqual([]);

        const badRule: ConstraintRule = {
            id: 'exit-bad-config',
            description: 'exit bad',
            enabled: true,
            severity: 'error',
            evaluator: { type: 'exit-code' },
        };
        const result = await new RuleEngine().evaluate([badRule], dir);
        expect(result.findings[0]?.message).toContain('exit-code evaluator requires string config "command"');
    });

    test('supports extension evaluators and formatters', async () => {
        const engine = new RuleEngine();
        engine.registerEvaluator('custom', {
            evaluate: async (rule) => ({ findings: [createFinding(rule, 'custom finding', null)], fixes: [] }),
        });
        const result = await engine.evaluate(
            [
                {
                    id: 'custom-rule',
                    description: 'custom',
                    enabled: true,
                    severity: 'info',
                    evaluator: { type: 'custom' },
                },
            ],
            await makeTempProject(),
        );
        expect(new JsonFormatter().format(result)).toContain('custom-rule');
        expect(new TextFormatter().format(result)).toContain('INFO custom-rule <workspace>');
    });
});

describe('CapabilityRegistry', () => {
    test('lists and returns registered capabilities', () => {
        const registry = new CapabilityRegistry<number>('number');
        registry.register('one', 1, 'builtin');
        expect(registry.has('one')).toBe(true);
        expect(registry.get('one')).toBe(1);
        expect(registry.list()).toEqual(['one']);
        expect(() => registry.get('two')).toThrow('Unknown number: two');
    });
});

describe('additional evaluators', () => {
    test('covers alternate evaluator branches', async () => {
        const dir = await makeTempProject();
        await mkdir(join(dir, 'src'), { recursive: true });
        await writeFile(join(dir, 'src', 'index.ts'), 'const value = "ok";\n');

        const rules: ConstraintRule[] = [
            {
                id: 'path-forbid',
                description: 'path forbid',
                enabled: true,
                severity: 'error',
                evaluator: { type: 'path', config: { paths: ['src/index.ts'], mode: 'forbid' } },
            },
            {
                id: 'regex-forbid',
                description: 'regex forbid',
                enabled: true,
                severity: 'error',
                include: ['src'],
                evaluator: { type: 'regex', config: { pattern: 'value', flags: 'gm' } },
            },
            {
                id: 'secret-clean',
                description: 'secret clean',
                enabled: true,
                severity: 'error',
                include: ['src'],
                evaluator: { type: 'secrets-scanner' },
            },
        ];

        const result = await new RuleEngine().evaluate(rules, dir);
        expect(result.findings.map((finding) => finding.ruleId)).toEqual(['path-forbid', 'regex-forbid']);
    });

    test('evaluates agent detection with injected detector', async () => {
        const evaluator = new AgentDetectionEvaluator({
            detectOne: async (agent: string) => ({
                name: agent,
                installed: agent === 'pi',
                version: agent === 'pi' ? 'pi 1.0.0' : null,
                channels: [],
                error: agent === 'pi' ? null : 'missing',
            }),
        } as never);
        const rule: ConstraintRule = {
            id: 'agents',
            description: 'agents',
            enabled: true,
            severity: 'warning',
            evaluator: { type: 'agent-detection', config: { agents: ['pi', 'codex', 'unknown'] } },
        };
        const result = await evaluator.evaluate(rule, { rule, workdir: await makeTempProject() });
        expect(result.findings.map((finding) => finding.code)).toEqual(['agent:missing', 'agent:unknown']);
    });

    test('constructs a host and registers formatters', () => {
        const host = new RuleEngineHost();
        host.formatters.register('json', new JsonFormatter(), 'builtin');
        expect(host.formatters.get('json').format({ findings: [], fixes: [] })).toBe(
            '{\n  "findings": [],\n  "fixes": []\n}',
        );
    });
});

describe('loadPresetRules', () => {
    test('loads local category rule files and ignores missing global categories', async () => {
        const dir = await makeTempProject();
        await mkdir(join(dir, '.spur', 'rules', 'quality'), { recursive: true });
        await writeFile(
            join(dir, '.spur', 'rules', 'recommended.yaml'),
            'name: recommended\nextends:\n  - quality\n  - missing-global\n',
        );
        await writeFile(
            join(dir, '.spur', 'rules', 'quality', 'imports.yaml'),
            [
                'rules:',
                '  - id: no-spur',
                '    description: No old package imports',
                '    evaluator:',
                '      type: forbidden-import',
                '      config:',
                '        patterns: ["@spur/"]',
            ].join('\n'),
        );
        const rules = await loadPresetRules('recommended', { roots: [join(dir, '.spur', 'rules')] });
        expect(rules.map((rule) => rule.id)).toEqual(['no-spur']);
    });

    test('loads nested presets with disable and overrides', async () => {
        const dir = await makeTempProject();
        await mkdir(join(dir, '.spur', 'rules', 'quality'), { recursive: true });
        await writeFile(
            join(dir, '.spur', 'rules', 'recommended.yaml'),
            [
                'name: recommended',
                'extends: [strict]',
                'disable: [disabled-rule]',
                'overrides:',
                '  active-rule:',
                '    fix:',
                '      mode: suggest',
            ].join('\n'),
        );
        await writeFile(
            join(dir, '.spur', 'rules', 'strict.yaml'),
            'name: strict\nextends: [quality]\ndisable: [nested-disabled]\n',
        );
        await writeFile(
            join(dir, '.spur', 'rules', 'quality', 'rules.yaml'),
            [
                'rules:',
                '  - id: active-rule',
                '    description: active',
                // Authored as `auto`; the preset override lowers it to `suggest`
                // (overrides may only lower fix authority, never raise it).
                '    fix: { mode: auto }',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
                '  - id: nested-disabled',
                '    description: disabled',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
                '  - id: disabled-rule',
                '    description: disabled',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );
        const rules = await loadPresetRules('recommended', { roots: [join(dir, '.spur', 'rules')] });
        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({ id: 'active-rule', fix: { mode: 'suggest' } });
    });

    test('fills preset categories from a lower-priority root and lets local files shadow global', async () => {
        const dir = await makeTempProject();
        const local = join(dir, 'local');
        const global = join(dir, 'global');
        // Preset + one category live locally; the other category lives only globally.
        await mkdir(join(local, 'structure'), { recursive: true });
        await mkdir(join(global, 'quality'), { recursive: true });
        await mkdir(join(global, 'structure'), { recursive: true });
        await writeFile(join(local, 'recommended.yaml'), 'name: recommended\nextends:\n  - quality\n  - structure\n');
        await writeFile(
            join(global, 'quality', 'coverage.yaml'),
            'rules:\n  - id: coverage-gate\n    description: coverage\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        );
        // Same relative path in both roots — local must win.
        await writeFile(
            join(local, 'structure', 'layout.yaml'),
            'rules:\n  - id: layout\n    description: local layout\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        );
        await writeFile(
            join(global, 'structure', 'layout.yaml'),
            'rules:\n  - id: layout\n    description: global layout\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        );
        const rules = await loadPresetRules('recommended', { roots: [local, global] });
        expect(rules.map((rule) => rule.id).sort()).toEqual(['coverage-gate', 'layout']);
        expect(rules.find((rule) => rule.id === 'layout')?.description).toBe('local layout');
    });

    test('resolves a preset declared only in a lower-priority root', async () => {
        const dir = await makeTempProject();
        const local = join(dir, 'local');
        const global = join(dir, 'global');
        await mkdir(join(global, 'quality'), { recursive: true });
        await mkdir(local, { recursive: true });
        await writeFile(join(global, 'recommended.yaml'), 'name: recommended\nextends:\n  - quality\n');
        await writeFile(
            join(global, 'quality', 'coverage.yaml'),
            'rules:\n  - id: coverage-gate\n    description: coverage\n    evaluator: { type: path, config: { paths: ["x"] } }\n',
        );
        const rules = await loadPresetRules('recommended', { roots: [local, global] });
        expect(rules.map((rule) => rule.id)).toEqual(['coverage-gate']);
    });

    test('loads direct JSON rule files and rejects invalid files', async () => {
        const dir = await makeTempProject();
        const rulePath = join(dir, 'rule.json');
        await writeFile(
            rulePath,
            JSON.stringify({
                id: 'direct',
                description: 'direct',
                evaluator: { type: 'path', config: { paths: ['README.md'] } },
            }),
        );
        expect((await loadRuleFile(rulePath)).rules[0]?.id).toBe('direct');
        const invalidPath = join(dir, 'invalid.yaml');
        await writeFile(invalidPath, 'not: a-rule');
        await expect(loadRuleFile(invalidPath)).rejects.toThrow('Invalid rule file');
    });
});

describe('file utilities', () => {
    test('normalizes relative paths and parent directories', () => {
        expect(relativeToWorkdir('/tmp/project', '/tmp/project/src/index.ts')).toBe('src/index.ts');
        expect(relativeParent('src/index.ts')).toBe('src');
        expect(relativeParent('index.ts')).toBe('');
        expect(matchesAny('src/index.ts', undefined)).toBe(true);
        expect(matchesAny('src/index.ts', ['*.ts'])).toBe(true);
    });
});

async function makeTempProject(): Promise<string> {
    const dir = join(tmpdir(), 'ts-libs-rule-engine', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
}

describe('stopOnFirst', () => {
    function makeRule(id: string, severity: 'error' | 'warning' | 'info', evalType: string): ConstraintRule {
        return {
            id,
            description: `rule ${id}`,
            enabled: true,
            severity,
            evaluator: { type: evalType },
        };
    }

    function makeSpyEvaluator(findings: (rule: ConstraintRule) => { message: string }[]) {
        const calls: ConstraintRule[] = [];
        return {
            calls,
            evaluator: {
                evaluate: async (rule: ConstraintRule) => {
                    calls.push(rule);
                    return {
                        findings: findings(rule).map((f) => createFinding(rule, f.message, null)),
                        fixes: [],
                    };
                },
            },
        };
    }

    test('stopOnFirst="error" stops after first error finding', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r1') return [{ message: 'info1' }];
            if (rule.id === 'r2') return [{ message: 'err' }];
            return [{ message: 'warn3' }];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules = [makeRule('r1', 'info', 'spy'), makeRule('r2', 'error', 'spy'), makeRule('r3', 'error', 'spy')];
        const result = await engine.evaluate(rules, '/tmp', 'error');

        expect(spy.calls.length).toBe(2); // r1, r2 — r3 never called
        expect(spy.calls.map((c) => c.id)).toEqual(['r1', 'r2']);
        expect(result.findings.length).toBe(2); // info1 + err
    });

    test('stopOnFirst="error" does NOT stop on warning-only findings', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r1') return [{ message: 'warn1' }];
            if (rule.id === 'r2') return [{ message: 'info2' }];
            return [{ message: 'err3' }];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules = [makeRule('r1', 'warning', 'spy'), makeRule('r2', 'info', 'spy'), makeRule('r3', 'error', 'spy')];
        const result = await engine.evaluate(rules, '/tmp', 'error');

        expect(spy.calls.length).toBe(3);
        expect(result.findings.length).toBe(3);
    });

    test('stopOnFirst="warning" stops on first warning finding', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r1') return [{ message: 'info1' }];
            if (rule.id === 'r2') return [{ message: 'warn2' }];
            return [{ message: 'err3' }];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules = [makeRule('r1', 'info', 'spy'), makeRule('r2', 'warning', 'spy'), makeRule('r3', 'error', 'spy')];
        const result = await engine.evaluate(rules, '/tmp', 'warning');

        expect(spy.calls.length).toBe(2);
        expect(spy.calls.map((c) => c.id)).toEqual(['r1', 'r2']);
        expect(result.findings.length).toBe(2);
    });

    test('stopOnFirst="info" stops after every rule (any finding)', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r1') return [{ message: 'info1' }];
            return [];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules = [makeRule('r1', 'info', 'spy'), makeRule('r2', 'error', 'spy')];
        const result = await engine.evaluate(rules, '/tmp', 'info');

        expect(spy.calls.length).toBe(1);
        expect(result.findings.length).toBe(1);
    });

    test('stopOnFirst omitted is exhaustive (default behavior)', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r1') return [{ message: 'err1' }];
            return [{ message: 'err2' }];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules = [makeRule('r1', 'error', 'spy'), makeRule('r2', 'error', 'spy')];
        const result = await engine.evaluate(rules, '/tmp');

        expect(spy.calls.length).toBe(2);
        expect(result.findings.length).toBe(2);
    });

    test('stopOnFirst does not stop on empty findings', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r1') return [];
            return [{ message: 'err2' }];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules = [makeRule('r1', 'error', 'spy'), makeRule('r2', 'error', 'spy')];
        const result = await engine.evaluate(rules, '/tmp', 'error');

        expect(spy.calls.length).toBe(2);
        expect(result.findings.length).toBe(1);
    });

    test('stopOnFirst via evaluateWithFixes also works', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r1') return [{ message: 'err1' }];
            return [{ message: 'warn2' }];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules = [makeRule('r1', 'error', 'spy'), makeRule('r2', 'warning', 'spy')];
        const result = await engine.evaluateWithFixes(rules, '/tmp', 'none', 'error');

        expect(spy.calls.length).toBe(1);
        expect(result.findings.length).toBe(1);
    });

    test('skip disabled rules when counting stopOnFirst', async () => {
        const engine = new RuleEngine();
        const spy = makeSpyEvaluator((rule) => {
            if (rule.id === 'r2') return [{ message: 'err' }];
            return [];
        });
        engine.registerEvaluator('spy', spy.evaluator);

        const rules: ConstraintRule[] = [
            { ...makeRule('r1', 'error', 'spy'), enabled: false },
            makeRule('r2', 'error', 'spy'),
            makeRule('r3', 'error', 'spy'),
        ];
        const result = await engine.evaluate(rules, '/tmp', 'error');

        expect(spy.calls.length).toBe(1); // r2 called, r3 stopped
        expect(spy.calls[0]?.id).toBe('r2');
        expect(result.findings.length).toBe(1);
    });
});
