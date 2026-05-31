import { describe, expect, test } from 'bun:test';
import { RuleEngineHost } from '../../src/host/rule-engine-host';

describe('RuleEngineHost', () => {
    test('creates evaluators registry', () => {
        const host = new RuleEngineHost();
        expect(host.evaluators).toBeDefined();
        expect(host.evaluators.list()).toEqual([]);
    });

    test('creates formatters registry', () => {
        const host = new RuleEngineHost();
        expect(host.formatters).toBeDefined();
        expect(host.formatters.list()).toEqual([]);
    });

    test('evaluators registry supports register and get', () => {
        const host = new RuleEngineHost();
        const evaluator = { evaluate: async () => ({ findings: [], fixes: [] }) };
        host.evaluators.register('custom', evaluator);
        expect(host.evaluators.get('custom')).toBe(evaluator);
    });

    test('formatters registry supports register and get', () => {
        const host = new RuleEngineHost();
        const formatter = { format: () => 'result' };
        host.formatters.register('custom', formatter);
        expect(host.formatters.get('custom')).toBe(formatter);
    });
});
