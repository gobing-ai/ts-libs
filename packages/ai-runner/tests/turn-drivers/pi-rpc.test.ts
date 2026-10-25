/**
 * Pi RPC turn-session driver tests (task 1277). Failure cases first per the plan; every
 * end-to-end case replays a captured fixture through a real child process (`pi-replay-agent.ts`)
 * via `openTurnSessionWithDriver` — never an in-process stub. Fixtures were captured from the
 * repository dependency pi 0.87.1 binary on 2026-10-23 (see `tests/fixtures/turn-drivers/pi/README.md`
 * for the PATH 1.4.0 provenance note).
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { AiRunner } from '../../src/ai-runner';
import { createPiTurnSessionDriver, PI_TURN_VERIFIED_VERSION } from '../../src/turn-drivers/pi-rpc';
import {
    TURN_SESSION_DRIVERS,
    type TurnCorrelation,
    type TurnEvent,
    type TurnSessionDriver,
} from '../../src/turn-session';

const CORRELATION: TurnCorrelation = { runId: 'run-1277', executionId: 'exec-1277', requestId: 'req-1277', attempt: 1 };
const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'turn-drivers', 'pi');

/** Driver whose child replays one fixture instead of spawning the real pi binary. */
function replayDriver(fixture: string, exitCode?: number, linger?: boolean): TurnSessionDriver {
    return createPiTurnSessionDriver({
        spawn: {
            command: process.execPath,
            args: [
                join(import.meta.dir, 'pi-replay-agent.ts'),
                join(FIXTURES, fixture),
                ...(exitCode !== undefined ? [String(exitCode)] : []),
                ...(linger === true ? ['linger'] : []),
            ],
        },
    });
}

