import { describe, expect, test } from 'bun:test';
import {
    BunPipeProcessSpawner,
    BunSyncProcessExecutor,
    NodeProcessExecutor,
    type ProcessEventDetail,
    type ProcessEventSink,
    type TracerPort,
} from '../src/process-executor';

function recordEvents(): { events: Array<{ event: string; detail: ProcessEventDetail }>; sink: ProcessEventSink } {
    const events: Array<{ event: string; detail: ProcessEventDetail }> = [];
    return {
        events,
        sink: {
            emit: (event, detail) => {
                events.push({ event, detail });
            },
        },
    };
}

function recordTracer(): { spans: string[]; tracer: TracerPort } {
    const spans: string[] = [];
    return {
        spans,
        tracer: {
            traceAsync: async (name, fn) => {
                spans.push(name);
                return await fn({ name });
            },
        },
    };
}

describe('NodeProcessExecutor', () => {
    test('runs a command and captures stdout', async () => {
        const result = await new NodeProcessExecutor().run({ command: 'echo', args: ['hello'] });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('hello');
        expect(result.stderr).toBe('');
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('captures stderr and custom environment', async () => {
        const result = await new NodeProcessExecutor().run({
            command: 'sh',
            args: ['-c', 'echo value && echo err >&2'],
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain('value');
        expect(result.stderr).toContain('err');
    });

    test('observes incremental stdout and stderr while retaining the buffered result', async () => {
        const output: Array<{ stream: string; chunk: string }> = [];
        const pending = new NodeProcessExecutor().run({
            command: 'sh',
            args: ['-c', 'printf first; sleep 0.05; printf second; printf problem >&2'],
            onOutput: ({ stream, chunk }) => output.push({ stream, chunk }),
        });

        await Bun.sleep(20);
        expect(output.map((entry) => entry.chunk).join('')).toContain('first');

        const result = await pending;
        expect(result.stdout).toBe('firstsecond');
        expect(result.stderr).toBe('problem');
        expect(
            output
                .filter((entry) => entry.stream === 'stdout')
                .map((entry) => entry.chunk)
                .join(''),
        ).toBe('firstsecond');
        expect(
            output
                .filter((entry) => entry.stream === 'stderr')
                .map((entry) => entry.chunk)
                .join(''),
        ).toBe('problem');
    });

    test('isolates output-observer failures from the child process', async () => {
        const result = await new NodeProcessExecutor().run({
            command: 'echo',
            args: ['still-buffered'],
            onOutput: () => {
                throw new Error('slow sink failed');
            },
        });

        expect(result).toMatchObject({ exitCode: 0, stdout: 'still-buffered' });
    });

    test('returns non-zero exit results unless rejectOnError is true', async () => {
        const result = await new NodeProcessExecutor().run({ command: 'sh', args: ['-c', 'exit 2'] });
        expect(result.exitCode).toBe(2);

        await expect(
            new NodeProcessExecutor().run({ command: 'sh', args: ['-c', 'exit 3'], rejectOnError: true }),
        ).rejects.toThrow();
    });

    test('accepts cwd option', async () => {
        const result = await new NodeProcessExecutor().run({
            command: 'pwd',
            cwd: '/',
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe('/');
    });

    test('runStreaming spawns a pipe process and writes stdin', async () => {
        const proc = new NodeProcessExecutor().runStreaming({
            command: 'cat',
        });

        proc.writeStdin('hello\n');
        proc.endStdin();

        const exitCode = await proc.exited;
        expect(exitCode).toBe(0);
    });

    test('emits process events and opens a span for successful buffered runs', async () => {
        const { events, sink } = recordEvents();
        const { spans, tracer } = recordTracer();
        const result = await new NodeProcessExecutor({ events: sink, tracer }).run({
            command: 'echo',
            args: ['observed'],
            label: 'test.echo',
        });

        expect(result.exitCode).toBe(0);
        expect(spans).toEqual(['process.run']);
        expect(events.map((entry) => entry.event)).toEqual(['process.started', 'process.exited']);
        expect(events[0]?.detail).toMatchObject({
            command: 'echo',
            args: ['observed'],
            exitCode: null,
            reason: 'exit',
            label: 'test.echo',
        });
        expect(events[1]?.detail).toMatchObject({
            command: 'echo',
            args: ['observed'],
            exitCode: 0,
            reason: 'exit',
            label: 'test.echo',
        });
        expect(events[1]?.detail.durationMs).toBeGreaterThanOrEqual(0);
    });

    test('emits exit reason for non-zero buffered runs', async () => {
        const { events, sink } = recordEvents();
        const result = await new NodeProcessExecutor({ events: sink }).run({
            command: 'sh',
            args: ['-c', 'exit 2'],
        });

        expect(result.exitCode).toBe(2);
        expect(events.at(-1)?.detail).toMatchObject({ exitCode: 2, reason: 'exit' });
    });

    test('emits timeout reason for timed-out buffered runs', async () => {
        const { events, sink } = recordEvents();
        const result = await new NodeProcessExecutor({ events: sink }).run({
            command: 'sh',
            args: ['-c', 'sleep 1'],
            timeout: 10,
        });

        expect(result.exitCode).toBeNull();
        expect(events.at(-1)?.detail.reason).toBe('timeout');
    });

    test('emits signal reason for signaled buffered runs', async () => {
        const { events, sink } = recordEvents();
        const result = await new NodeProcessExecutor({ events: sink }).run({
            command: 'sh',
            args: ['-c', 'kill -TERM $$'],
        });

        expect(result.exitCode).toBeNull();
        expect(result.signal).toBeDefined();
        expect(events.at(-1)?.detail.reason).toBe('signal');
        expect(events.at(-1)?.detail.signal).toBeDefined();
    });

    test('abort terminates the buffered child process group without waiting for descendants', async () => {
        const controller = new AbortController();
        const startedAt = Date.now();
        setTimeout(() => controller.abort(), 20);

        const result = await new NodeProcessExecutor().run({
            command: 'sh',
            args: ['-c', 'sleep 5'],
            signal: controller.signal,
        });

        expect(result.exitCode).toBeNull();
        expect(result.signal).toBeDefined();
        expect(Date.now() - startedAt).toBeLessThan(1000);
    });

    test('emits error reason before rejectOnError rethrows command errors', async () => {
        const { events, sink } = recordEvents();

        await expect(
            new NodeProcessExecutor({ events: sink }).run({
                command: 'definitely-missing-command-for-process-executor-test',
                rejectOnError: true,
            }),
        ).rejects.toThrow();
        expect(events.at(-1)?.detail).toMatchObject({
            command: 'definitely-missing-command-for-process-executor-test',
            exitCode: null,
            reason: 'error',
        });
        expect(events.at(-1)?.detail.error).toBeDefined();
    });

    test('a partial env extends rather than replaces process.env (extendEnv merge — task 0056 R2)', async () => {
        // execa defaults extendEnv:true, so a partial env merges with process.env.
        // This is load-bearing: a regression to extendEnv:false would strip PATH, HOME,
        // and every provider credential from agent subprocesses. Use a process-local
        // sentinel so the assertion is environment-independent (PATH/HOME vary by host
        // and Bun injects a minimal PATH even under extendEnv:false, so PATH is an
        // unreliable merge signal — HOME/sentinel are not).
        const sentinel = `RUNTIME_MERGE_SENTINEL_${Date.now()}`;
        process.env[sentinel] = 'parent-survives';
        try {
            const result = await new NodeProcessExecutor().run({
                command: 'sh',
                args: ['-c', `echo "SENTINEL=${'$'}${sentinel}"; echo "FORWARDED=${'$'}{SPUR_RUN_ID}"`],
                env: { SPUR_RUN_ID: 'run-merge-1' },
            });

            expect(result.exitCode).toBe(0);
            // Parent variable survives (merge, not replace).
            expect(result.stdout).toContain(`SENTINEL=parent-survives`);
            // Forwarded variable reaches the child.
            expect(result.stdout).toContain('FORWARDED=run-merge-1');
        } finally {
            delete process.env[sentinel];
        }
    });
    test('runStreaming emits process events and opens a spawn span', async () => {
        const { events, sink } = recordEvents();
        const { spans, tracer } = recordTracer();
        const proc = new NodeProcessExecutor({ events: sink, tracer }).runStreaming({ command: 'cat' });

        expect(proc.pid).toBeGreaterThan(0);
        expect(proc.stdout).toBeInstanceOf(ReadableStream);
        expect(proc.stderr).toBeInstanceOf(ReadableStream);
        proc.writeStdin('hello\n');
        proc.endStdin();

        await expect(proc.exited).resolves.toBe(0);
        expect(spans).toEqual(['process.runStreaming']);
        expect(events.map((entry) => entry.event)).toEqual(['process.started', 'process.exited']);
        expect(events.at(-1)?.detail).toMatchObject({ command: 'cat', exitCode: 0, reason: 'exit' });
    });

    test('runStreaming works when tracer defers callback execution', async () => {
        const tracer: TracerPort = {
            traceAsync: async (_name, fn) => {
                await Promise.resolve();
                return await fn({});
            },
        };

        const proc = new NodeProcessExecutor({ tracer }).runStreaming({ command: 'cat' });
        proc.endStdin();

        await expect(proc.exited).resolves.toBe(0);
    });

    test('runStreaming records signal details when killed through the observed handle', async () => {
        const { events, sink } = recordEvents();
        const proc = new NodeProcessExecutor({ events: sink }).runStreaming({ command: 'sleep', args: ['1'] });

        proc.kill('SIGTERM');

        await proc.exited;
        expect(events.at(-1)?.detail).toMatchObject({ command: 'sleep', reason: 'signal', signal: 'SIGTERM' });
    });

    test('runStreaming emits a terminal exited event when spawn fails', () => {
        const { events, sink } = recordEvents();
        const exec = new NodeProcessExecutor({ events: sink });

        expect(() => exec.runStreaming({ command: 'definitely-not-a-real-binary-xyz' })).toThrow();
        expect(events.map((entry) => entry.event)).toEqual(['process.started', 'process.exited']);
        expect(events.at(-1)?.detail).toMatchObject({ reason: 'error', exitCode: null });
        expect(events.at(-1)?.detail.error).toBeDefined();
    });

    test('observability ports are no-op when unset', async () => {
        const exec = new NodeProcessExecutor();
        await expect(exec.run({ command: 'echo', args: ['noop'] })).resolves.toMatchObject({ exitCode: 0 });
        const proc = exec.runStreaming({ command: 'cat' });
        proc.endStdin();
        await expect(proc.exited).resolves.toBe(0);
    });

    test('deprecated sync executor remains backward compatible', () => {
        const result = new BunSyncProcessExecutor().runSync({ command: 'echo', args: ['sync'] });

        expect(result).toMatchObject({ command: 'echo', args: ['sync'], exitCode: 0, stdout: 'sync' });
    });

    test('deprecated pipe process spawner remains backward compatible', async () => {
        const proc = new BunPipeProcessSpawner().spawn({ command: 'cat' });

        proc.writeStdin('spawned\n');
        proc.endStdin();

        await expect(proc.exited).resolves.toBe(0);
    });
});
