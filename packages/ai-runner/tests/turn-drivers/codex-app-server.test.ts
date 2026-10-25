/**
 * Codex App Server turn-session driver tests (task 1278). Every end-to-end case replays a REAL
 * capture through a child process (`codex-replay-agent.ts`) via `openTurnSessionWithDriver` —
 * never an in-process stub. Fixtures were captured from `codex-cli 0.164.0` on 2026-10-24 (see
 * `tests/fixtures/turn-drivers/codex/README.md` for provenance and redactions).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AiRunner } from '../../src/ai-runner';
import { CODEX_TURN_VERIFIED_VERSION, createCodexTurnSessionDriver } from '../../src/turn-drivers/codex-app-server';
import { TURN_SESSION_DRIVERS, type TurnCorrelation, type TurnSessionDriver } from '../../src/turn-session';

const CORRELATION: TurnCorrelation = {
    runId: 'run-1278',
    executionId: 'exec-1278',
    requestId: 'req-1278',
    attempt: 1,
};
const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'turn-drivers', 'codex');

/** Driver whose child replays one fixture instead of spawning the real codex binary. */
function replayDriver(fixture: string): TurnSessionDriver {
    return createCodexTurnSessionDriver({
        spawn: {
            command: process.execPath,
            args: [join(import.meta.dir, 'codex-replay-agent.ts'), join(FIXTURES, fixture)],
        },
    });
}

