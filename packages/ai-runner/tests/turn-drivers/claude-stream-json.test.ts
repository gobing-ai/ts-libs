/**
 * Claude stream-json turn-session driver tests (task 1276). Failure cases first per the plan; every
 * end-to-end case replays a captured fixture through a real child process (`replay-agent.ts`) via
 * `openTurnSessionWithDriver` — never an in-process stub. Fixtures were captured from the installed
 * claude 2.1.308 binary on 2026-10-22 (see `tests/fixtures/turn-drivers/claude/README.md`).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AiRunner } from '../../src/ai-runner';
import {
    CLAUDE_TURN_VERIFIED_VERSION,
    createClaudeTurnSessionDriver,
    HANDSHAKE_MAX_LINES,
} from '../../src/turn-drivers/claude-stream-json';
import {
    TURN_SESSION_DRIVERS,
    type TurnCorrelation,
    type TurnEvent,
    type TurnSessionDriver,
} from '../../src/turn-session';

const CORRELATION: TurnCorrelation = { runId: 'run-1276', executionId: 'exec-1276', requestId: 'req-1276', attempt: 1 };
const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'turn-drivers', 'claude');

/** Driver whose child replays one fixture instead of spawning the real claude binary. */
function replayDriver(fixture: string, exitCode?: number, linger?: boolean): TurnSessionDriver {
    return createClaudeTurnSessionDriver({
        spawn: {
            command: process.execPath,
            args: [
                join(import.meta.dir, 'replay-agent.ts'),
                join(FIXTURES, fixture),
                ...(exitCode !== undefined ? [String(exitCode)] : []),
                ...(linger === true ? ['linger'] : []),
            ],
        },
    });
}