describe('pi turn-session driver (task 1277)', () => {
    test('qualify: exactly the probed repository-dependency version qualifies (R1/R4)', () => {
        const driver = createPiTurnSessionDriver();
        expect(driver.qualify({ path: 'pi', version: PI_TURN_VERIFIED_VERSION })).toEqual({ qualified: true });
        // The PATH binary 1.4.0 speaks the protocol family but is NOT the qualified spawn target.
        const refusal = driver.qualify({ path: 'pi', version: '1.4.0' });
        expect(refusal.qualified).toBe(false);
        if (!refusal.qualified) {
            expect(refusal.reason).toContain('1.4.0');
            expect(refusal.reason).toContain(PI_TURN_VERIFIED_VERSION);
        }
        expect(driver.qualify({ path: 'pi', version: null }).qualified).toBe(false);
    });

    test('spawnArgv: rpc mode, no session, model flag', () => {
        const argv = createPiTurnSessionDriver().spawnArgv(
            { path: 'pi', version: PI_TURN_VERIFIED_VERSION },
            { workspace: '/w', role: 'reviewer', model: 'glm-5.3-flash' },
        );
        expect(argv.command).toBe('pi');
        expect(argv.args).toEqual(['--mode', 'rpc', '--no-session', '--model', 'glm-5.3-flash']);
    });

    test('encodeTurn echoes the runner turn id; encodeCancel sends the abort command', () => {
        const driver = createPiTurnSessionDriver();
        const frame = driver.encodeTurn({ turnId: 't7', prompt: 'hi', correlation: CORRELATION });
        expect(JSON.parse(frame)).toEqual({ id: 't7', type: 'prompt', message: 'hi' });
        expect(JSON.parse(driver.encodeCancel('test'))).toEqual({ type: 'abort' });
    });

    test('decode: prompt response is acceptance, never completion (response then exit → AC3)', () => {
        const driver = createPiTurnSessionDriver();
        const context = { turnId: 't1', accepted: false };
        // The echo id self-attributes the acceptance — works in any interleave with noise.
        expect(driver.decode('{"id":"t1","type":"response","command":"prompt","success":true}', context)).toEqual([
            { turnId: 't1', type: 'accepted' },
        ]);
        // Already accepted → no duplicate frame.
        expect(
            driver.decode('{"id":"t1","type":"response","command":"prompt","success":true}', {
                turnId: 't1',
                accepted: true,
            }),
        ).toEqual([]);
        // A response for ANOTHER command/turn is foreign noise.
        expect(driver.decode('{"id":"other","type":"response","command":"prompt","success":true}', context)).toEqual(
            [],
        );
        // 1.4.0 disposition shape: started is fine, anything else did not start a run.
        expect(
            driver.decode(
                '{"id":"t1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}',
                context,
            ),
        ).toEqual([{ turnId: 't1', type: 'accepted' }]);
        expect(
            driver.decode(
                '{"id":"t1","type":"response","command":"prompt","success":true,"data":{"disposition":"cancelled"}}',
                context,
            ),
        ).toEqual([
            {
                turnId: 't1',
                type: 'terminal',
                terminal: { kind: 'failure', reason: expect.stringContaining('cancelled') },
            },
        ]);
    });

    test('decode: response-level rejection is pre-acceptance not-started / post-acceptance failure', () => {
        const driver = createPiTurnSessionDriver();
        // Rejection BEFORE acceptance = the turn never started (uniform session contract, same
        // classification as the process-exit path). The Spur 1277 plan pins this outcome.
        const preAcceptance = driver.decode(
            '{"id":"t1","type":"response","command":"prompt","success":false,"error":"no provider"}',
            { turnId: 't1', accepted: false },
        );
        expect(preAcceptance).toHaveLength(1);
        expect(preAcceptance[0]).toMatchObject({
            turnId: 't1',
            type: 'terminal',
            terminal: { kind: 'not-started', reason: expect.stringContaining('no provider') },
        });
        // Rejection AFTER acceptance (accepted turn's command errors) is a definite failure.
        const postAcceptance = driver.decode(
            '{"id":"t1","type":"response","command":"prompt","success":false,"error":"runner crashed"}',
            { turnId: 't1', accepted: true },
        );
        expect(postAcceptance).toHaveLength(1);
        expect(postAcceptance[0]).toMatchObject({
            turnId: 't1',
            type: 'terminal',
            terminal: { kind: 'failure', reason: expect.stringContaining('runner crashed') },
        });
    });

    test('decode: agent_settled is the terminal; aborted discriminator and attribution rules', () => {
        const driver = createPiTurnSessionDriver();
        const context = { turnId: 't1', accepted: true };
        const success = driver.decode('{"type":"agent_settled"}', context);
        expect(success).toEqual([{ turnId: 't1', type: 'terminal', terminal: { kind: 'success' } }]);
        const aborted = driver.decode('{"type":"agent_settled","aborted":true}', context);
        expect(aborted[0]).toMatchObject({ terminal: { kind: 'failure', reason: expect.stringContaining('aborted') } });
        // agent_end precedes retries — never the terminal.
        expect(driver.decode('{"type":"agent_end","messages":[]}', context)).toEqual([]);
        // Late settled after the facade resolved the turn → attributed to no turn.
        expect(driver.decode('{"type":"agent_settled"}')).toEqual([]);
        // Assistant final message → output; system message_end is noise.
        const output = driver.decode(
            '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"alpha"}]}}',
            context,
        );
        expect(output).toEqual([{ turnId: 't1', type: 'output', data: expect.anything() }]);
        expect(driver.decode('{"type":"message_end","message":{"role":"user","content":[]}}', context)).toEqual([]);
        expect(driver.decode('{"type":"extension_ui_request","method":"setStatus"}', context)).toEqual([]);
    });

    test('decode: a parse response settles failure; malformed JSON throws contract-violation', () => {
        const driver = createPiTurnSessionDriver();
        const events = driver.decode(
            '{"type":"response","command":"parse","success":false,"error":"Expected property name"}',
            { turnId: 't1', accepted: true },
        );
        expect(events[0]).toMatchObject({ terminal: { kind: 'failure', reason: expect.stringContaining('parse') } });
        expect(() => driver.decode('garbage {', { turnId: 't1', accepted: true })).toThrow('malformed JSON');
    });

    test('handshake waits for the first parseable record and refuses on EOF/noise-only', async () => {
        const driver = createPiTurnSessionDriver();
        const handshake = driver.handshake;
        if (handshake === undefined) throw new Error('driver must expose a handshake');
        const noisyPull = (() => {
            const lines = ['{"type":"extension_ui_request","method":"setStatus"}', '{"type":"turn_end"}'];
            let at = 0;
            return async () => lines[at++] ?? null;
        })();
        expect(await handshake(noisyPull, () => {})).toEqual({});
        expect(
            await handshake(
                async () => null,
                () => {},
            ),
        ).toBeNull();
    });

    test('registry: pi is registered with the real-binary spawn (evidence-backed)', () => {
        const driver = TURN_SESSION_DRIVERS.get('pi');
        if (driver === undefined) throw new Error('pi driver must be registered');
        expect(
            driver.spawnArgv({ path: 'pi', version: PI_TURN_VERIFIED_VERSION }, { workspace: '/w', role: 'member' })
                .command,
        ).toBe('pi');
        expect(driver.qualify({ path: 'pi', version: PI_TURN_VERIFIED_VERSION })).toEqual({ qualified: true });
    });

    test('AC2: two keyed turns complete in one warm process with correlated terminals', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('pi', {
            driver: replayDriver('success-two-turns.jsonl'),
            binary: { path: 'pi', version: PI_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const session = result.session;
        try {
            const first = session.startTurn({ prompt: 'alpha?', correlation: CORRELATION });
            const firstOutcome = await first.outcome;
            expect(firstOutcome.kind).toBe('success');
            expect(firstOutcome.acceptedAt).toBeDefined();
            const second = session.startTurn({ prompt: 'beta?', correlation: { ...CORRELATION, requestId: 'req-2' } });
            const secondOutcome = await second.outcome;
            expect(secondOutcome.kind).toBe('success');
            expect(secondOutcome.acceptedAt).toBeDefined();
        } finally {
            await session.close();
        }
    });

    test('AC3: acceptance response then exit settles outcome-unknown, never success', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('pi', {
            driver: replayDriver('exit-before-settled.jsonl'),
            binary: { path: 'pi', version: PI_TURN_VERIFIED_VERSION },
            policy: { workspace: process.cwd(), role: 'member' },
            handshakeTimeoutMs: 5_000,
        });
        if (!result.ok) throw new Error('session refused');
        const session = result.session;
        try {
            const handle = session.startTurn({ prompt: 'go', correlation: CORRELATION });
            expect(await handle.accepted).not.toBeNull();
            const outcome = await handle.outcome;
            expect(outcome.kind).toBe('outcome-unknown');
        } finally {
            await session.close();
        }
    });

    test('AC3: exit before any record settles not-started', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('pi', {
            driver: replayDriver('exit-before-any-record.jsonl', 137),
            binary: { path: 'pi', version: PI_TURN_VERIFIED_VERSION },
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
        // Hand-rolled child: startup noise first, then one garbage line — the handshake must
        // succeed on the parseable row before the pump can hit the malformed one.
        const driver = createPiTurnSessionDriver({
            spawn: {
                command: process.execPath,
                args: [
                    '-e',
                    'console.log(JSON.stringify({type:"extension_ui_request",method:"setStatus"})); setTimeout(() => { console.log("not json at all"); process.exit(0); }, 50)',
                ],
            },
        });
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('pi', {
            driver,
            binary: { path: 'pi', version: PI_TURN_VERIFIED_VERSION },
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
        const result = await runner.openTurnSession('pi', {
            driver: replayDriver('success-two-turns.jsonl'),
            binary: { path: 'pi', version: '9.9.9' },
            policy: { workspace: process.cwd(), role: 'member' },
        });
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.reason).toBe('unqualified-version');
        expect(result.detail).toContain('9.9.9');
    });

    test('cancel() during a turn drives a deterministic interrupted outcome', async () => {
        const runner = new AiRunner({});
        const result = await runner.openTurnSession('pi', {
            driver: replayDriver('success-two-turns.jsonl', undefined, true),
            binary: { path: 'pi', version: PI_TURN_VERIFIED_VERSION },
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
