import { describe, expect, test } from 'bun:test';
import {
    configArray,
    configNumber,
    configString,
    parseInlineFlags,
    stringArray,
} from '../../src/evaluators/config-access';

describe('configString', () => {
    test('returns the string value when present', () => {
        expect(configString({ pattern: 'foo' }, 'pattern')).toBe('foo');
    });

    test('returns the fallback when the key is absent', () => {
        expect(configString({}, 'pattern', 'default')).toBe('default');
    });

    test('throws naming the evaluator when required and missing', () => {
        // Required keys must fail loudly so a misconfigured rule does not silently no-op.
        expect(() => configString({}, 'pattern', undefined, { evaluator: 'regex' })).toThrow(
            'regex evaluator requires string config "pattern"',
        );
    });
});

describe('configArray', () => {
    test('returns a string array as-is', () => {
        expect(configArray({ globs: ['a', 'b'] }, 'globs')).toEqual(['a', 'b']);
    });

    test('coerces a bare string to a single-element array', () => {
        expect(configArray({ globs: 'a' }, 'globs')).toEqual(['a']);
    });

    test('returns the fallback when absent', () => {
        expect(configArray({}, 'globs', ['x'])).toEqual(['x']);
    });

    test('throws when required and missing', () => {
        expect(() => configArray({}, 'globs')).toThrow('evaluator requires string[] config "globs"');
    });

    test('ignores a non-string-array value and falls through to throw', () => {
        expect(() => configArray({ globs: [1, 2] }, 'globs')).toThrow();
    });
});

describe('configNumber', () => {
    test('returns a finite number', () => {
        expect(configNumber({ max: 5 }, 'max', 10)).toBe(5);
    });

    test('falls back when absent', () => {
        expect(configNumber({}, 'max', 10)).toBe(10);
    });

    test('falls back when the value is non-finite', () => {
        expect(configNumber({ max: Number.POSITIVE_INFINITY }, 'max', 10)).toBe(10);
    });
});

describe('stringArray', () => {
    test('returns the array when every item is a string', () => {
        expect(stringArray(['a', 'b'])).toEqual(['a', 'b']);
    });

    test('returns undefined when any item is not a string', () => {
        expect(stringArray(['a', 1])).toBeUndefined();
    });

    test('returns undefined for a non-array', () => {
        expect(stringArray('a')).toBeUndefined();
    });
});

describe('parseInlineFlags', () => {
    test('returns empty flags and source unchanged when no leading group', () => {
        expect(parseInlineFlags('foo')).toEqual({ flags: '', rest: 'foo' });
    });

    test('strips a leading (?i) group and yields i', () => {
        expect(parseInlineFlags('(?i)foo')).toEqual({ flags: 'i', rest: 'foo' });
    });

    test('filters group flags to JS-relevant (imsu)', () => {
        expect(parseInlineFlags('(?ims)foo')).toEqual({ flags: 'ims', rest: 'foo' });
    });
});
