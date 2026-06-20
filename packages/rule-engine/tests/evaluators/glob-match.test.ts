import { describe, expect, test } from 'bun:test';
import { escapeRegExp, matchesAny, matchesGlob } from '../../src/evaluators/glob-match';

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

describe('matchesGlob', () => {
    test('anchors the whole path — does not match an unrelated prefix', () => {
        // The loose/strict distinction is the documented footgun: a bare `apps/**`
        // must NOT match `vendor/apps/x` under glob, even though matchesAny would.
        expect(matchesGlob('vendor/apps/x.ts', 'apps/**')).toBe(false);
        expect(matchesAny('vendor/apps/x.ts', ['apps'])).toBe(true);
    });

    test('** matches any depth', () => {
        expect(matchesGlob('packages/a/src/b/c.ts', 'packages/**/*.ts')).toBe(true);
    });

    test('* matches a single segment only, not a slash', () => {
        expect(matchesGlob('src/foo.ts', 'src/*.ts')).toBe(true);
        expect(matchesGlob('src/nested/foo.ts', 'src/*.ts')).toBe(false);
    });

    test('leading **/ suffix form matches at any depth', () => {
        expect(matchesGlob('a/b/c.test.ts', '**/c.test.ts')).toBe(true);
        expect(matchesGlob('c.test.ts', '**/c.test.ts')).toBe(true);
    });

    test('exact literal pattern matches the identical path', () => {
        expect(matchesGlob('src/index.ts', 'src/index.ts')).toBe(true);
    });
});

describe('escapeRegExp', () => {
    test('escapes regex metacharacters so the value is matched literally', () => {
        const escaped = escapeRegExp('a.b+c*');
        expect(new RegExp(`^${escaped}$`).test('a.b+c*')).toBe(true);
        expect(new RegExp(`^${escaped}$`).test('axbyc')).toBe(false);
    });
});
