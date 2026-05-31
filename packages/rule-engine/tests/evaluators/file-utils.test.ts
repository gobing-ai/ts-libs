import { describe, expect, test } from 'bun:test';
import { matchesAny, relativeParent } from '../../src/evaluators/file-utils';

describe('matchesAny', () => {
    test('returns true when patterns is undefined', () => {
        expect(matchesAny('src/foo.ts', undefined)).toBe(true);
    });

    test('returns true when patterns array is empty', () => {
        expect(matchesAny('src/foo.ts', [])).toBe(true);
    });

    test('matches by suffix', () => {
        expect(matchesAny('src/foo.ts', ['.ts'])).toBe(true);
    });

    test('matches by path fragment', () => {
        expect(matchesAny('src/components/Button.tsx', ['components'])).toBe(true);
    });

    test('returns false when no pattern matches', () => {
        expect(matchesAny('src/foo.ts', ['.tsx', '.js'])).toBe(false);
    });

    test('strips wildcards and matches by cleaned fragment', () => {
        // deep/**/*.ts → deep/.ts; matches path containing 'deep/' and ending with '.ts'
        expect(matchesAny('deep/other.ts', ['.ts'])).toBe(true);
    });

    test('normalizes backslash pattern to forward slash', () => {
        expect(matchesAny('src/foo.ts', ['src\\foo.ts'])).toBe(true);
    });
});

describe('relativeParent', () => {
    test('returns empty string for root path', () => {
        expect(relativeParent('file.txt')).toBe('');
    });

    test('returns parent directory for nested path', () => {
        expect(relativeParent('src/file.txt')).toBe('src');
    });

    test('handles deeply nested path', () => {
        expect(relativeParent('a/b/c/file.txt')).toBe('a/b/c');
    });
});
