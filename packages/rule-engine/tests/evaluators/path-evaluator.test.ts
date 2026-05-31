import { describe, expect, test } from 'bun:test';
import { PathEvaluator } from '../../src/evaluators/path-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'path', config },
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule({ paths: ['package.json'] }) };
}

describe('PathEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new PathEvaluator();
        expect(evaluator).toBeInstanceOf(PathEvaluator);
    });

    test('throws when paths config is missing', async () => {
        const evaluator = new PathEvaluator();
        const rule = makeRule({});
        const ctx = { ...makeContext(), rule };
        await expect(evaluator.evaluate(rule, ctx)).rejects.toThrow('path evaluator requires string[] config "paths"');
    });

    test('accepts single string as paths config', async () => {
        const evaluator = new PathEvaluator();
        const nonexistentDir = `/tmp/nonexistent-${Date.now()}`;
        const rule = makeRule({ paths: 'readme.md' });
        const ctx: RuleContext = { workdir: nonexistentDir, rule };
        const result = await evaluator.evaluate(rule, ctx);
        expect(result.findings.length).toBeGreaterThanOrEqual(1);
        expect(result.findings[0]?.code).toBe('path:missing');
    });
});