describe('codex app-server turn-session driver (task 1278)', () => {
    test('qualify: exactly the probed version qualifies (R1/R4)', () => {
        const driver = createCodexTurnSessionDriver();
        expect(driver.qualify({ path: 'codex', version: CODEX_TURN_VERIFIED_VERSION })).toEqual({ qualified: true });
        const refusal = driver.qualify({ path: 'codex', version: '0.155.1' });
        expect(refusal.qualified).toBe(false);
        if (!refusal.qualified) {
            expect(refusal.reason).toContain('0.155.1');
            expect(refusal.reason).toContain(CODEX_TURN_VERIFIED_VERSION);
        }
        expect(driver.qualify({ path: 'codex', version: null }).qualified).toBe(false);
    });

    test('spawnArgv: app-server, model overrides reach the thread as TOML config', () => {
        const driver = createCodexTurnSessionDriver();
        expect(
            driver.spawnArgv(
                { path: 'codex', version: CODEX_TURN_VERIFIED_VERSION },
                { workspace: '/w', role: 'member' },
            ),
        ).toEqual({
            command: 'codex',
            args: ['app-server'],
        });
        expect(
            driver.spawnArgv(
                { path: 'codex', version: CODEX_TURN_VERIFIED_VERSION },
                { workspace: '/w', role: 'member', model: 'gpt-6.1-sol' },
            ).args,
        ).toEqual(['app-server', '-c', 'model="gpt-6.1-sol"']);
    });

    test('encodeTurn addresses the handshake thread; missing scope is a typed refusal (R2)', () => {
        const driver = createCodexTurnSessionDriver();
        const frame = JSON.parse(
            driver.encodeTurn({
                turnId: 't7',
                prompt: 'hi',
                correlation: CORRELATION,
                scope: { nativeSessionId: 'thread-1' },
            }),
        );
        expect(frame).toEqual({
            id: 't7',
            method: 'turn/start',
            params: { threadId: 'thread-1', input: [{ type: 'text', text: 'hi', text_elements: [] }] },
        });
        expect(() => driver.encodeTurn({ turnId: 't7', prompt: 'hi', correlation: CORRELATION })).toThrow('thread id');
    });

    test('decode: turn/start response is acceptance and carries the native turn id, never completion', () => {
        const driver = createCodexTurnSessionDriver();
        const frame = JSON.stringify({
            id: 't1',
            result: { turn: { id: 'native-turn-1', status: 'inProgress', items: [], error: null } },
        });
        expect(driver.decode(frame, { turnId: 't1', accepted: false })).toEqual([
            { turnId: 't1', type: 'accepted', nativeTurnId: 'native-turn-1' },
        ]);
        // Already accepted → the response is not re-emitted (no duplicate acceptance).
        expect(driver.decode(frame, { turnId: 't1', accepted: true })).toEqual([]);
    });

    test('decode: rejection is pre-acceptance not-started, post-acceptance failure', () => {
        const driver = createCodexTurnSessionDriver();
        const rejection = JSON.stringify({ id: 't1', error: { code: -32602, message: 'invalid params' } });
        expect(driver.decode(rejection, { turnId: 't1', accepted: false })).toEqual([
            {
                turnId: 't1',
                type: 'terminal',
                terminal: { kind: 'not-started', reason: expect.stringContaining('invalid params') },
            },
        ]);
        expect(driver.decode(rejection, { turnId: 't1', accepted: true })).toEqual([
            {
                turnId: 't1',
                type: 'terminal',
                terminal: { kind: 'failure', reason: expect.stringContaining('invalid params') },
            },
        ]);
    });

    test('decode: turn/completed maps completed→success with final text, failed/interrupted→failure (R3)', () => {
        const driver = createCodexTurnSessionDriver();
        const context = { turnId: 't1', accepted: true };
        const completed = JSON.stringify({
            method: 'turn/completed',
            params: {
                threadId: 'thread-1',
                turn: {
                    id: 'native-1',
                    status: 'completed',
                    error: null,
                    items: [
                        { type: 'agentMessage', text: 'draft', phase: 'commentary' },
                        { type: 'agentMessage', text: 'ALPHA', phase: 'final_answer' },
                    ],
                },
            },
        });
        expect(driver.decode(completed, context)).toEqual([
            {
                turnId: 't1',
                type: 'terminal',
                terminal: {
                    kind: 'success',
                    nativeTurnId: 'native-1',
                    nativeSessionId: 'thread-1',
                    finalText: 'ALPHA',
                },
            },
        ]);
        const failed = JSON.stringify({
            method: 'turn/completed',
            params: {
                threadId: 'thread-1',
                turn: { id: 'native-2', status: 'failed', error: { message: 'model 400' } },
            },
        });
        expect(driver.decode(failed, context)).toEqual([
            {
                turnId: 't1',
                type: 'terminal',
                terminal: {
                    kind: 'failure',
                    nativeTurnId: 'native-2',
                    nativeSessionId: 'thread-1',
                    reason: expect.stringContaining('model 400'),
                },
            },
        ]);
        // A native interruption the caller did NOT request is a failure; the facade upgrades a
        // requested cancel to `interrupted` itself.
        const interrupted = JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'native-3', status: 'interrupted', error: null } },
        });
        expect(driver.decode(interrupted, context)[0]).toMatchObject({
            terminal: { kind: 'failure', reason: expect.stringContaining('interrupted') },
        });
        // `inProgress` never terminates a turn.
        const inProgress = JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'native-4', status: 'inProgress' } },
        });
        expect(driver.decode(inProgress, context)[0]?.type).toBe('diagnostic');
    });

    test('decode: startup and progress noise is ignored; malformed JSON is a protocol violation', () => {
        const driver = createCodexTurnSessionDriver();
        const context = { turnId: 't1', accepted: true };
        for (const line of [
            '{"method":"mcpServer/startupStatus/updated","params":{"name":"x"}}',
            '{"method":"hook/started","params":{}}',
            '{"method":"thread/tokenUsage/updated","params":{}}',
            '{"method":"item/agentMessage/delta","params":{"delta":"AL"}}',
        ]) {
            expect(driver.decode(line, context)).toEqual([]);
        }
        // No active turn → no attribution at all.
        expect(driver.decode('{"method":"turn/started","params":{}}')).toEqual([]);
        expect(() => driver.decode('garbage {', context)).toThrow('malformed JSON');
    });

    test('handshake bootstraps initialize → initialized → thread/start and returns the thread id', async () => {
        const driver = createCodexTurnSessionDriver();
        const handshake = driver.handshake;
        if (handshake === undefined) throw new Error('driver must expose a handshake');
        const sent: string[] = [];
        const lines = [
            '{"method":"mcpServer/startupStatus/updated","params":{}}',
            JSON.stringify({ id: '__spur_initialize', result: { userAgent: 'codex' } }),
            JSON.stringify({ id: '__spur_thread', result: { thread: { id: 'thread-9' }, model: 'gpt' } }),
        ];
        let at = 0;
        const pull = async (): Promise<string | null> => lines[at++] ?? null;
        const result = await handshake(pull, (line) => sent.push(line));
        expect(result).toEqual({ nativeSessionId: 'thread-9' });
        expect(sent.map((line) => JSON.parse(line))).toMatchObject([
            { id: '__spur_initialize', method: 'initialize' },
            { method: 'initialized' },
            { id: '__spur_thread', method: 'thread/start' },
        ]);
    });

    test('handshake accepts the thread/resume response shape and fails on an error or EOF', async () => {
        const driver = createCodexTurnSessionDriver();
        const handshake = driver.handshake;
        if (handshake === undefined) throw new Error('driver must expose a handshake');
        const resumeLines = [
            JSON.stringify({ id: '__spur_initialize', result: {} }),
            JSON.stringify({ id: '__spur_thread', result: { thread: { id: 'thread-resumed' } } }),
        ];
        let at = 0;
        expect(
            await handshake(
                async () => resumeLines[at++] ?? null,
                () => {},
            ),
        ).toEqual({
            nativeSessionId: 'thread-resumed',
        });
        const errorLines = [JSON.stringify({ id: '__spur_initialize', error: { message: 'unauthorized' } })];
        let at2 = 0;
        expect(
            handshake(
                async () => errorLines[at2++] ?? null,
                () => {},
            ),
        ).rejects.toThrow('unauthorized');
        expect(
            handshake(
                async () => null,
                () => {},
            ),
        ).rejects.toThrow('closed during the handshake');
    });

    test('registry: codex is registered with the real-binary spawn (evidence-backed, R1)', () => {
        const driver = TURN_SESSION_DRIVERS.get('codex');
        if (driver === undefined) throw new Error('codex driver must be registered');
        expect(driver.qualify({ path: 'codex', version: CODEX_TURN_VERIFIED_VERSION })).toEqual({ qualified: true });
        expect(
            driver.spawnArgv(
                { path: 'codex', version: CODEX_TURN_VERIFIED_VERSION },
                { workspace: '/w', role: 'member' },
            ),
        ).toEqual({ command: 'codex', args: ['app-server'] });
    });

    test('AC1/AC2: two keyed turns in one process share the native thread id, distinct turn ids', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('codex', {
            driver: replayDriver('success-two-turns.jsonl'),
            binary: { path: 'codex', version: CODEX_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const session = result.session;
        try {
            expect(session.nativeSessionId).toBe('01a1705e-c0ab-7ab1-aa00-9f3e09be957a');
            const first = await session.startTurn({ prompt: 'say ALPHA', correlation: CORRELATION }).outcome;
            expect(first.kind).toBe('success');
            expect(first.acceptedAt).toBeDefined();
            expect(first.finalText).toBe('ALPHA');
            expect(first.nativeTurnId).toBe('01a1705e-c10f-71b2-b1f3-2ef7b4570cfe');
            expect(first.nativeSessionId).toBe('01a1705e-c0ab-7ab1-aa00-9f3e09be957a');
            const second = await session.startTurn({
                prompt: 'say BETA',
                correlation: { ...CORRELATION, requestId: 'req-2', attempt: 2 },
            }).outcome;
            expect(second.kind).toBe('success');
            expect(second.finalText).toBe('BETA');
            expect(second.nativeTurnId).toBe('01a1705e-d0a4-7fd2-8171-8194a14bd2e8');
            // One process served both turns on ONE thread, with distinct native turn ids.
            expect(second.nativeSessionId).toBe(first.nativeSessionId);
            expect(second.nativeTurnId).not.toBe(first.nativeTurnId);
        } finally {
            await session.close();
        }
    });

    test('AC3: a failed turn settles failure with the native error, never success', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('codex', {
            driver: replayDriver('failed-turn.jsonl'),
            binary: { path: 'codex', version: CODEX_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        try {
            const outcome = await result.session.startTurn({ prompt: 'do work', correlation: CORRELATION }).outcome;
            expect(outcome.kind).toBe('failure');
            expect(outcome.reason).toContain('codex turn failed');
            expect(outcome.finalText).toBeUndefined();
        } finally {
            await result.session.close();
        }
    });

    test('AC3: a cancel resolves interrupted only after the native completion', { timeout: 30_000 }, async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('codex', {
            driver: replayDriver('interrupted-turn.jsonl'),
            binary: { path: 'codex', version: CODEX_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const session = result.session;
        try {
            const turn = session.startTurn({ prompt: 'count to 200', correlation: CORRELATION });
            await turn.accepted;
            const outcome = await turn.cancel('operator cancelled', { graceMs: 2_000 });
            expect(outcome.kind).toBe('interrupted');
            expect(outcome.reason).toContain('interrupted');
            expect(outcome.nativeSessionId).toBe('01a1705e-7c14-7252-b522-83c36a064a81');
            expect(outcome.nativeTurnId).toBe('01a1705e-7c7a-7363-b409-c97aaf7275bf');
        } finally {
            await session.close();
        }
    });
});
