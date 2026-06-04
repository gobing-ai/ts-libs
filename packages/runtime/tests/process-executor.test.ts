import { describe, expect, test } from 'bun:test';
import { ProcessExecutor } from '../src/process-executor';

describe('ProcessExecutor', () => {
    test('runs a command and captures stdout', async () => {
        const result = await new ProcessExecutor().run({ command: 'echo', args: ['hello'] });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hello');
        expect(result.stderr).toBe('');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('captures stderr and custom environment', async () => {
        const result = await new ProcessExecutor().run({
            command: 'sh',
            args: ['-c', 'echo value && echo err >&2'],
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('value');
        expect(result.stderr).toContain('err');
    });

    test('returns non-zero exit results unless rejectOnError is true', async () => {
        const result = await new ProcessExecutor().run({ command: 'sh', args: ['-c', 'exit 2'] });
        expect(result.exitCode).toBe(2);

        await expect(
            new ProcessExecutor().run({ command: 'sh', args: ['-c', 'exit 3'], rejectOnError: true }),
        ).rejects.toThrow();
    });

    test('accepts cwd option', async () => {
        const result = await new ProcessExecutor().run({
            command: 'pwd',
            cwd: '/',
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('/');
    });

    test('runStreaming spawns a pipe process and writes stdin', async () => {
        const proc = new ProcessExecutor().runStreaming({
            command: 'cat',
        });

        proc.writeStdin('hello\n');
        proc.endStdin();

        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
    });
});
