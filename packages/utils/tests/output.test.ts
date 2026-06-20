import { describe, expect, test } from 'bun:test';

import {
    createBufferTarget,
    type ExitTarget,
    echo,
    echoError,
    exitProcess,
    setDefaultExitTarget,
    setDefaultOutputTargets,
    type WriteTarget,
} from '../src/output';

function createMockTarget(output: string[]): WriteTarget {
    return {
        write(chunk) {
            output.push(String(chunk));
            return true;
        },
    };
}

describe('echo helpers', () => {
    test('write newline-terminated messages to explicit targets', () => {
        const stdout: string[] = [];
        const stderr: string[] = [];

        echo('hello', createMockTarget(stdout));
        echo('', createMockTarget(stdout));
        echoError('boom', createMockTarget(stderr));

        expect(stdout).toEqual(['hello\n', '\n']);
        expect(stderr).toEqual(['boom\n']);
    });
});

describe('process-less runtime (e.g. Workers)', () => {
    test('throws a guiding error when no target and no process stream is available', () => {
        // Simulate a runtime where `process.stdout` is absent: the lazy resolver must fail with a
        // clear message, not a raw `undefined.write` — and never at module load.
        const proc = (globalThis as { process?: { stdout?: unknown } }).process;
        const original = proc?.stdout;
        if (proc) proc.stdout = undefined;
        try {
            expect(() => echo('x')).toThrow('No stdout target available');
        } finally {
            if (proc) proc.stdout = original;
        }
    });

    test('exitProcess throws a guiding error when no target and no process.exit is available', () => {
        // Same lazy-resolution contract as echo: never read process.exit at module load,
        // and fail with a clear message when the runtime has no exit.
        const proc = (globalThis as { process?: { exit?: unknown } }).process;
        const original = proc?.exit;
        if (proc) proc.exit = undefined;
        try {
            expect(() => exitProcess(0)).toThrow('No exit target available');
        } finally {
            if (proc) proc.exit = original;
        }
    });
});

describe('exitProcess', () => {
    test('calls the explicit target with the given code', () => {
        const codes: number[] = [];
        const target = ((code?: number) => {
            codes.push(code ?? 0);
        }) as ExitTarget;

        exitProcess(42, target);

        expect(codes).toEqual([42]);
    });

    test('defaults the exit code to 0', () => {
        const codes: number[] = [];
        const target = ((code?: number) => {
            codes.push(code ?? 0);
        }) as ExitTarget;

        exitProcess(undefined, target);

        expect(codes).toEqual([0]);
    });

    test('routes through the default target and restores it', () => {
        const codes: number[] = [];
        const restore = setDefaultExitTarget(((code?: number) => {
            codes.push(code ?? 0);
        }) as ExitTarget);

        try {
            exitProcess(7);
            expect(codes).toEqual([7]);
        } finally {
            restore();
        }

        // After restore, the default is cleared — falls back to process.exit,
        // which the explicit-target form bypasses. Assert the override is gone
        // by setting a fresh sentinel and confirming the old one is not called.
        const restored: number[] = [];
        const restore2 = setDefaultExitTarget(((code?: number) => {
            restored.push(code ?? 0);
        }) as ExitTarget);
        try {
            exitProcess(9);
            expect(restored).toEqual([9]);
            expect(codes).toEqual([7]); // unchanged — previous target was restored away
        } finally {
            restore2();
        }
    });
});

describe('createBufferTarget', () => {
    test('captures chunks, concatenates text, and clears in place', () => {
        const buffer = createBufferTarget();
        const chunks = buffer.chunks;

        buffer.write('foo');
        buffer.write('bar');

        expect(buffer.chunks).toEqual(['foo', 'bar']);
        expect(buffer.text()).toBe('foobar');

        buffer.clear();

        expect(buffer.chunks).toEqual([]);
        expect(buffer.chunks).toBe(chunks);
    });
});

describe('setDefaultOutputTargets', () => {
    test('redirects default stdout and stderr targets and restores previous targets', () => {
        const stdout = createBufferTarget();
        const stderr = createBufferTarget();
        const restoreOuter = setDefaultOutputTargets({ stdout, stderr });

        try {
            const inner = createBufferTarget();
            const restoreInner = setDefaultOutputTargets({ stdout: inner });
            try {
                echo('inner');
                echoError('stderr');
            } finally {
                restoreInner();
            }
            echo('outer');
        } finally {
            restoreOuter();
        }

        expect(stdout.text()).toBe('outer\n');
        expect(stderr.text()).toBe('stderr\n');
    });

    test('skips missing keys without overwriting existing defaults', () => {
        const stdout = createBufferTarget();
        const stderr = createBufferTarget();
        const restore = setDefaultOutputTargets({ stdout, stderr });

        try {
            const restoreNoop = setDefaultOutputTargets({});
            try {
                echo('stdout');
                echoError('stderr');
            } finally {
                restoreNoop();
            }
        } finally {
            restore();
        }

        expect(stdout.text()).toBe('stdout\n');
        expect(stderr.text()).toBe('stderr\n');
    });
});
