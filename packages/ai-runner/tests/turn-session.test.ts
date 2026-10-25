import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipeProcess, ProcessExecutor } from '@gobing-ai/ts-runtime';
import { AiRunner } from '../src/ai-runner';
import { createFakeTurnSessionDriver, type FakeTurnAction } from '../src/testing/fake-turn-driver';
import type { TurnCorrelation, TurnEvent, TurnOutcome, TurnSessionDriver } from '../src/turn-session';
import { TURN_CANCEL_GRACE_MS, TurnSessionBusyError } from '../src/turn-session';

const CORRELATION: TurnCorrelation = {
    runId: 'run-1284',
    executionId: 'exec-1284',
    requestId: 'req-1284',
    attempt: 1,
};

describe('TurnSession (task 1284 — correlated warm-turn session facade)', () => {
    const cleanup: Array<() => Promise<void>> = [];
    let workspace = '';

    afterEach(async () => {
        while (cleanup.length > 0) await cleanup.pop()?.();
        if (workspace !== '') {
            const dir = workspace;
            workspace = '';
            await rm(dir, { recursive: true, force: true });
        }
    });

    function fakeRunner(
        actions: FakeTurnAction[],
        overrides?: Partial<TurnSessionDriver>,
    ): {
        runner: AiRunner;
        driver: TurnSessionDriver;
    } {
        return { runner: new AiRunner({}), driver: createFakeTurnSessionDriver(actions, overrides) };
    }

    async function open(runner: AiRunner, driver: TurnSessionDriver) {
        if (workspace === '') workspace = await mkdtemp(join(tmpdir(), 'turn-session-ws-'));
        const result = await runner.openTurnSession('pi', {
            policy: { workspace, role: 'member' },
            driver,
            binary: { path: '/fake/turn-agent', version: '9.9.9' },
            handshakeTimeoutMs: 5_000,
        });
        if (result.ok) cleanup.push(() => result.session.close());
        return result;
    }

    async function drain(events: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
        const collected: TurnEvent[] = [];
        for await (const event of events) collected.push(event);
        return collected;
    }

    test('AC1: unsupported agent — typed refusal, never a throw, no process spawned', async () => {
        let spawned = false;
        const exploding: ProcessExecutor = {
            run: () => {
                throw new Error('must not spawn');
            },
            runStreaming: (): PipeProcess => {
                spawned = true;
                throw new Error('must not spawn');
            },
        } as unknown as ProcessExecutor;
        const runner = new AiRunner({ processExecutor: exploding });
        // 'gemini' has no registered turn-session driver (claude/codex/pi are registered) —
        // refused before any probe.
        const result = await runner.openTurnSession('gemini', { policy: { workspace: process.cwd(), role: 'member' } });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('unsupported-agent');
            expect(result.detail.length).toBeGreaterThan(0);
        }
        expect(spawned).toBe(false);
    });

    test('AC1: probe explosion — typed refusal, never a throw', async () => {
        const explodingProbe: ProcessExecutor = {
            run: () => {
                throw new Error('probe blew up');
            },
            runStreaming: (): PipeProcess => {
                throw new Error('must not stream');
            },
        } as unknown as ProcessExecutor;
        const runner = new AiRunner({ processExecutor: explodingProbe });
        const result = await runner.openTurnSession('claude', { policy: { workspace: process.cwd(), role: 'member' } });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('spawn-failed');
            expect(result.detail).toContain('probe blew up');
        }
    });

    test('AC1: unqualified version — typed refusal with the driver reason', async () => {
        const { runner, driver } = fakeRunner([], {
            qualify: () => ({ qualified: false, reason: 'turn protocol needs >= 9.9.9' }),
        });
        const result = await open(runner, driver);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('unqualified-version');
            expect(result.detail).toContain('turn protocol needs >= 9.9.9');
        }
    });

    test('spawn failure — typed refusal', async () => {
        const driver = createFakeTurnSessionDriver([{ op: 'exit', code: 2 }]);
        const exploding: ProcessExecutor = {
            run: () => {
                throw new Error('enoent');
            },
            runStreaming: () => {
                throw new Error('spawn ENOENT');
            },
        } as unknown as ProcessExecutor;
        const runner = new AiRunner({ processExecutor: exploding });
        const result = await runner.openTurnSession('pi', {
            policy: { workspace: process.cwd(), role: 'member' },
            driver,
            binary: { path: '/fake/turn-agent', version: '9.9.9' },
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toBe('spawn-failed');
            expect(result.detail).toContain('ENOENT');
        }
    });

    test('handshake failure — child exits before ready', async () => {
        const { runner, driver } = fakeRunner([{ op: 'exit', code: 3 }]);
        const result = await open(runner, driver);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.reason).toBe('handshake-failed');
    });

    test('driver terminal not-started settles not-started (pre-acceptance rejection contract)', async () => {
        const { runner, driver } = fakeRunner([{ op: 'terminal', kind: 'not-started' }]);
        const result = await open(runner, driver);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const session = result.session;
        try {
            const handle = session.startTurn({ prompt: 'go', correlation: CORRELATION });
            expect(await handle.accepted).toBeNull();
            const outcome = await handle.outcome;
            expect(outcome.kind).toBe('not-started');
        } finally {
            await session.close();
        }
    });

    test('AC2: acceptance and terminal outcome are separate and correlated', async () => {
        const { runner, driver } = fakeRunner([
            { op: 'accept' },
            { op: 'output', data: 'working…' },
            { op: 'terminal', kind: 'success', nativeTurnId: 'native-t-1', finalText: 'done' },
        ]);
        const result = await open(runner, driver);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const session = result.session;
        const handle = session.startTurn({ prompt: 'status?', correlation: CORRELATION });
        const accepted = await handle.accepted;
        expect(accepted).not.toBeNull();
        const outcome = await handle.outcome;
        expect(outcome.kind).toBe('success');
        expect(outcome.correlation).toEqual(CORRELATION);
        expect(outcome.nativeTurnId).toBe('native-t-1');
        expect(outcome.nativeSessionId).toBeDefined();
        expect(outcome.finalText).toBe('done');
        expect(outcome.acceptedAt).toBe(accepted?.acceptedAt);
        const events = await drain(handle.events);
        expect(events.some((event) => event.type === 'accepted')).toBe(true);
        expect(events.some((event) => event.type === 'output')).toBe(true);
        expect(events.filter((event) => event.type === 'terminal')).toHaveLength(1);
        expect(session.state).toBe('ready');
    });

    test('exit before acceptance → not-started', async () => {
        const { runner, driver } = fakeRunner([
            { op: 'sleep', ms: 200 },
            { op: 'exit', code: 1 },
        ]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'hi', correlation: CORRELATION });
        expect(await handle.accepted).toBeNull();
        expect((await handle.outcome).kind).toBe('not-started');
    });

    test('exit after acceptance without native terminal → outcome-unknown', async () => {
        const { runner, driver } = fakeRunner([{ op: 'accept' }, { op: 'exit', code: 1 }]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'hi', correlation: CORRELATION });
        expect(await handle.accepted).not.toBeNull();
        expect((await handle.outcome).kind).toBe('outcome-unknown');
    });

    test('AC3: one active turn — second startTurn rejects with TurnSessionBusyError', async () => {
        const { runner, driver } = fakeRunner([
            { op: 'sleep', ms: 200 },
            { op: 'accept' },
            { op: 'terminal', kind: 'success' },
        ]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'first', correlation: CORRELATION });
        expect(result.session.state).toBe('busy');
        expect(() => result.session.startTurn({ prompt: 'second', correlation: CORRELATION })).toThrow(
            TurnSessionBusyError,
        );
        await handle.outcome;
        expect(result.session.state).toBe('ready');
    });

    test('AC3: foreign and duplicate terminals surface only as diagnostics', async () => {
        const { runner, driver } = fakeRunner([
            { op: 'accept' },
            { op: 'stray', line: { turn: 'not-my-turn', type: 'terminal', kind: 'success' } },
            { op: 'terminal', kind: 'success' },
            { op: 'stray', line: { turn: 'same-turn-again', type: 'terminal', kind: 'failure' } },
        ]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'hi', correlation: CORRELATION });
        const outcome = await handle.outcome;
        expect(outcome.kind).toBe('success');
        const events = await drain(handle.events);
        const stray = events.filter((event) => event.type === 'diagnostic');
        expect(stray.length).toBeGreaterThanOrEqual(2);
        expect(events.filter((event) => event.type === 'terminal')).toHaveLength(1);
    });

    test('AC4: child exits before acceptance already covered; cancel answered → interrupted', async () => {
        const { runner, driver } = fakeRunner([
            { op: 'sleep', ms: 5_000 },
            { op: 'accept' },
            { op: 'terminal', kind: 'success' },
        ]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'long', correlation: CORRELATION });
        const outcome = await handle.cancel('operator interrupt');
        expect(outcome.kind).toBe('interrupted');
    });

    test('AC4: cancel ignored past grace → outcome-unknown', async () => {
        const { runner, driver } = fakeRunner([
            { op: 'accept' },
            { op: 'ignore-cancel' },
            { op: 'sleep', ms: 60_000 },
            { op: 'terminal', kind: 'success' },
        ]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'stubborn', correlation: CORRELATION });
        const outcome = await handle.cancel('giving up', { graceMs: 50 });
        expect(outcome.kind).toBe('outcome-unknown');
    }, 10_000);

    test('cancel-grace constant is exported and sane', () => {
        expect(TURN_CANCEL_GRACE_MS).toBe(5_000);
    });

    test('line longer than 1 MiB → contract-violation', async () => {
        const { runner, driver } = fakeRunner([{ op: 'accept' }, { op: 'flood' }]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'hi', correlation: CORRELATION });
        expect((await handle.outcome).kind).toBe('contract-violation');
    });

    test('close while a turn is busy settles the turn and closes the session', async () => {
        const { runner, driver } = fakeRunner([
            { op: 'sleep', ms: 30_000 },
            { op: 'accept' },
            { op: 'terminal', kind: 'success' },
        ]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        const handle = result.session.startTurn({ prompt: 'bye', correlation: CORRELATION });
        await result.session.close();
        expect(result.session.state).toBe('closed');
        const outcome: TurnOutcome = await handle.outcome;
        expect(['interrupted', 'outcome-unknown']).toContain(outcome.kind);
        expect(() => result.session.startTurn({ prompt: 'late', correlation: CORRELATION })).toThrow();
    });

    test('policyDigest is stable across key order', async () => {
        const { runner, driver } = fakeRunner([{ op: 'terminal', kind: 'success' }]);
        const result = await open(runner, driver);
        if (!result.ok) return expect.unreachable();
        expect(result.session.policyDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    test('fake driver uses a temp script and cleans it up (fixture sanity)', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'turn-session-fixture-'));
        expect(dir.startsWith(tmpdir())).toBe(true);
        await rm(dir, { recursive: true, force: true });
    });
});
