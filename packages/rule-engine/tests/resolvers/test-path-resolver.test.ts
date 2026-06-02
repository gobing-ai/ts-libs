import { describe, expect, test } from 'bun:test';
import {
    GoTestPathResolver,
    PythonTestPathResolver,
    RustTestPathResolver,
    TypeScriptTestPathResolver,
} from '../../src/resolvers/test-path-resolver';

describe('TypeScriptTestPathResolver', () => {
    const resolver = new TypeScriptTestPathResolver();

    test('maps package src to package tests', () => {
        expect(resolver.resolveTestPath('packages/core/src/foo/bar.ts')).toBe('packages/core/tests/foo/bar.test.ts');
    });

    test('maps top-level src to tests', () => {
        expect(resolver.resolveTestPath('src/foo.ts')).toBe('tests/foo.test.ts');
    });

    test('returns test files unchanged', () => {
        expect(resolver.resolveTestPath('tests/foo.test.ts')).toBe('tests/foo.test.ts');
    });
});

describe('PythonTestPathResolver', () => {
    const resolver = new PythonTestPathResolver();

    test('prefixes the basename with test_', () => {
        expect(resolver.resolveTestPath('src/foo/bar.py')).toBe('tests/foo/test_bar.py');
    });

    test('maps package src to package tests', () => {
        expect(resolver.resolveTestPath('packages/x/src/a.py')).toBe('packages/x/tests/test_a.py');
    });

    test('rejects a non-python extension', () => {
        expect(() => resolver.resolveTestPath('src/foo.ts')).toThrow('unsupported extension');
    });
});

describe('GoTestPathResolver', () => {
    const resolver = new GoTestPathResolver();

    test('produces a sibling _test.go file', () => {
        expect(resolver.resolveTestPath('foo/bar.go')).toBe('foo/bar_test.go');
    });

    test('returns _test.go files unchanged', () => {
        expect(resolver.resolveTestPath('foo/bar_test.go')).toBe('foo/bar_test.go');
    });
});

describe('RustTestPathResolver', () => {
    const resolver = new RustTestPathResolver();

    test('maps crate src to crate tests', () => {
        expect(resolver.resolveTestPath('crate/src/foo.rs')).toBe('crate/tests/foo.rs');
    });

    test('maps top-level src to tests', () => {
        expect(resolver.resolveTestPath('src/foo.rs')).toBe('tests/foo.rs');
    });
});
