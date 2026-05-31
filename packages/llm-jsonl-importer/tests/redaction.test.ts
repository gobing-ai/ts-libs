import { describe, expect, test } from 'bun:test';
import { DEFAULT_REDACTION_RULES } from '../src/redaction';

describe('DEFAULT_REDACTION_RULES', () => {
    test('is a non-empty array of valid RedactionRule objects', () => {
        expect(Array.isArray(DEFAULT_REDACTION_RULES)).toBe(true);
        expect(DEFAULT_REDACTION_RULES.length).toBeGreaterThan(0);

        for (const rule of DEFAULT_REDACTION_RULES) {
            expect(rule).toHaveProperty('name');
            expect(typeof rule.name).toBe('string');
            expect(rule.name.length).toBeGreaterThan(0);

            expect(rule).toHaveProperty('pattern');
            expect(rule.pattern).toBeInstanceOf(RegExp);

            expect(rule).toHaveProperty('replacement');
            expect(typeof rule.replacement).toBe('string');
            expect(rule.replacement.length).toBeGreaterThan(0);
        }
    });

    test('contains the expected rule names', () => {
        const names = DEFAULT_REDACTION_RULES.map((r) => r.name);
        expect(names).toContain('api-key');
        expect(names).toContain('assignment-secret');
        expect(names).toContain('email');
    });

    test('patterns have global flag for replace-all behavior', () => {
        for (const rule of DEFAULT_REDACTION_RULES) {
            expect(rule.pattern.flags).toContain('g');
        }
    });
});
