import { describe, expect, test } from 'bun:test';
import { CapabilityRegistry } from '../../src/plugin/capability-registry';

describe('CapabilityRegistry', () => {
    test('registers and retrieves a capability', () => {
        const reg = new CapabilityRegistry<string>('thing');
        reg.register('a', 'alpha');
        expect(reg.has('a')).toBe(true);
        expect(reg.get('a')).toBe('alpha');
    });

    test('replaces an existing capability by name', () => {
        const reg = new CapabilityRegistry<string>('thing');
        reg.register('a', 'first');
        reg.register('a', 'second');
        expect(reg.get('a')).toBe('second');
        // Replacement must not duplicate the key.
        expect(reg.list()).toEqual(['a']);
    });

    test('defaults origin to "extension" and records "builtin" when given', () => {
        const reg = new CapabilityRegistry<string>('thing');
        reg.register('ext', 'x');
        reg.register('core', 'y', 'builtin');
        expect(reg.getEntry('ext')?.origin).toBe('extension');
        expect(reg.getEntry('core')?.origin).toBe('builtin');
    });

    test('get throws a clear error including kind and missing name', () => {
        const reg = new CapabilityRegistry<string>('evaluator');
        expect(() => reg.get('missing')).toThrow('Unknown evaluator: missing');
    });

    test('getEntry returns undefined for an unknown name without throwing', () => {
        const reg = new CapabilityRegistry<string>('thing');
        expect(reg.getEntry('nope')).toBeUndefined();
    });

    test('list and entries preserve insertion order', () => {
        const reg = new CapabilityRegistry<number>('num');
        reg.register('c', 3);
        reg.register('a', 1);
        reg.register('b', 2);
        expect(reg.list()).toEqual(['c', 'a', 'b']);
        expect(reg.entries().map(([name, entry]) => [name, entry.capability])).toEqual([
            ['c', 3],
            ['a', 1],
            ['b', 2],
        ]);
    });

    test('entries exposes origin so callers can inspect provenance', () => {
        const reg = new CapabilityRegistry<string>('thing');
        reg.register('core', 'y', 'builtin');
        reg.register('ext', 'x');
        expect(reg.entries().map(([name, e]) => [name, e.origin])).toEqual([
            ['core', 'builtin'],
            ['ext', 'extension'],
        ]);
    });
});
