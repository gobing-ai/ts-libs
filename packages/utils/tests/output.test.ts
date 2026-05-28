import { describe, expect, test } from 'bun:test';

import { createBufferTarget, echo, echoError, setDefaultOutputTargets, type WriteTarget } from '../src/output';

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
