/**
 * Pluggable test-path resolution for the test-location evaluator.
 *
 * Each implementation maps a source file path to its conventional test file path
 * for one language, so the same evaluator works across TypeScript, Python, Go, and
 * Rust projects. Resolvers are registered on the host and selected per rule via
 * `evaluator.config.resolver`.
 */

/** Metadata about an exported symbol, used when generating a test skeleton. */
export interface ExportInfo {
    /** Symbol name. */
    readonly name: string;
    /** Declaration kind. */
    readonly kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'unknown';
    /** One-based source line, when known. */
    readonly line?: number;
}

/** Maps source files to expected test files for a project type. */
export interface TestPathResolver {
    /** Language name this resolver handles (registry key). */
    readonly name: string;
    /** Compute the expected test file path for a source file. */
    resolveTestPath(srcRelPath: string): string;
    /** Optionally generate a test skeleton for a source file. */
    generateSkeleton?(srcRelPath: string, exports: ExportInfo[]): string;
}

/**
 * TypeScript conventions:
 *   src/foo/bar.ts → tests/foo/bar.test.ts
 *   packages/core/src/foo/bar.ts → packages/core/tests/foo/bar.test.ts
 */
export class TypeScriptTestPathResolver implements TestPathResolver {
    /** Registry key. */
    readonly name = 'typescript';

    constructor() {}

    /** Map a TS/JS source path to its `tests/…test.ts` counterpart. */
    resolveTestPath(srcRelPath: string): string {
        if (srcRelPath.includes('.test.') || srcRelPath.includes('.spec.')) return srcRelPath;
        const srcIdx = srcRelPath.indexOf('/src/');
        if (srcIdx !== -1) {
            const pkg = srcRelPath.slice(0, srcIdx);
            const rel = srcRelPath.slice(srcIdx + '/src/'.length).replace(/\.(ts|tsx|js|jsx)$/, '.test.ts');
            return `${pkg}/tests/${rel}`;
        }
        const withoutExt = srcRelPath.replace(/\.(ts|tsx|js|jsx)$/, '');
        return `tests/${withoutExt.replace(/^src\//, '')}.test.ts`;
    }
}

/**
 * Python conventions (pytest):
 *   src/foo/bar.py → tests/foo/test_bar.py
 */
export class PythonTestPathResolver implements TestPathResolver {
    /** Registry key. */
    readonly name = 'python';

    constructor() {}

    /** Map a Python source path to its `tests/…/test_*.py` counterpart. */
    resolveTestPath(srcRelPath: string): string {
        if (!srcRelPath) throw new Error('empty source path');
        if (srcRelPath.endsWith('_test.py') || srcRelPath.includes('/test_') || srcRelPath.startsWith('test_')) {
            return srcRelPath;
        }
        if (srcRelPath.startsWith('tests/')) return srcRelPath;
        if (!srcRelPath.endsWith('.py')) throw new Error(`unsupported extension for python resolver: ${srcRelPath}`);
        const srcIdx = srcRelPath.indexOf('/src/');
        if (srcIdx !== -1) {
            const pkg = srcRelPath.slice(0, srcIdx);
            return `${pkg}/tests/${testify(srcRelPath.slice(srcIdx + '/src/'.length))}`;
        }
        if (srcRelPath.startsWith('src/')) return `tests/${testify(srcRelPath.slice(4))}`;
        return `tests/${testify(srcRelPath)}`;
    }
}

/**
 * Go conventions:
 *   foo/bar.go → foo/bar_test.go (sibling)
 */
export class GoTestPathResolver implements TestPathResolver {
    /** Registry key. */
    readonly name = 'go';

    constructor() {}

    /** Map a Go source path to its sibling `_test.go` file. */
    resolveTestPath(srcRelPath: string): string {
        if (!srcRelPath) throw new Error('empty source path');
        if (srcRelPath.endsWith('_test.go')) return srcRelPath;
        if (!srcRelPath.endsWith('.go')) throw new Error(`unsupported extension for go resolver: ${srcRelPath}`);
        return srcRelPath.replace(/\.go$/, '_test.go');
    }
}

/**
 * Rust conventions (Cargo integration tests):
 *   crate/src/foo.rs → crate/tests/foo.rs
 */
export class RustTestPathResolver implements TestPathResolver {
    /** Registry key. */
    readonly name = 'rust';

    constructor() {}

    /** Map a Rust source path to its `tests/` integration-test counterpart. */
    resolveTestPath(srcRelPath: string): string {
        if (!srcRelPath) throw new Error('empty source path');
        if (srcRelPath.startsWith('tests/') || srcRelPath.includes('/tests/')) return srcRelPath;
        if (!srcRelPath.endsWith('.rs')) throw new Error(`unsupported extension for rust resolver: ${srcRelPath}`);
        const srcIdx = srcRelPath.indexOf('/src/');
        if (srcIdx !== -1) {
            const crate = srcRelPath.slice(0, srcIdx);
            return `${crate}/tests/${srcRelPath.slice(srcIdx + '/src/'.length)}`;
        }
        if (srcRelPath.startsWith('src/')) return `tests/${srcRelPath.slice(4)}`;
        return `tests/${srcRelPath}`;
    }
}

/** Prefix the basename of a Python source path with `test_`. */
function testify(rel: string): string {
    const lastSlash = rel.lastIndexOf('/');
    const dir = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : '';
    const base = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
    return `${dir}test_${base}`;
}
