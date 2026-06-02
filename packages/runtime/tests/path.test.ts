import { describe, expect, test } from 'bun:test';
import { dirnamePath, isAbsolutePath, joinPath, normalizeSeparators, resolvePath } from '../src/path';

describe('normalizeSeparators', () => {
    test('rewrites backslashes to forward slashes', () => {
        expect(normalizeSeparators('a\\b\\c')).toBe('a/b/c');
        expect(normalizeSeparators('a/b')).toBe('a/b');
    });
});

describe('isAbsolutePath', () => {
    test('treats POSIX roots and Windows drive paths as absolute', () => {
        expect(isAbsolutePath('/etc/hosts')).toBe(true);
        expect(isAbsolutePath('C:\\Users\\x')).toBe(true);
        expect(isAbsolutePath('C:/Users/x')).toBe(true);
        expect(isAbsolutePath('relative/path')).toBe(false);
        expect(isAbsolutePath('./rel')).toBe(false);
    });
});

describe('dirnamePath', () => {
    test('returns the parent directory across edge cases', () => {
        expect(dirnamePath('/a/b/c.txt')).toBe('/a/b');
        expect(dirnamePath('/a')).toBe('/');
        expect(dirnamePath('a/b')).toBe('a');
        expect(dirnamePath('file.txt')).toBe('.');
    });

    test('handles roots and trailing slashes', () => {
        expect(dirnamePath('/')).toBe('/');
        expect(dirnamePath('///')).toBe('/');
        expect(dirnamePath('/a/b/')).toBe('/a');
        expect(dirnamePath('a\\b\\c')).toBe('a/b');
    });
});

describe('joinPath', () => {
    test('joins segments, collapsing redundant separators', () => {
        expect(joinPath('a', 'b', 'c')).toBe('a/b/c');
        expect(joinPath('/a', 'b')).toBe('/a/b');
        expect(joinPath('a//', '/b')).toBe('a/b');
    });

    test('drops empty segments and defaults to "."', () => {
        expect(joinPath('', 'a', '')).toBe('a');
        expect(joinPath()).toBe('.');
        expect(joinPath('', '')).toBe('.');
    });
});

describe('resolvePath', () => {
    test('collapses "." and ".." segments', () => {
        expect(resolvePath('/a/b', '../c')).toBe('/a/c');
        expect(resolvePath('/a/./b/./c')).toBe('/a/b/c');
        expect(resolvePath('/a/b/c', '../../d')).toBe('/a/d');
    });

    test('an absolute later segment resets the resolution root', () => {
        expect(resolvePath('/a/b', '/c/d')).toBe('/c/d');
    });

    test('over-popping ".." cannot escape an absolute root', () => {
        expect(resolvePath('/a', '../../..')).toBe('/');
    });
});
