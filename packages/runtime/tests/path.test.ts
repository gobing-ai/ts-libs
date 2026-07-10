import { describe, expect, test } from 'bun:test';
import {
    basenamePath,
    dirnamePath,
    fileUrlToPath,
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

    test('Windows path', () => {
        expect(dirnamePath('C:\\a\\b\\c.ts')).toBe('C:/a/b');
    });

    test('Windows drive root', () => {
        expect(dirnamePath('C:/')).toBe('C:/');
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

describe('fileUrlToPath', () => {
    test('converts POSIX file URLs', () => {
        expect(fileUrlToPath('file:///tmp/project/file%20name.ts')).toBe('/tmp/project/file name.ts');
    });

    test('converts localhost file URLs', () => {
        expect(fileUrlToPath('file://localhost/tmp/project/file.ts')).toBe('/tmp/project/file.ts');
    });

    test('converts Windows drive file URLs', () => {
        expect(fileUrlToPath('file:///C:/Users/Robin/file.ts')).toBe('C:/Users/Robin/file.ts');
    });

    test('preserves UNC file URL hosts', () => {
        expect(fileUrlToPath('file://server/share/file.ts')).toBe('//server/share/file.ts');
    });

    test('rejects non-file URLs', () => {
        expect(() => fileUrlToPath('https://example.com/file.ts')).toThrow('Expected file URL');
    });

    test('rejects encoded slashes so traversal cannot be smuggled past path validation', () => {
        expect(() => fileUrlToPath('file:///tmp/a%2F..%2F..%2Fetc/passwd')).toThrow('must not include encoded');
    });

    test('rejects encoded backslashes so traversal cannot be smuggled past path validation', () => {
        expect(() => fileUrlToPath('file:///tmp/a%5C..%5Csecret.ts')).toThrow('must not include encoded');
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

    test('preserves Windows drive roots', () => {
        expect(resolvePath('C:\\a\\b', '..\\c')).toBe('C:/a/c');
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

    test('Windows same drive', () => {
        expect(relativePath('C:\\a\\b', 'C:\\a\\c')).toBe('../c');
    });

    test('Windows cross drive', () => {
        expect(relativePath('C:\\a\\b', 'D:\\x\\y')).toBe('D:/x/y');
    });
});
