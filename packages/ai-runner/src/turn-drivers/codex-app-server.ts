/**
 * Codex App Server turn-session driver (task 1278, design `fleet-task-turn-execution.md` §5).
 * Speaks the protocol generated from `codex app-server generate-ts` and captured live on
 * `codex-cli` 0.164.0 (2026-10-24; fixtures under `tests/fixtures/turn-drivers/codex`):
 *
 * - `codex app-server` is a JSONL control channel. The client bootstraps with
 *   `initialize` (`clientInfo`+`capabilities`) and an `initialized` notification, then opens a
 *   native thread (`thread/start`, or `thread/resume` for an existing thread id) and starts turns
 *   with `turn/start { threadId, input: [{ type: 'text', text, text_elements }] }`.
 * - Every notification echoes `params.threadId` and `params.turnId`, so frames are
 *   self-attributing; the driver still validates against the facade's active turn because the
 *   session admits one turn at a time and a late frame must not be read as the next turn's.
 * - `turn/start` responds with the native turn (`status: 'inProgress'`) — that response is
 *   ACCEPTANCE, never completion. The only turn terminal is `turn/completed`, whose
 *   `params.turn.status` is `completed | failed | interrupted` (`inProgress` never terminates).
 * - Failed turns carry `turn.error.message`; interrupted ones carry `error: null`, so an
 *   interruption is observable only through the status (the facade maps a caller-requested cancel
 *   to `interrupted`).
 * - Codex-generated ids are UUIDv7 thread/turn ids; both are surfaced so a consumer can link
 *   receipts to native turns.
 *
 * `codex` also ships `exec`/`exec resume` one-shot paths (capability row); this driver is the
 * warm session only.
 */
import type { AgentName } from '../agents/shims';
import type {
    TurnBinary,
    TurnDecodeContext,
    TurnHandshake,
    TurnSessionDriver,
    TurnSessionPolicy,
    TurnWireEvent,
    TurnWireScope,
    TurnWireTerminal,
} from '../turn-session';

/**
 * Codex version this driver's protocol was qualified against — probed live on 2026-10-24
 * (`codex-cli 0.164.0`, the binary the generated bindings came from).
 */
export const CODEX_TURN_VERIFIED_VERSION = '0.164.0';

/** Client identity declared in `initialize`; the server echoes it in its `initialize` result. */
const CLIENT_INFO = { name: 'spur-turn-session', title: 'Spur turn session', version: '0.7.0' } as const;

/** JSON-RPC id of the `initialize` request (the only id the driver does not derive from a turn). */
const INITIALIZE_ID = '__spur_initialize';
/** JSON-RPC id of the thread bootstrap request. */
const THREAD_ID = '__spur_thread';

interface CodexFrame {
    id?: string | number;
    method?: string;
    params?: {
        threadId?: string;
        turnId?: string;
        turn?: CodexTurn;
        item?: { type?: string; text?: string; phase?: string };
        error?: { message?: string };
    };
    result?: {
        thread?: { id?: string };
        turn?: CodexTurn;
    };
    error?: { message?: string; code?: number };
}

interface CodexTurn {
    id?: string;
    status?: string;
    error?: { message?: string } | null;
    items?: { type?: string; text?: string; phase?: string }[];
}

/** Final answer text of a turn: the `final_answer` agent message, else the last agent message. */
function finalTextOf(turn: CodexTurn): string | undefined {
    const messages = (turn.items ?? []).filter((item) => item.type === 'agentMessage' && typeof item.text === 'string');
    const final = messages.find((item) => item.phase === 'final_answer') ?? messages.at(-1);
    return final?.text;
}

/**
 * Build the driver. `spawn` overrides the child argv for tests (the registry instance spawns the
 * real `codex` binary); production callers use `TURN_SESSION_DRIVERS.get('codex')`.
 */
