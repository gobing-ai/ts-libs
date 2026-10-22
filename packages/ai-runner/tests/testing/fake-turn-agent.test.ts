import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeTurnSessionDriver } from '../../src/testing/fake-turn-driver';
import type { TurnWireEvent } from '../../src/turn-session';
import { TURN_MAX_LINE_BYTES, TurnProtocolError } from '../../src/turn-session';

const CORRELATION = { runId: 'r', executionId: 'e', requestId: 'q', attempt: 1 };
const dirs: string[] = [];
afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Spawn the fake agent as a real child in a temp cwd and collect decoded frames until `stop`. */
async function driveChild(
    script: unknown[],
    feed: (write: (s: string) => Promise<void>) => Promise<void>,
    stop: (frames: TurnWireEvent[]) => boolean,
    opts: { endStdinAfterFeed?: boolean } = {},
): Promise<{ frames: TurnWireEvent[]; exitCode: number | null }> {
    const dir = await mkdtemp(join(tmpdir(), 'fake-agent-'));
    dirs.push(dir);
    const scriptDriver = createFakeTurnSessionDriver(script as never[]);
    const argv = scriptDriver.spawnArgv(
        { path: '/fake', version: '9.9.9' },
        {} as Parameters<ReturnType<typeof createFakeTurnSessionDriver>['spawnArgv']>[1],
    );
    const proc = Bun.spawn([argv.command, ...argv.args], { cwd: dir, stdin: 'pipe', stdout: 'pipe' });
    const write = async (s: string) => {
        proc.stdin.write(s);
        await proc.stdin.flush();
    };
    const feedPromise = feed(write).catch(() => undefined);
    if (opts.endStdinAfterFeed) {
        await feedPromise;
        proc.stdin.end(); // ignore-cancel scripts sleep forever: EOF is the only exit path
    }
    const dec = new TextDecoder();
    let buffer = '';
    const frames: TurnWireEvent[] = [];
    const reader = proc.stdout.getReader();
    for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += dec.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            for (const frame of scriptDriver.decode(line)) frames.push(frame);
        }
        if (stop(frames)) break;
    }
    await feedPromise;
    try {
        proc.stdin.end(); // scripts may keep sleeping: stdin EOF is the deterministic exit path
    } catch {
        // already ended
    }
    const exitCode = await proc.exited;
    return { frames, exitCode };
}

describe('fake-turn-agent child (task 1284)', () => {
    test('replays accept → output → terminal for a correlated turn', async () => {
        const { frames, exitCode } = await driveChild(
            [
                { op: 'accept' },
                { op: 'output', data: 'working' },
                { op: 'terminal', kind: 'success', finalText: 'done' },
            ],
            (write) =>
                write(
                    createFakeTurnSessionDriver([]).encodeTurn({ turnId: 't1', prompt: 'x', correlation: CORRELATION }),
                ),
            (f) => f.some((x) => x.type === 'terminal'),
        );
        expect(frames.map((f) => f.type)).toEqual(['accepted', 'output', 'terminal']);
        expect(frames[2]).toMatchObject({ turnId: 't1', terminal: { kind: 'success', finalText: 'done' } });
        expect(exitCode).toBe(0);
    });

    test('cancel flushes pending sleeps so the scripted terminal arrives promptly', async () => {
        const { frames } = await driveChild(
            [{ op: 'accept' }, { op: 'sleep', ms: 30_000 }, { op: 'terminal', kind: 'success' }],
            async (write) => {
                await write(
                    createFakeTurnSessionDriver([]).encodeTurn({ turnId: 't1', prompt: 'x', correlation: CORRELATION }),
                );
                await write(createFakeTurnSessionDriver([]).encodeCancel('test'));
            },
            (f) => f.some((x) => x.type === 'terminal'),
        );
        // The 30s sleep must be cut short by the cancel: terminal observed, not the EOF path.
        expect(frames.some((f) => f.type === 'terminal')).toBe(true);
    });

    test('ignore-cancel keeps sleeping (cancel produces no frames, child exits on stdin close)', async () => {
        const { frames, exitCode } = await driveChild(
            [
                { op: 'ignore-cancel' },
                { op: 'accept' },
                { op: 'sleep', ms: 60_000 },
                { op: 'terminal', kind: 'success' },
            ],
            async (write) => {
                await write(
                    createFakeTurnSessionDriver([]).encodeTurn({ turnId: 't1', prompt: 'x', correlation: CORRELATION }),
                );
                await write(createFakeTurnSessionDriver([]).encodeCancel('ignored'));
            },
            () => false, // collect until EOF
            { endStdinAfterFeed: true },
        );
        expect(frames).toHaveLength(1); // accepted only; the terminal never arrives while ignored
        expect(exitCode).toBe(0);
    });

    test('exit before ready breaks the handshake (EOF, no ready frame)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fake-agent-'));
        dirs.push(dir);
        const argv = createFakeTurnSessionDriver([{ op: 'exit', code: 3 }]).spawnArgv(
            { path: '/fake', version: '9.9.9' },
            {} as Parameters<ReturnType<typeof createFakeTurnSessionDriver>['spawnArgv']>[1],
        );
        const proc = Bun.spawn([argv.command, ...argv.args], {
            cwd: dir,
            stdin: 'pipe',
            stdout: 'pipe',
        });
        const raw = await new Response(proc.stdout).text();
        expect(raw).toBe('');
        expect(await proc.exited).toBe(3);
        expect(raw).toBe('');
    });

    test('flood writes a raw stdout line exceeding TURN_MAX_LINE_BYTES', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'fake-agent-'));
        dirs.push(dir);
        const scriptDriver = createFakeTurnSessionDriver([{ op: 'flood' }]);
        const argv = scriptDriver.spawnArgv(
            { path: '/fake', version: '9.9.9' },
            {} as Parameters<ReturnType<typeof createFakeTurnSessionDriver>['spawnArgv']>[1],
        );
        const proc = Bun.spawn([argv.command, ...argv.args], {
            cwd: dir,
            stdin: 'pipe',
            stdout: 'pipe',
        });
        const write = async (str: string) => {
            proc.stdin.write(str);
            await proc.stdin.flush();
        };
        await write(scriptDriver.encodeTurn({ turnId: 't1', prompt: 'x', correlation: CORRELATION }));
        await Bun.sleep(200);
        proc.stdin.end(); // EOF: the child flushes flood output, replays, and exits
        // The child writes the oversized line itself (>1MiB — argv can't carry it, macOS E2BIG).
        const raw = await new Response(proc.stdout).text();
        expect(await proc.exited).toBe(0);
        expect(raw.length).toBeGreaterThan(TURN_MAX_LINE_BYTES);
        expect(() => createFakeTurnSessionDriver([]).decode(raw.trim())).toThrow(TurnProtocolError); // not a valid frame either
    });
});
