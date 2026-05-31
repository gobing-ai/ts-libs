import { describe, expect, test } from 'bun:test';
import { ExitCodeEvaluator } from '../../src/evaluators/exit-code-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'exit-code', config },
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule({ command: 'echo' }) };
}

describe('ExitCodeEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new ExitCodeEvaluator();
        expect(evaluator).toBeInstanceOf(ExitCodeEvaluator);
    });

    test('throws when command config is missing', async () => {
        const evaluator = new ExitCodeEvaluator();
        const rule = makeRule({});
        const ctx = { ...makeContext(), rule };
        await expect(evaluator.evaluate(rule, ctx)).rejects.toThrow(
            'exit-code evaluator requires string config "command"',
        );
    });
});