export function createCodexTurnSessionDriver(
    options: { spawn?: { command: string; args: string[] } } = {},
): TurnSessionDriver {
    const write = (frame: unknown): string => `${JSON.stringify(frame)}\n`;
    return {
        agent: 'codex' as AgentName,
        qualify: (binary: TurnBinary) =>
            binary.version === CODEX_TURN_VERIFIED_VERSION
                ? { qualified: true }
                : {
                      qualified: false,
                      reason: `codex ${binary.version ?? '<no version>'} is not the qualified app-server version ${CODEX_TURN_VERIFIED_VERSION}`,
                  },
        spawnArgv: (_binary: TurnBinary, policy: TurnSessionPolicy) =>
            options.spawn ?? {
                command: 'codex',
                args: [
                    'app-server',
                    // Thread model overrides are TOML config in 0.164.0 (`-c model="…"`); turn/start
                    // carries no model field, so the session policy has to reach the thread here.
                    ...(policy.model !== undefined ? ['-c', `model=${JSON.stringify(policy.model)}`] : []),
                ],
            },
        handshake: async (
            pull: (timeoutMs: number) => Promise<string | null>,
            send: (line: string) => void,
        ): Promise<TurnHandshake> => {
            send(
                write({
                    id: INITIALIZE_ID,
                    method: 'initialize',
                    params: { clientInfo: CLIENT_INFO, capabilities: null },
                }),
            );
            let initialized = false;
            let threadId: string | undefined;
            // Startup emits unrelated notifications (mcp/startup status, hooks, warnings) — read
            // until both of OUR responses arrive; anything else is bootstrap noise.
            for (let seen = 0; seen < 200 && (!initialized || threadId === undefined); seen += 1) {
                const line = await pull(5_000);
                if (line === null) throw new Error('codex app-server closed during the handshake');
                let frame: CodexFrame;
                try {
                    frame = JSON.parse(line) as CodexFrame;
                } catch {
                    continue;
                }
                if (frame.id === INITIALIZE_ID) {
                    if (frame.error !== undefined) {
                        throw new Error(`codex initialize failed: ${frame.error.message ?? 'unspecified error'}`);
                    }
                    // `initialized` is a notification: the server starts serving after it, and
                    // thread/start before it is rejected on some builds.
                    send(write({ method: 'initialized' }));
                    send(write({ id: THREAD_ID, method: 'thread/start', params: {} }));
                    initialized = true;
                    continue;
                }
                if (frame.id === THREAD_ID) {
                    if (frame.error !== undefined) {
                        throw new Error(`codex thread/start failed: ${frame.error.message ?? 'unspecified error'}`);
                    }
                    threadId = frame.result?.thread?.id;
                }
            }
            if (threadId === undefined || threadId === '') {
                throw new Error('codex app-server did not report a native thread id');
            }
            return { nativeSessionId: threadId };
        },
        encodeTurn: (input: { turnId: string; prompt: string; scope?: TurnWireScope }) => {
            const threadId = input.scope?.nativeSessionId;
            if (threadId === undefined) {
                // Facade settles `not-started`: a turn cannot be addressed without the session id.
                throw new Error('codex turn/start requires the handshake thread id');
            }
            return write({
                id: input.turnId,
                method: 'turn/start',
                params: {
                    threadId,
                    input: [{ type: 'text', text: input.prompt, text_elements: [] }],
                },
            });
        },
        decode: (line: string, context?: TurnDecodeContext): TurnWireEvent[] => {
            let frame: CodexFrame;
            try {
                frame = JSON.parse(line) as CodexFrame;
            } catch {
                // Plain Error with the protocol name: importing TurnProtocolError would make this
                // module a runtime dependency of turn-session.ts (which registers it).
                const error = new Error(`codex app-server: malformed JSON line: ${line.slice(0, 80)}`);
                error.name = 'TurnProtocolError';
                throw error;
            }
            if (context === undefined) return [];
            // Our own request ids are the runner turn id, so a response addresses its turn directly.
            if (frame.id === context.turnId) {
                if (frame.error !== undefined) {
                    return [
                        {
                            turnId: context.turnId,
                            type: 'terminal',
                            terminal: {
                                // Rejected before any turn ran = never started (uniform rule).
                                kind: context.accepted ? 'failure' : 'not-started',
                                reason: `codex rejected turn/start: ${frame.error.message ?? 'unspecified error'}`,
                            },
                        },
                    ];
                }
                const nativeTurnId = frame.result?.turn?.id;
                if (!context.accepted) {
                    return [
                        {
                            turnId: context.turnId,
                            type: 'accepted',
                            ...(nativeTurnId !== undefined ? { nativeTurnId } : {}),
                        },
                    ];
                }
                return [];
            }
            // The session admits one turn at a time, so any `turn/completed` belongs to the
            // active turn; the NATIVE ids on it are what the outcome reports.
            if (frame.params?.turn !== undefined && frame.method === 'turn/completed') {
                const turn = frame.params.turn;
                const terminal: TurnWireTerminal = {
                    // `interrupted` is a native interruption the caller did not request; the facade
                    // upgrades a caller-requested cancel to `interrupted` itself.
                    kind: turn.status === 'completed' ? 'success' : 'failure',
                    ...(turn.id !== undefined ? { nativeTurnId: turn.id } : {}),
                    ...(frame.params.threadId !== undefined ? { nativeSessionId: frame.params.threadId } : {}),
                };
                if (turn.status === 'interrupted') terminal.reason = 'codex turn status interrupted';
                else if (turn.status === 'failed')
                    terminal.reason = `codex turn failed: ${turn.error?.message ?? 'unspecified error'}`;
                else if (turn.status !== 'completed')
                    return [{ turnId: context.turnId, type: 'diagnostic', data: frame }];
                const text = finalTextOf(turn);
                if (text !== undefined) terminal.finalText = text;
                return [{ turnId: context.turnId, type: 'terminal', terminal }];
            }
            if (frame.method === 'error' && frame.params?.error !== undefined) {
                // Server-level error notification: surfaced as output so the consumer's artifact
                // validation sees it; the turn terminal still comes from turn/completed.
                return [{ turnId: context.turnId, type: 'diagnostic', data: frame }];
            }
            return [];
        },
        encodeCancel: (_reason: string, scope?: TurnWireScope) =>
            write({
                id: '__spur_interrupt',
                method: 'turn/interrupt',
                params: { threadId: scope?.nativeSessionId, turnId: scope?.nativeTurnId },
            }),
    };
}
