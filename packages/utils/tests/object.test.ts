import { describe, expect, test } from 'bun:test';

import { deepMerge, deFlattenKeys, flattenKeys, isPlainObject } from '../src/object';

describe('isPlainObject', () => {
    test('accepts object literals, rejects arrays, null, and primitives', () => {
        expect(isPlainObject({})).toBe(true);
        expect(isPlainObject({ a: 1 })).toBe(true);
        expect(isPlainObject([])).toBe(false);
        expect(isPlainObject(null)).toBe(false);
        expect(isPlainObject('x')).toBe(false);
        expect(isPlainObject(42)).toBe(false);
    });
});

describe('deepMerge', () => {
    test('recursively merges nested plain objects', () => {
        expect(deepMerge({ app: { port: 3000, env: 'development' } }, { app: { port: 4000 } })).toEqual({
            app: { port: 4000, env: 'development' },
        });
    });

    test('replaces arrays wholesale rather than concatenating', () => {
        // The replace-not-extend rule: an override list is authored complete.
        expect(deepMerge({ tags: ['a', 'b'] }, { tags: ['c'] })).toEqual({ tags: ['c'] });
    });

    test('does not mutate either input', () => {
        const target = { app: { port: 3000 } };
        const source = { app: { port: 4000 } };
        deepMerge(target, source);
        expect(target).toEqual({ app: { port: 3000 } });
        expect(source).toEqual({ app: { port: 4000 } });
    });
});

describe('flattenKeys / deFlattenKeys', () => {
    test('round-trips a nested object through dot-delimited JSON leaves', () => {
        const flattened = flattenKeys({ app: { port: 3000 }, enabled: true });
        expect(flattened).toEqual({ 'app.port': '3000', enabled: 'true' });
        expect(deFlattenKeys(flattened)).toEqual({ app: { port: 3000 }, enabled: true });
    });

    test('deFlattenKeys keeps a non-JSON leaf as its raw string', () => {
        expect(deFlattenKeys({ 'db.url': 'postgres://x' })).toEqual({ db: { url: 'postgres://x' } });
    });
});
