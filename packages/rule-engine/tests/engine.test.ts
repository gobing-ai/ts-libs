import { describe, expect, test } from 'bun:test';
import { RuleEngine } from '../src/engine';

describe('RuleEngine', () => {
    test('instantiation creates engine with default host', () => {
        const engine = new RuleEngine();
        expect(engine).toBeInstanceOf(RuleEngine);
        expect(engine.host).toBeDefined();
    });

    test('instantiation accepts custom host option', () => {
        const engine = new RuleEngine({});
        expect(engine.host).toBeDefined();
    });

    test('registerEvaluator adds evaluator to host', () => {
        const engine = new RuleEngine();
        const evaluator = { evaluate: async () => ({ findings: [], fixes: [] }) };
        engine.registerEvaluator('test-eval', evaluator);
        expect(engine.host.evaluators.has('test-eval')).toBe(true);
    });
});
