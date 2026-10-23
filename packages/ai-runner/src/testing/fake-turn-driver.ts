/**
 * Fake turn-session driver for tests (task 1284). Spawns a REAL child process
 * (`fake-turn-agent.ts`) that replays a scripted JSONL protocol across the process boundary,
 * so sessions are exercised end-to-end — never against an in-process stub of the transport.
 * Exported from the `./testing` subpath only; never imported by library code.
 */
import type { TurnBinary, TurnHandshake, TurnSessionDriver, TurnSessionPolicy, TurnWireEvent } from '../turn-session';
import { TurnProtocolError } from '../turn-session';

/** One scripted child action (see `fake-turn-agent.ts` for the wire semantics). */
export interface FakeTurnAction {
    op: 'ready' | 'accept' | 'output' | 'terminal' | 'stray' | 'sleep' | 'ignore-cancel' | 'flood' | 'exit';
    nativeSessionId?: string;
    data?: string;
    kind?: 'success' | 'failure' | 'not-started';
    nativeTurnId?: string;
    finalText?: string;
    line?: Record<string, unknown>;
    ms?: number;
    code?: number;
}

/** Path of the child script: source tree in dev/checkouts, compiled sibling in built packages. */
function fakeTurnAgentPath(): string {
    // No node:path/node:fs (runtime-boundaries rule): import.meta.dir is already absolute, so a
    // separator-safe marker check picks the compiled sibling in built packages.
    const isBuilt = import.meta.dir.replace(/\\/g, '/').includes('/dist/');
    return `${import.meta.dir}/fake-turn-agent.${isBuilt ? 'js' : 'ts'}`;
}

interface FakeFrame {
    ctl?: string;
    turn?: string | null;
    type?: string;
    data?: unknown;
    kind?: string;
    nativeTurnId?: string;
    nativeSessionId?: string;
    finalText?: string;
    reason?: string;
}

/** Build a turn-session driver over the scripted child. `overrides` tailors qualify/agent for refusal tests. */
export function createFakeTurnSessionDriver(
    actions: FakeTurnAction[],
    overrides: Partial<Pick<TurnSessionDriver, 'qualify' | 'agent'>> = {},
): TurnSessionDriver {
    const scriptJson = JSON.stringify(actions);
    const driver: TurnSessionDriver = {
        agent: overrides.agent ?? 'pi',
        qualify: overrides.qualify ?? (() => ({ qualified: true })),
        spawnArgv: (_binary: TurnBinary, _policy: TurnSessionPolicy) => ({
            command: process.execPath,
            args: [fakeTurnAgentPath(), scriptJson],
        }),
        handshake: async (pull: (timeoutMs: number) => Promise<string | null>): Promise<TurnHandshake> => {
            const raw = await pull(2_000);
            if (raw === null) return null; // EOF or timeout before ready
            const frame = JSON.parse(raw) as FakeFrame;
            if (frame.ctl !== 'ready') return null;
            return frame.nativeSessionId !== undefined ? { nativeSessionId: frame.nativeSessionId } : null;
        },
        encodeTurn: (input) => `${JSON.stringify({ type: 'turn', ...input })}\n`,
        decode: (line: string): TurnWireEvent[] => {
            let frame: FakeFrame & { ctl?: string };
            try {
                frame = JSON.parse(line) as FakeFrame & { ctl?: string };
            } catch {
                throw new TurnProtocolError(`malformed frame: ${line.slice(0, 80)}`);
            }
            if (frame.ctl !== undefined) return []; // control frames (ready) are handshake-only
            if (frame.type !== 'accepted' && frame.type !== 'output' && frame.type !== 'terminal') {
                throw new TurnProtocolError(`unknown frame type: ${String(frame.type)}`);
            }
            return [
                {
                    turnId: frame.turn ?? null,
                    type: frame.type,
                    ...(frame.data !== undefined ? { data: frame.data } : {}),
                    ...(frame.type === 'terminal'
                        ? {
                              terminal: {
                                  kind:
                                      frame.kind === 'failure'
                                          ? 'failure'
                                          : frame.kind === 'not-started'
                                            ? 'not-started'
                                            : 'success',
                                  ...(frame.nativeTurnId !== undefined ? { nativeTurnId: frame.nativeTurnId } : {}),
                                  ...(frame.nativeSessionId !== undefined
                                      ? { nativeSessionId: frame.nativeSessionId }
                                      : {}),
                                  ...(frame.finalText !== undefined ? { finalText: frame.finalText } : {}),
                                  ...(frame.reason !== undefined ? { reason: frame.reason } : {}),
                              },
                          }
                        : {}),
                },
            ];
        },
        encodeCancel: (reason: string) => `${JSON.stringify({ type: 'cancel', reason })}\n`,
    };
    return driver;
}
