import { describe, expect, test } from 'bun:test';
import { sha256, stableJson } from '../src/hash';

describe('sha256', () => {
    test('returns a deterministic 64-char hex digest for known input', () => {
        const result = sha256('hello world');
        expect(result).toBe('9ddefe4435b21d901439e546d54a14a175a3493b9fd8fbf38d9ea6d3cbf70826');
        expect(result.length).toBe(64);
    });

    test('different inputs produce different hashes', () => {
        const a = sha256({ key: 'value' });
        const b = sha256({ key: 'other' });
        expect(a).not.toBe(b);
    });

    test('produces same hash for structurally equivalent objects', () => {
        const a = sha256({ x: 1, y: 2 });
        const b = sha256({ y: 2, x: 1 });
        expect(a).toBe(b);
    });
});

describe('stableJson', () => {
    test('sorts object keys for deterministic output', () => {
        expect(stableJson({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
    });

    test('handles nested objects and arrays deterministically', () => {
        const input = { arr: [3, 1, 2], nested: { b: true, a: false } };
        expect(stableJson(input)).toBe('{"arr":[3,1,2],"nested":{"a":false,"b":true}}');
    });

    test('handles primitives', () => {
        expect(stableJson(42)).toBe('42');
        expect(stableJson('hello')).toBe('"hello"');
        expect(stableJson(null)).toBe('null');
        expect(stableJson(true)).toBe('true');
    });

    test('matches JSON undefined handling deterministically', () => {
        expect(stableJson({ a: 1, b: undefined })).toBe('{"a":1}');
        expect(stableJson([1, undefined, 3])).toBe('[1,null,3]');
        expect(stableJson(undefined)).toBe('null');
    });
});
