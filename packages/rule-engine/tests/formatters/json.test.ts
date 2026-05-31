import { describe, expect, test } from 'bun:test';
import { JsonFormatter } from '../../src/formatters/json';
import type { RuleEngineResult } from '../../src/types';

describe('JsonFormatter', () => {
    test('constructs without arguments', () => {
        const formatter = new JsonFormatter();
        expect(formatter).toBeInstanceOf(JsonFormatter);
    });

    test('formats empty result as JSON', () => {
        const formatter = new JsonFormatter();
        const result: RuleEngineResult = { findings: [], fixes: [] };
        const output = formatter.format(result);
        const parsed = JSON.parse(output);
        expect(parsed).toEqual({ findings: [], fixes: [] });
    });

    test('formats result with findings as pretty JSON', () => {
        const formatter = new JsonFormatter();
        const result: RuleEngineResult = {
            findings: [
                {
                    ruleId: 'no-secrets',
                    severity: 'error',
                    message: 'API key found',
                    filePath: '.env',
                    line: 3,
                    code: 'secret:token',
                },
            ],
            fixes: [],
        };
        const output = formatter.format(result);
        const parsed = JSON.parse(output);
        expect(parsed.findings).toHaveLength(1);
        expect(parsed.findings[0].ruleId).toBe('no-secrets');
    });

    test('output is pretty-printed with indentation', () => {
        const formatter = new JsonFormatter();
        const result: RuleEngineResult = { findings: [], fixes: [] };
        const output = formatter.format(result);
        expect(output).toBe('{\n  "findings": [],\n  "fixes": []\n}');
    });
});
