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

    test('a `__proto__` key in source cannot reach the result prototype', () => {
        // Assigning `result.__proto__` invokes the inherited setter, handing the merged
        // object an attacker-controlled prototype — so `deepMerge(defaults, JSON.parse(input))`
        // would resolve absent keys through it. JSON.parse is required: an object literal
        // would set the prototype at construction rather than creating an own key.
        const merged = deepMerge({ role: 'user' }, JSON.parse('{"__proto__":{"isAdmin":true}}'));

        expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
        expect((merged as { isAdmin?: unknown }).isAdmin).toBeUndefined();
        expect(merged).toEqual({ role: 'user' });
        // Object.prototype was never the vector here (each level is a fresh spread), and stays clean.
        expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
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

    test('deFlattenKeys does not pollute Object.prototype via `__proto__` / `constructor` segments', () => {
        // Live-repro 2026-08-12 (task 0060 F1): `current['__proto__']` returns Object.prototype
        // (isPlainObject true), so the walker kept navigating and the final assign created an
        // own property on Object.prototype. Hostile segments must be skipped entirely.
        deFlattenKeys({ '__proto__.polluted': '"pwned"' });
        expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);

        // `constructor` / `prototype` pivots (e.g. obj.constructor.prototype.x) are equally
        // forbidden even when the leaf is a plain value.
        const out = deFlattenKeys({ 'constructor.prototype.isAdmin': 'true', safe: '"ok"' });
        expect(out).toEqual({ safe: 'ok' });
        expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
        expect(Object.hasOwn(Object.prototype, 'isAdmin')).toBe(false);
    });
});
