import { describe, expect, test } from 'bun:test';

import { BunPipeProcessSpawner, BunSyncProcessExecutor, NodeProcessExecutor } from '../src/process-executor';

describe('NodeProcessExecutor', () => {
    test('runs a command and captures stdout', async () => {
        const result = await new NodeProcessExecutor().run({ command: 'echo', args: ['hello'] });

        expect(result).toMatchObject({
            command: 'echo',
            args: ['hello'],
            exitCode: 0,
            stdout: 'hello',
            stderr: '',
        });
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('captures stderr and custom environment', async () => {
        const result = await new NodeProcessExecutor().run({
            command: 'bash',
            args: ['-c', 'echo "$TEST_VAR"; echo "err" >&2'],
            env: { TEST_VAR: 'value' },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('value');
        expect(result.stderr).toBe('err');
    });

    test('returns non-zero exit results unless rejectOnError is true', async () => {
        const executor = new NodeProcessExecutor();

        await expect(executor.run({ command: 'bash', args: ['-c', 'exit 12'] })).resolves.toMatchObject({
            exitCode: 12,
        });
        await expect(executor.run({ command: 'bash', args: ['-c', 'exit 1'], rejectOnError: true })).rejects.toThrow();
    });

    test('uses default timeout from config', async () => {
        const result = await new NodeProcessExecutor({ defaultTimeout: 50 }).run({
            command: 'sleep',
            args: ['1'],
        });

        expect(result.exitCode).toBeNull();
        expect(result.signal).toBeDefined();
    });

    test('accepts cwd and forceBuffered options', async () => {
        const result = await new NodeProcessExecutor({ output: { mode: 'stream', isTTY: true } }).run({
            command: 'pwd',
            cwd: '/tmp',
            forceBuffered: true,
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toMatch(/\/tmp$/);
    });
});

describe('BunSyncProcessExecutor', () => {
    test('runs a command synchronously and captures output', () => {
        const result = new BunSyncProcessExecutor().runSync({ command: 'echo', args: ['hello'] });
        expect(result).toMatchObject({ exitCode: 0, stdout: 'hello', stderr: '' });
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('throws on non-zero exit when rejectOnError is true', () => {
        const executor = new BunSyncProcessExecutor();
        expect(executor.runSync({ command: 'bash', args: ['-c', 'exit 9'] })).toMatchObject({ exitCode: 9 });
        expect(() =>
            executor.runSync({ command: 'bash', args: ['-c', 'echo boom >&2; exit 9'], rejectOnError: true }),
        ).toThrow('boom');
    });
});

describe('BunPipeProcessSpawner', () => {
    test('starts a pipe process and writes stdin', async () => {
        const process = new BunPipeProcessSpawner().spawn({
            command: 'bun',
            args: ['-e', "process.stdin.on('data', (chunk) => process.stdout.write(chunk));"],
        });
        const output = readFirstChunk(process.stdout);
        process.writeStdin('hello\n');
        process.endStdin();
        expect(await output).toContain('hello');
        expect(await process.exited).toBe(0);
        expect(process.pid).toBeGreaterThan(0);
    });
});

async function readFirstChunk(stream: ReadableStream<Uint8Array> | null): Promise<string> {
    if (stream === null) throw new Error('Expected stdout stream');
    const reader = stream.getReader();
    const chunk = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(chunk.value);
}
