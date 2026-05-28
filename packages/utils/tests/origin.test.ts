import { describe, expect, test } from 'bun:test';

import { getValidatedOrigin, isAllowedOrigin, matchOriginPattern } from '../src/origin';

describe('matchOriginPattern', () => {
    test('matches exact and universal wildcard patterns', () => {
        expect(matchOriginPattern('https://example.com', 'https://example.com')).toBe(true);
        expect(matchOriginPattern('https://anything.com', '*')).toBe(true);
    });

    test('matches one wildcard segment without regex semantics', () => {
        expect(matchOriginPattern('https://app.example.com', 'https://*.example.com')).toBe(true);
        expect(matchOriginPattern('https://a.b.example.com', 'https://*.example.com')).toBe(true);
        expect(matchOriginPattern('https://evil.com', 'https://*.example.com')).toBe(false);
        expect(matchOriginPattern('http://app.example.com', 'https://*.example.com')).toBe(false);
        expect(matchOriginPattern('https://app.example.com', 'https://*.evil.com')).toBe(false);
    });

    test('treats multiple wildcards as literal fallback matching', () => {
        expect(matchOriginPattern('https://a.*.b.*.com', 'https://a.*.b.*.com')).toBe(true);
        expect(matchOriginPattern('https://a.x.b.y.com', 'https://a.*.b.*.com')).toBe(false);
    });

    test('rejects mismatches', () => {
        expect(matchOriginPattern('https://foo.com', 'https://bar.com')).toBe(false);
        expect(matchOriginPattern('', 'https://example.com')).toBe(false);
    });
});

describe('isAllowedOrigin', () => {
    test('checks nullish origins, empty allow lists, exact matches, and wildcard matches', () => {
        const allowed = ['https://example.com', 'https://*.myapp.com', '*'];

        expect(isAllowedOrigin(null, allowed)).toBe(false);
        expect(isAllowedOrigin(undefined, allowed)).toBe(false);
        expect(isAllowedOrigin('https://example.com', [])).toBe(false);
        expect(isAllowedOrigin('https://example.com', allowed)).toBe(true);
        expect(isAllowedOrigin('https://sub.myapp.com', allowed)).toBe(true);
        expect(isAllowedOrigin('https://random.com', allowed)).toBe(true);
        expect(isAllowedOrigin('https://evil.com', ['https://example.com'])).toBe(false);
    });
});

describe('getValidatedOrigin', () => {
    test('returns the validated origin or fallback', () => {
        const allowed = ['https://secure.com'];

        expect(getValidatedOrigin('https://secure.com', allowed, 'https://fallback.com')).toBe('https://secure.com');
        expect(getValidatedOrigin('https://evil.com', allowed, 'https://fallback.com')).toBe('https://fallback.com');
        expect(getValidatedOrigin(null, allowed, 'https://fallback.com')).toBe('https://fallback.com');
    });
});
