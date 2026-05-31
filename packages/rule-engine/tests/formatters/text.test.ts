import { describe, expect, test } from 'bun:test';
import { TextFormatter } from '../../src/formatters/text';
import type { RuleEngineResult } from '../../src/types';

describe('TextFormatter', () => {
    test('constructs without arguments', () => {
        const formatter = new TextFormatter();
        expect(formatter).toBeInstanceOf(TextFormatter);
    });

    test('returns no-findings message for empty result', () => {
        const formatter = new TextFormatter();
        const result: RuleEngineResult = { findings: [], fixes: [] };
        expect(formatter.format(result)).toBe('No rule findings.');
    });

    test('formats single finding', () => {
        const formatter = new TextFormatter();
        const result: RuleEngineResult = {
            findings: [
                {
                    ruleId: 'no-console',
                    severity: 'error',
                    message: 'found console.log',
                    filePath: 'src/index.ts',
                    line: 10,
                },
            ],
            fixes: [],
        };
        const output = formatter.format(result);
        expect(output).toContain('ERROR');
        expect(output).toContain('no-console');
        expect(output).toContain('src/index.ts:10');
        expect(output).toContain('found console.log');
    });

    test('uses workspace label when filePath is null', () => {
        const formatter = new TextFormatter();
        const result: RuleEngineResult = {
            findings: [{ ruleId: 'ci-check', severity: 'warning', message: 'CI failed', filePath: null }],
            fixes: [],
        };
        const output = formatter.format(result);
        expect(output).toContain('<workspace>');
    });
});
