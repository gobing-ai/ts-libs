import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHomeDir, getProcessCwd } from '../src';
import { createNodeFileSystem, findProjectRoot } from '../src/file-system-node';
import { NodeProcessExecutor } from '../src/process-executor';
import { ambientRuntimePaths, type RuntimePaths } from '../src/runtime-paths';

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), 'runtime-paths-test-'));
}

/** mkdtemp returns /var/... on macOS; pwd resolves through /private/var. Normalize via realpath. */
function real(p: string): string {
    return realpathSync(p);
}

/**
 * Tests for the injectable RuntimePaths seam (ADR-023 A1 / task 0042).
 *
 * Pins both directions required by R5:
 *  - ambientRuntimePaths() captures the ambient process environment (R1, AC#1).
 *  - injected paths flow into createNodeFileSystem and NodeProcessExecutor with the documented
 *    precedence: explicit-per-call > injected > ambient (R2, AC#2).
 *  - default (no injection) is byte-identical to today (R4, AC#5).
 */
describe('ambientRuntimePaths', () => {
    test('cwd equals the ambient process working directory', () => {
        const paths = ambientRuntimePaths();
        expect(paths.cwd).toBe(getProcessCwd());
    });

    test('home equals the ambient user home directory, falling back to cwd when unset', () => {
        const paths = ambientRuntimePaths();
        const ambientHome = getHomeDir();
        expect(paths.home).toBe(ambientHome ?? paths.cwd);
    });

    test('fields are readonly and the value is a plain object with cwd+home strings', () => {
        const paths: RuntimePaths = ambientRuntimePaths();
        expect(typeof paths.cwd).toBe('string');
        expect(typeof paths.home).toBe('string');
        expect(Object.keys(paths).sort()).toEqual(['cwd', 'home']);
    });
});

describe('createNodeFileSystem paths injection', () => {
    test('injected paths.cwd seeds the project-root walk when no explicit root is given', () => {
        const fakeCwd = tempDir();
        try {
            // Seed a workspace marker so findProjectRoot stops at fakeCwd.
            writeFileSync(join(fakeCwd, 'package.json'), '{}');

            const fs = createNodeFileSystem(undefined, { cwd: fakeCwd, home: fakeCwd });
            expect(fs.getProjectRoot()).toBe(fakeCwd);
        } finally {
            rmSync(fakeCwd, { recursive: true, force: true });
        }
    });

    test('explicit root still wins over injected paths.cwd', () => {
        const explicit = tempDir();
        const fakeCwd = tempDir();
        try {
            const fs = createNodeFileSystem(explicit, { cwd: fakeCwd, home: fakeCwd });
            expect(fs.getProjectRoot()).toBe(explicit);
        } finally {
            rmSync(explicit, { recursive: true, force: true });
            rmSync(fakeCwd, { recursive: true, force: true });
        }
    });

    test('default (no paths) matches ambient behaviour — project root from process.cwd()', () => {
        const ambient = createNodeFileSystem();
        const expected = findProjectRoot(getProcessCwd());
        expect(ambient.getProjectRoot()).toBe(expected);
    });
});

describe('NodeProcessExecutor paths injection', () => {
    test('injected paths.cwd is applied when a run carries no explicit cwd', async () => {
        const fakeCwd = tempDir();
        try {
            const executor = new NodeProcessExecutor({ paths: { cwd: fakeCwd, home: fakeCwd } });
            const result = await executor.run({ command: 'pwd' });
            expect(result.exitCode).toBe(0);
            // macOS: pwd resolves /var → /private/var; normalize both sides via realpath.
            expect(result.stdout).toBe(real(fakeCwd));
        } finally {
            rmSync(fakeCwd, { recursive: true, force: true });
        }
    });

    test('explicit per-call cwd wins over injected paths.cwd', async () => {
        const fakeCwd = tempDir();
        const explicitCwd = tempDir();
        try {
            const executor = new NodeProcessExecutor({ paths: { cwd: fakeCwd, home: fakeCwd } });
            const result = await executor.run({ command: 'pwd', cwd: explicitCwd });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe(real(explicitCwd));
        } finally {
            rmSync(fakeCwd, { recursive: true, force: true });
            rmSync(explicitCwd, { recursive: true, force: true });
        }
    });

    test('default (no paths) matches ambient behaviour — execa inherits process cwd', async () => {
        const executor = new NodeProcessExecutor();
        const result = await executor.run({ command: 'pwd' });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe(real(getProcessCwd()));
    });

    test('injected paths.cwd flows through when cwd is explicitly undefined', async () => {
        const fakeCwd = tempDir();
        try {
            const executor = new NodeProcessExecutor({ paths: { cwd: fakeCwd, home: fakeCwd } });
            const result = await executor.run({ command: 'pwd', args: [], cwd: undefined });
            expect(result.exitCode).toBe(0);
            expect(result.stdout).toBe(real(fakeCwd));
        } finally {
            rmSync(fakeCwd, { recursive: true, force: true });
        }
    });
});