describe('claude turn-session driver (task 1276)', () => {
    test('qualify: exactly the probed version qualifies (R1/R4)', () => {
        const driver = createClaudeTurnSessionDriver();
        expect(driver.qualify({ path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION })).toEqual({ qualified: true });
        const refusal = driver.qualify({ path: 'claude', version: '2.1.278' });
        expect(refusal.qualified).toBe(false);
        if (!refusal.qualified) expect(refusal.reason).toContain('2.1.278');
        expect(driver.qualify({ path: 'claude', version: null }).qualified).toBe(false);
    });

    test('spawnArgv: print mode, stream-json both ways, --verbose (mandatory), model/role flags', () => {
        const argv = createClaudeTurnSessionDriver().spawnArgv(
            { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
            { workspace: '/w', role: 'reviewer', model: 'claude-opus-5-5' },
        );
        expect(argv.command).toBe('claude');
        expect(argv.args).toEqual([
            '-p',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--model',
            'claude-opus-5-5',
            '--append-system-prompt',
            'reviewer',
        ]);
    });

    test('encodeTurn reuses the shim user envelope; encodeCancel sends an interrupt control request', () => {
        const driver = createClaudeTurnSessionDriver();
        const frame = driver.encodeTurn({ turnId: 't1', prompt: 'hi', correlation: CORRELATION });
        expect(JSON.parse(frame)).toEqual({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        });
        const cancel = JSON.parse(driver.encodeCancel('test')) as { type: string; request: { subtype: string } };
        expect(cancel.type).toBe('control_request');
        expect(cancel.request.subtype).toBe('interrupt');
    });

    test('handshake takes the session id from the first record carrying one', async () => {
        const driver = createClaudeTurnSessionDriver();
        const pulled = [
            '{"type":"system","subtype":"hook_started"}',
            '{"type":"system","subtype":"init","session_id":"s-9"}',
        ];
        let index = 0;
        const handshake = driver.handshake;
        if (handshake === undefined) throw new Error('driver must expose a handshake');
        const result = await handshake(async () => pulled[index++] ?? null);
        expect(result).toEqual({ nativeSessionId: 's-9' });
        // EOF before any session evidence → null (handshake refusal downstream).
        expect(await handshake(async () => null)).toBeNull();
    });

    test('handshake: JSON noise rows are skipped; 64 non-session rows exhaust to null', async () => {
        const driver = createClaudeTurnSessionDriver();
        const handshake = driver.handshake;
        if (handshake === undefined) throw new Error('driver must expose a handshake');
        // Pre-protocol noise before the init must not break the handshake.
        const noisyPull = (() => {
            const lines = [
                'garbage {',
                '{"type":"system","subtype":"hook_started"}',
                '{"type":"system","subtype":"init","session_id":"s-noise"}',
            ];
            let at = 0;
            return async () => lines[at++] ?? null;
        })();
        expect(await handshake(noisyPull)).toEqual({ nativeSessionId: 's-noise' });
        // Exhausting the 64-line window without session evidence → null.
        let seen = 0;
        expect(
            await handshake(async () => {
                seen += 1;
                return '{"type":"system","subtype":"hook_started"}';
            }),
        ).toBeNull();
        expect(seen).toBe(HANDSHAKE_MAX_LINES);
    });

    test('decode: a turn with no boundary init accepts on its first assistant output', () => {
        const driver = createClaudeTurnSessionDriver();
        // The pump consumed turn 1's init as pre-session noise → the first output infers acceptance.
        const events = driver.decode('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}', {
            turnId: 't1',
            accepted: false,
        });
        expect(events).toEqual([
            { turnId: 't1', type: 'accepted' },
            { turnId: 't1', type: 'output', data: expect.anything() },
        ]);
    });

    test('decode: is_error decides the terminal kind; noise rows decode to nothing', () => {
        const driver = createClaudeTurnSessionDriver();
        const context = { turnId: 't1', accepted: true };
        expect(driver.decode('{"type":"rate_limit_event","rate_limit_info":{}}', context)).toEqual([]);
        expect(
            driver.decode('{"type":"system","subtype":"init","session_id":"s"}', { turnId: 't1', accepted: false }),
        ).toEqual([{ turnId: 't1', type: 'accepted' }]);
        // An already-accepted turn gets no duplicate accepted frame from a repeated init.
        expect(driver.decode('{"type":"system","subtype":"init","session_id":"s"}', context)).toEqual([]);
        const success = driver.decode(
            '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"s-1"}',
            context,
        );
        expect(success).toHaveLength(1);
        expect(success[0]).toMatchObject({
            turnId: 't1',
            type: 'terminal',
            terminal: { kind: 'success', nativeSessionId: 's-1', finalText: 'ok' },
        });
        // API errors keep subtype success — is_error is the failure signal (observed 2.1.308).
        const apiError = driver.decode(
            '{"type":"result","subtype":"success","is_error":true,"result":"model issue"}',
            context,
        );
        expect(apiError[0]).toMatchObject({
            type: 'terminal',
            terminal: { kind: 'failure', reason: expect.stringContaining('success') },
        });
        const interrupt = driver.decode(
            '{"type":"result","subtype":"error_during_execution","is_error":true}',
            context,
        );
        expect(interrupt[0]).toMatchObject({ terminal: { kind: 'failure' } });
        // Records without a facade context are foreign — attributed to no turn.
        expect(driver.decode('{"type":"result","is_error":false,"result":"late"}')).toEqual([
            { turnId: null, type: 'terminal', terminal: { kind: 'success', finalText: 'late' } },
        ]);
    });

    test('registry: claude is registered with the real-binary spawn (evidence-backed)', () => {
        const driver = TURN_SESSION_DRIVERS.get('claude');
        if (driver === undefined) throw new Error('claude driver must be registered');
        expect(
            driver.spawnArgv(
                { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
                { workspace: '/w', role: 'member' },
            ).command,
        ).toBe('claude');
        expect(driver.qualify({ path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION })).toEqual({ qualified: true });
    });

    test('AC2: two keyed turns complete in one warm process with correlated terminals', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('claude', {
            driver: replayDriver('success-two-turns.jsonl'),
            binary: { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const session = result.session;
        try {
            expect(session.nativeSessionId).toBe('<uuid>');
            const first = session.startTurn({ prompt: 'alpha?', correlation: CORRELATION });
            const firstOutcome = await first.outcome;
            expect(firstOutcome.kind).toBe('success');
            expect(firstOutcome.nativeSessionId).toBe('<uuid>');
            expect(firstOutcome.finalText).toBe('alpha');
            expect(firstOutcome.acceptedAt).toBeDefined();
            const second = session.startTurn({ prompt: 'beta?', correlation: { ...CORRELATION, requestId: 'req-2' } });
            const secondOutcome = await second.outcome;
            expect(secondOutcome.kind).toBe('success');
            expect(secondOutcome.finalText).toBe('beta');
            // One process served both: the same native session, two receipts.
            expect(secondOutcome.nativeSessionId).toBe(firstOutcome.nativeSessionId);
        } finally {
            await session.close();
        }
    });

    test('AC3a: an error-subtype result settles failure, never success', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('claude', {
            driver: replayDriver('error-result.jsonl'),
            binary: { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        if (!result.ok) throw new Error('session refused');
        const session = result.session;
        try {
            const outcome = await session.startTurn({ prompt: 'go', correlation: CORRELATION }).outcome;
            expect(outcome.kind).toBe('failure');
            expect(outcome.reason).toContain('error');
            expect(outcome.finalText).toContain('nonexistent-model-xyz');
        } finally {
            await session.close();
        }
    });

    test('AC3b: partial output then exit settles outcome-unknown', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('claude', {
            driver: replayDriver('partial-output-no-result.jsonl'),
            binary: { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        if (!result.ok) throw new Error('session refused');
        const session = result.session;
        try {
            const outcome = await session.startTurn({ prompt: 'count', correlation: CORRELATION }).outcome;
            expect(outcome.kind).toBe('outcome-unknown');
            expect(outcome.firstOutputAt).toBeDefined();
        } finally {
            await session.close();
        }
    });

    test('AC3c: exit before any record settles not-started', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('claude', {
            driver: replayDriver('exit-before-any-record.jsonl', 137),
            binary: { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        if (!result.ok) throw new Error('session refused');
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

    test('a malformed JSON line settles contract-violation', async () => {
        // Hand-rolled child: echo one garbage line then stop.
        // Hand-rolled child: startup session evidence first, then one garbage line — the handshake
        // must succeed before the pump can hit the malformed row.
        const driver = createClaudeTurnSessionDriver({
            spawn: {
                command: process.execPath,
                args: [
                    '-e',
                    'console.log(JSON.stringify({type:"system",subtype:"init",session_id:"s-err"})); console.log("not json at all")',
                ],
            },
        });
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('claude', {
            driver,
            binary: { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        if (!result.ok) throw new Error('session refused');
        const session = result.session;
        try {
            const outcome = await session.startTurn({ prompt: 'go', correlation: CORRELATION }).outcome;
            expect(outcome.kind).toBe('contract-violation');
        } finally {
            await session.close();
        }
    });

    test('unqualified versions refuse with a typed reason before any spawn (R4)', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('claude', {
            driver: replayDriver('success-two-turns.jsonl'),
            binary: { path: 'claude', version: '9.9.9' },
            policy: { workspace: process.cwd(), role: 'member' },
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('unqualified-version');
        expect(result.detail).toContain('9.9.9');
    });

    test('the interrupted fixture drives cancel() to a deterministic interrupted outcome', async () => {
        const runner = new AiRunner({});
        // The fixture's turn group ends with the error_during_execution result the interrupt produces.
        const result = await runner.openTurnSession('claude', {
            driver: replayDriver('interrupted-turn.jsonl', undefined, true),
            binary: { path: 'claude', version: CLAUDE_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        if (!result.ok) throw new Error('session refused');
        const session = result.session;
        const events: TurnEvent[] = [];
        try {
            const handle = session.startTurn({ prompt: 'count', correlation: CORRELATION });
            const collected: TurnEvent[] = [];
            void (async () => {
                for await (const event of handle.events) collected.push(event);
            })();
            const outcome = await handle.cancel('operator stop', { graceMs: 5_000 });
            expect(outcome.kind).toBe('interrupted');
            events.push(...collected);
        } finally {
            await session.close();
        }
        expect(events.some((event) => event.type === 'terminal' && event.outcome.kind === 'interrupted')).toBe(true);
    });
});
