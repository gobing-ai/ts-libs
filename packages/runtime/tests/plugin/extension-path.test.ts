import { describe, expect, test } from 'bun:test';
import { assertRelativeExtensionPath } from '../../src/plugin/extension-path';

describe('assertRelativeExtensionPath', () => {
    test('accepts relative paths', () => {
        expect(() => assertRelativeExtensionPath('./ext/my-extension.ts')).not.toThrow();
        expect(() => assertRelativeExtensionPath('ext/my-extension.ts')).not.toThrow();
        expect(() => assertRelativeExtensionPath('a/b/c.ts')).not.toThrow();
    });

    test('rejects POSIX absolute paths', () => {
        expect(() => assertRelativeExtensionPath('/etc/evil.ts')).toThrow('must be relative');
    });

    test('rejects Windows drive-absolute paths', () => {
        expect(() => assertRelativeExtensionPath('C:\\Users\\x\\evil.ts')).toThrow('must be relative');
        expect(() => assertRelativeExtensionPath('C:/Users/x/evil.ts')).toThrow('must be relative');
    });

    test('rejects ".." traversal in either separator style', () => {
        expect(() => assertRelativeExtensionPath('../escape.ts')).toThrow('".." traversal');
        expect(() => assertRelativeExtensionPath('a/../../escape.ts')).toThrow('".." traversal');
        expect(() => assertRelativeExtensionPath('a\\..\\escape.ts')).toThrow('".." traversal');
    });

    test('includes the source name in the error when provided', () => {
        expect(() => assertRelativeExtensionPath('/abs.ts', { sourceName: 'preset-x' })).toThrow(
            'declared by "preset-x"',
        );
    });
});
