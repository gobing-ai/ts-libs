import { describe, expect, test } from 'bun:test';
import { DEFAULT_REDACTION_RULES, redactValue } from '../src/redaction';

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
        expect(names).toContain('xai-key');
        expect(names).toContain('aws-access-key-id');
        expect(names).toContain('bearer-token');
    });

    test('redacts xai keys, AWS access key ids, and Bearer JWTs (0060 R13)', () => {
        expect(redactValue('xai-abcdefghijklmnopqrstuv')).toContain('[REDACTED:token]');
        expect(redactValue('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:aws-key]');
        expect(redactValue('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.aa.bb')).toContain('[REDACTED:bearer]');
        // Existing sk- / assignment / email rules still match.
        expect(redactValue('sk-abcdefghijklmnopqrstuv')).toContain('[REDACTED:token]');
        expect(redactValue('api_key = supersecret-value')).toContain('[REDACTED:secret]');
        expect(redactValue('reach robin@example.com now')).toContain('[REDACTED:email]');
    });

    test('patterns have global flag for replace-all behavior', () => {
        for (const rule of DEFAULT_REDACTION_RULES) {
            expect(rule.pattern.flags).toContain('g');
        }
    });
});
