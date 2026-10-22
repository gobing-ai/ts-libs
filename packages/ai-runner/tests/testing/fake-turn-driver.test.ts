import { describe, expect, test } from 'bun:test';
import { createFakeTurnSessionDriver } from '../../src/testing/fake-turn-driver';
import { TurnProtocolError } from '../../src/turn-session';

const CORRELATION = { runId: 'r', executionId: 'e', requestId: 'q', attempt: 1 };

describe('createFakeTurnSessionDriver (task 1284)', () => {
    test('encodeTurn / encodeCancel emit newline-terminated JSONL frames', () => {
        const driver = createFakeTurnSessionDriver([]);
        const frame = driver.encodeTurn({ turnId: 't1', prompt: 'hi', correlation: CORRELATION });
        expect(frame.endsWith('\n')).toBe(true);
        expect(JSON.parse(frame)).toEqual({ type: 'turn', turnId: 't1', prompt: 'hi', correlation: CORRELATION });
        const cancel = driver.encodeCancel('test');
        expect(cancel.endsWith('\n')).toBe(true);
        expect(JSON.parse(cancel) as { type: string; reason: string }).toEqual({ type: 'cancel', reason: 'test' });
    });

    test('decode maps child frames; control frames are handshake-only; garbage throws TurnProtocolError', () => {
        const driver = createFakeTurnSessionDriver([]);
        expect(driver.decode('{"ctl":"ready","nativeSessionId":"s1"}')).toEqual([]);
        expect(driver.decode('{"type":"accepted","turn":"t1"}')).toEqual([{ turnId: 't1', type: 'accepted' }]);
        const terminal = driver.decode('{"type":"terminal","turn":"t1","kind":"failure","finalText":"boom"}');
        expect(terminal).toHaveLength(1);
        expect(terminal[0]).toMatchObject({
            turnId: 't1',
            type: 'terminal',
            terminal: { kind: 'failure', finalText: 'boom' },
        });
        expect(() => driver.decode('not json')).toThrow(TurnProtocolError);
        expect(() => driver.decode('{"nope":1}')).toThrow(TurnProtocolError);
    });

    test('default handshake consumes one ready frame via pull', async () => {
        const driver = createFakeTurnSessionDriver([]);
        let pulled = 0;
        const result = await (driver.handshake as NonNullable<typeof driver.handshake>)(async () => {
            pulled += 1;
            return '{"ctl":"ready","nativeSessionId":"s2"}';
        });
        expect(pulled).toBe(1);
        expect(result).toEqual({ nativeSessionId: 's2' });
    });

    test('handshake returns null on EOF before ready', async () => {
        const driver = createFakeTurnSessionDriver([]);
        const result = await (driver.handshake as NonNullable<typeof driver.handshake>)(async () => null);
        expect(result).toBeNull();
    });

    test('spawnArgv points at the fake-turn-agent sibling with the script as argv[2]', () => {
        const driver = createFakeTurnSessionDriver([{ op: 'accept' }]);
        const argv = driver.spawnArgv({ path: '/x', version: '1.0.0' }, {} as Parameters<typeof driver.spawnArgv>[1]);
        expect(argv.command).toBe(process.execPath);
        expect(argv.args).toHaveLength(2);
        expect(argv.args[1]).toBe(JSON.stringify([{ op: 'accept' }]));
        expect(argv.args[0]?.endsWith('fake-turn-agent.ts')).toBe(true);
    });

    test('agent and qualify can be overridden for refusal tests', () => {
        const driver = createFakeTurnSessionDriver([], {
            agent: 'codex',
            qualify: () => ({ qualified: false, reason: 'unqualified-version' }),
        });
        expect(driver.agent).toBe('codex');
        expect(driver.qualify({ path: '/x', version: '0.0.1' })).toEqual({
            qualified: false,
            reason: 'unqualified-version',
        });
    });
});
