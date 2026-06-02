import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RegexEvaluator } from '../../src/evaluators/regex-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'regex', config },
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule({ pattern: 'test' }) };
}

describe('RegexEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new RegexEvaluator();
        expect(evaluator).toBeInstanceOf(RegexEvaluator);
    });

    test('throws when pattern config is missing', async () => {
        const evaluator = new RegexEvaluator();
        const rule = makeRule({});
        const ctx = { ...makeContext(), rule };
        await expect(evaluator.evaluate(rule, ctx)).rejects.toThrow('regex evaluator requires string config "pattern"');
    });

    test('defaults mode to forbid when omitted', async () => {
        const evaluator = new RegexEvaluator();
        const tmpDir = join('/tmp', `rule-engine-test-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
        try {
            const ctx = makeContext(tmpDir);
            const result = await evaluator.evaluate(ctx.rule, ctx);
            expect(result.findings).toEqual([]);
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    test('forbid mode matches multiline patterns across line boundaries', async () => {
        const evaluator = new RegexEvaluator();
        const tmpDir = join('/tmp', `rule-engine-multiline-${Date.now()}`);
        mkdirSync(join(tmpDir, 'src'), { recursive: true });
        try {
            writeFileSync(join(tmpDir, 'src', 'index.ts'), 'const a = 1;\nconst b = 2;\n');
            const rule = makeRule({
                pattern: 'const a = 1;.*const b = 2;',
                multiline: true,
            });
            const result = await evaluator.evaluate(rule, { workdir: tmpDir, rule });

            expect(result.findings).toHaveLength(1);
            expect(result.findings[0]?.filePath).toBe('src/index.ts');
            expect(result.findings[0]?.line).toBe(1);
            expect(result.findings[0]?.code).toBe('regex:found');
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
