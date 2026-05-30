import { describe, expect, test } from 'bun:test';
import { mkdir, writeFile } from 'node:fs/promises';
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
    constructor(private readonly exitCode: number) {}

    async run(options: ProcessOptions): Promise<ProcessResult> {
        return {
            command: options.command,
            args: options.args ?? [],
            exitCode: this.exitCode,
            stdout: '',
            stderr: '',
            durationMs: 1,
        };
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
        const result = await new RuleEngine({ processExecutor: new FakeExecutor(1) }).evaluate(rules, dir);
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
            (await new RuleEngine({ processExecutor: new FakeExecutor(0) }).evaluate([okRule], dir)).findings,
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
        const rules = await loadPresetRules('recommended', { workdir: dir });
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
                '    fix: { mode: none }',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
                '  - id: nested-disabled',
                '    description: disabled',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
                '  - id: disabled-rule',
                '    description: disabled',
                '    evaluator: { type: path, config: { paths: ["README.md"] } }',
            ].join('\n'),
        );
        const rules = await loadPresetRules('recommended', { workdir: dir });
        expect(rules).toHaveLength(1);
        expect(rules[0]).toMatchObject({ id: 'active-rule', fix: { mode: 'suggest' } });
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
        expect((await loadRuleFile(rulePath))[0]?.id).toBe('direct');
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
    const dir = join(import.meta.dir, '.tmp', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
}
