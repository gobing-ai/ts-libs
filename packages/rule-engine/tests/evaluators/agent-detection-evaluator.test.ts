import { describe, expect, test } from 'bun:test';
import { AgentDetectionEvaluator } from '../../src/evaluators/agent-detection-evaluator';
import type { ConstraintRule, RuleContext } from '../../src/types';

function makeRule(config: Record<string, unknown>): ConstraintRule {
    return {
        id: 'test-rule',
        description: 'test',
        enabled: true,
        severity: 'error',
        evaluator: { type: 'agent-detection', config },
    };
}

function makeContext(workdir = '/tmp'): RuleContext {
    return { workdir, rule: makeRule({ agents: ['claude'] }) };
}

describe('AgentDetectionEvaluator', () => {
    test('constructs without arguments', () => {
        const evaluator = new AgentDetectionEvaluator();
        expect(evaluator).toBeInstanceOf(AgentDetectionEvaluator);
    });

    test('throws when agents config is missing', async () => {
        const evaluator = new AgentDetectionEvaluator();
        const rule = makeRule({});
        const ctx = { ...makeContext(), rule };
        await expect(evaluator.evaluate(rule, ctx)).rejects.toThrow(
            'agent-detection evaluator requires string[] config "agents"',
        );
    });

    test('reports unknown agent name', async () => {
        const evaluator = new AgentDetectionEvaluator();
        const rule = makeRule({ agents: ['not-a-real-agent'] });
        const ctx = { ...makeContext(), rule };
        const result = await evaluator.evaluate(rule, ctx);
        expect(result.findings.length).toBeGreaterThanOrEqual(1);
        expect(result.findings[0]?.code).toBe('agent:unknown');
    });
});
