import { describe, expect, test } from 'bun:test';
import {
    basenamePath,
    dirnamePath,
    isAbsolutePath,
    joinPath,
    normalizeSeparators,
    relativePath,
    resolvePath,
    SEP,
} from '../src/path';

describe('normalizeSeparators', () => {
    test('converts backslashes to forward slashes', () => {
        expect(normalizeSeparators('C:\\Users\\x\\file.ts')).toBe('C:/Users/x/file.ts');
    });

    test('leaves forward slashes unchanged', () => {
        expect(normalizeSeparators('/a/b/c')).toBe('/a/b/c');
    });
});

describe('SEP', () => {
    test('is a string', () => {
        expect(typeof SEP).toBe('string');
        expect(SEP.length).toBe(1);
    });
});

describe('isAbsolutePath', () => {
    test('POSIX absolute', () => {
        expect(isAbsolutePath('/a/b')).toBe(true);
    });

    test('Windows drive absolute', () => {
        expect(isAbsolutePath('C:/a/b')).toBe(true);
        expect(isAbsolutePath('C:\\a\\b')).toBe(true);
    });

    test('relative', () => {
        expect(isAbsolutePath('a/b')).toBe(false);
        expect(isAbsolutePath('./a')).toBe(false);
    });
});

describe('dirnamePath', () => {
    test('normal path', () => {
        expect(dirnamePath('/a/b/c.ts')).toBe('/a/b');
    });

    test('root path', () => {
        expect(dirnamePath('/a')).toBe('/');
    });

    test('no slashes', () => {
        expect(dirnamePath('file.ts')).toBe('.');
    });

    test('trailing slash stripped', () => {
        expect(dirnamePath('/a/b/')).toBe('/a');
    });
});

describe('basenamePath', () => {
    test('normal path', () => {
        expect(basenamePath('/a/b/c.ts')).toBe('c.ts');
    });

    test('with extension stripping', () => {
        expect(basenamePath('/a/b/c.ts', '.ts')).toBe('c');
    });

    test('extension not matching', () => {
        expect(basenamePath('/a/b/c.ts', '.js')).toBe('c.ts');
    });

    test('root slash', () => {
        expect(basenamePath('/')).toBe('');
    });

    test('trailing slash', () => {
        expect(basenamePath('/a/b/')).toBe('b');
    });
});

describe('joinPath', () => {
    test('joins segments', () => {
        expect(joinPath('/a', 'b', 'c')).toBe('/a/b/c');
    });

    test('collapses slashes', () => {
        expect(joinPath('/a/', '/b/')).toBe('/a/b/');
    });

    test('relative output', () => {
        expect(joinPath('a', 'b')).toBe('a/b');
    });
});

describe('resolvePath', () => {
    test('resolves to absolute', () => {
        const result = resolvePath('/a/b', '../c');
        expect(result).toBe('/a/c');
    });

    test('Collapses ".." segments', () => {
        expect(resolvePath('/a/b/c', '../../d')).toBe('/a/d');
    });
});

describe('relativePath', () => {
    test('same directory', () => {
        expect(relativePath('/a/b', '/a/b')).toBe('.');
    });

    test('child path', () => {
        expect(relativePath('/a', '/a/b/c')).toBe('b/c');
    });

    test('parent path', () => {
        expect(relativePath('/a/b/c', '/a')).toBe('../..');
    });

    test('sibling', () => {
        expect(relativePath('/a/x', '/a/y')).toBe('../y');
    });
});
