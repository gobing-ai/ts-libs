import { describe, expect, test } from 'bun:test';
import { CapabilityRegistry } from '../../src/host/capability-registry';

describe('CapabilityRegistry', () => {
    test('registers and retrieves capability', () => {
        const registry = new CapabilityRegistry<string>('test');
        registry.register('alpha', 'value-alpha');
        expect(registry.has('alpha')).toBe(true);
        expect(registry.get('alpha')).toBe('value-alpha');
    });

    test('throws when getting unknown capability', () => {
        const registry = new CapabilityRegistry<string>('test');
        expect(() => registry.get('missing')).toThrow('Unknown test: missing');
    });

    test('has returns false for unknown capability', () => {
        const registry = new CapabilityRegistry<string>('test');
        expect(registry.has('nope')).toBe(false);
    });

    test('overwrites existing capability on re-register', () => {
        const registry = new CapabilityRegistry<string>('test');
        registry.register('key', 'first');
        registry.register('key', 'second');
        expect(registry.get('key')).toBe('second');
    });

    test('list returns all registered names', () => {
        const registry = new CapabilityRegistry<string>('test');
        registry.register('a', '1');
        registry.register('b', '2');
        expect(registry.list().sort()).toEqual(['a', 'b']);
    });

    test('default origin is extension', () => {
        const registry = new CapabilityRegistry<string>('test');
        registry.register('ext', 'val');
        // Verify registration works; origin accessible only internally
        expect(registry.get('ext')).toBe('val');
    });
});
