import { describe, expect, test } from 'bun:test';
import { redactValue, sha256, stableJson } from '../src';

describe('hash and redaction utilities', () => {
    test('serializes arrays and sorted objects deterministically', () => {
        expect(stableJson({ b: 2, a: [1, { d: true, c: null }] })).toBe('{"a":[1,{"c":null,"d":true}],"b":2}');
        expect(sha256({ a: 1 })).toBe(sha256({ a: 1 }));
    });

    test('redacts arrays, objects, strings, and leaves primitive values intact', () => {
        expect(
            redactValue({
                text: 'api_key=secret123 user@example.com',
                nested: ['token=secret456', 42],
            }),
        ).toEqual({
            text: '[REDACTED:secret] [REDACTED:email]',
            nested: ['[REDACTED:secret]', 42],
        });
        expect(redactValue(false)).toBe(false);
    });

    test('1131 R1 — argsDigest equal when args differ only by a vendor token', async () => {
        const { argsDigest } = await import('../src/mappers');
        // sk-XXXXXXXXXXXXXXXX is 19 chars — the old digest redactor missed it entirely.
        const a = { input: 'auth sk-AAAAAAAAAAAAAAAA done' };
        const b = { input: 'auth sk-BBBBBBBBBBBBBBBB done' };
        expect(argsDigest(a)).toBe(argsDigest(b));
    });
});
