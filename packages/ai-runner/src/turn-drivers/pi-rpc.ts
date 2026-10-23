/**
 * Pi RPC turn-session driver (task 1277, design `fleet-task-turn-execution.md` §5). Speaks the
 * protocol observed on the repository dependency `pi` 0.87.1 binary (captured 2026-10-23 via live
 * single-turn, two-turn and mid-run-abort probes; fixtures under `tests/fixtures/turn-drivers/pi`):
 *
 * - `pi --mode rpc --no-session` keeps ONE process alive; commands are JSONL on stdin and every
 *   command may carry an `id` that its `response` echoes. The driver uses the runner turn id as
 *   the prompt command id, so acceptance is self-attributing (unlike claude stream-json).
 * - A prompt `response` (success) means ACCEPTANCE, never completion: `agent_end` can be followed
 *   by retries/compaction; the turn terminal is `agent_settled`.
 * - Startup and inter-turn noise is `extension_ui_request` rows (powerline/status extensions) and
 *   can interleave anywhere; tolerated and ignored.
 * - Failure signals are response-level: a `success: false` prompt response, a `parse` response
 *   (our command record did not parse), or `agent_settled` with `aborted: true` (observed on the
 *   1.4.0 PATH binary; 0.87.1 settles aborts without the field — the facade's cancel-requested
 *   path classifies those as `interrupted`, and mid-run provider failures settle success-shaped
 *   with the error visible in the event stream, where the consumer's artifact validation acts).
 * - Version differences observed between the qualified 0.87.1 and the PATH 1.4.0 binary: 1.4.0
 *   adds `data.disposition` on the prompt response and `aborted` on `agent_settled`. The decoder
 *   tolerates both shapes; qualification pins 0.87.1 (the binary the Spur warm seam spawns).
 *
 * Protocol records echo no payload turn id beyond the command id, so `decode` attributes frames
 * by `record.id` when present and falls back to the facade-provided active turn for session-level
 * records (`agent_settled` carries no id).
 */
import type { AgentName } from '../agents/shims';
import type {
    TurnBinary,
    TurnDecodeContext,
    TurnHandshake,
    TurnSessionDriver,
    TurnSessionPolicy,
    TurnWireEvent,
    TurnWireTerminal,
} from '../turn-session';

/**
 * Pi version this driver's protocol was qualified against: the repository dependency probed live
 * on 2026-10-23 (PATH binary 1.4.0 speaks the same protocol family but is NOT the spawn target —
 * exact provenance recorded here and in the fixtures README).
 */
export const PI_TURN_VERIFIED_VERSION = '0.87.1';

interface PiRecord {
    type?: string;
    id?: string;
    command?: string;
    success?: boolean;
    error?: string;
    aborted?: boolean;
    data?: { disposition?: string };
    message?: { role?: string };
}

/**
 * Build the driver. `spawn` overrides the child argv for tests (the registry instance spawns the
 * real `pi` binary); production callers use `TURN_SESSION_DRIVERS.get('pi')`.
 */
export function createPiTurnSessionDriver(
    options: { spawn?: { command: string; args: string[] } } = {},
): TurnSessionDriver {
    return {
        agent: 'pi' as AgentName,
        qualify: (binary: TurnBinary) =>
            binary.version === PI_TURN_VERIFIED_VERSION
                ? { qualified: true }
                : {
                      qualified: false,
                      reason: `pi ${binary.version ?? '<no version>'} is not the qualified rpc version ${PI_TURN_VERIFIED_VERSION}`,
                  },
        spawnArgv: (_binary: TurnBinary, policy: TurnSessionPolicy) =>
            options.spawn ?? {
                command: 'pi',
                args: [
                    '--mode',
                    'rpc',
                    '--no-session',
                    ...(policy.model !== undefined ? ['--model', policy.model] : []),
                ],
            },
        // No handshake: pi has no startup session record — the prompt command id carries the
        // correlation, and early stdin writes are processed after extension startup (observed:
        // a command written during startup noise is answered in order).
        encodeTurn: (input: { turnId: string; prompt: string }) =>
            // The id echoes on the acceptance response — self-attributing protocol (R3).
            `${JSON.stringify({ id: input.turnId, type: 'prompt', message: input.prompt })}\n`,
        decode: (line: string, context?: TurnDecodeContext): TurnWireEvent[] => {
            let record: PiRecord;
            try {
                record = JSON.parse(line) as PiRecord;
            } catch {
                // Plain Error, not TurnProtocolError: importing the class would make this module
                // a runtime dependency of turn-session.ts (which registers this driver). The pump
                // settles contract-violation for ANY decoder throw, which is the real contract.
                const error = new Error(`pi rpc: malformed JSON line: ${line.slice(0, 80)}`);
                error.name = 'TurnProtocolError';
                throw error;
            }
            // Acceptance/failure for the turn whose prompt command this response answers.
            if (record.type === 'response' && record.command === 'prompt') {
                if (context === undefined || record.id !== context.turnId) return [];
                // Acceptance echoes once per prompt command; an already-accepted turn gets no
                // duplicate frame (pump contract, same as claude's repeated init).
                if (context.accepted && record.success === true) return [];
                if (record.success !== true) {
                    return [
                        {
                            turnId: context.turnId,
                            type: 'terminal',
                            terminal: {
                                kind: 'failure',
                                reason: `pi rejected the prompt command: ${record.error ?? 'unspecified error'}`,
                            },
                        },
                    ];
                }
                // 1.4.0 reports `data.disposition`; "handled" means no run started for this prompt.
                const disposition = record.data?.disposition;
                if (disposition !== undefined && disposition !== 'started') {
                    return [
                        {
                            turnId: context.turnId,
                            type: 'terminal',
                            terminal: {
                                kind: 'failure',
                                reason: `pi prompt disposition '${disposition}' did not start a run`,
                            },
                        },
                    ];
                }
                return [{ turnId: context.turnId, type: 'accepted' }];
            }
            // A parse response means one of OUR command records did not parse — framing broke.
            if (record.type === 'response' && record.command === 'parse' && context !== undefined) {
                return [
                    {
                        turnId: context.turnId,
                        type: 'terminal',
                        terminal: {
                            kind: 'failure',
                            reason: `pi failed to parse a command record: ${record.error ?? 'unspecified error'}`,
                        },
                    },
                ];
            }
            // The terminal: agent_settled is the only completion evidence (agent_end can precede
            // retries). Session-level record — attributed to the active turn via context.
            if (record.type === 'agent_settled') {
                if (context === undefined) return [];
                const terminal: TurnWireTerminal = { kind: 'success' };
                if (record.aborted === true) {
                    terminal.kind = 'failure';
                    terminal.reason = 'pi agent settled with aborted: true';
                }
                return [{ turnId: context.turnId, type: 'terminal', terminal }];
            }
            // Assistant final message → output (the consumer extracts final text/artifacts from
            // the event stream; `agent_settled` carries no text payload).
            if (record.type === 'message_end' && record.message?.role === 'assistant' && context !== undefined) {
                return [{ turnId: context.turnId, type: 'output', data: record }];
            }
            // extension_ui_request / agent_start / turn_start|end / message_update|start /
            // session_info_changed / tool_execution_* / auto_retry_* / abort response — noise.
            return [];
        },
        encodeCancel: (_reason: string) =>
            // Abort command (pi docs rpc-commands.md; observed 0.87.1: the active tool call ends
            // with "Command aborted", the run settles, then the abort response arrives).
            `${JSON.stringify({ type: 'abort' })}\n`,
        handshake: async (pull: (timeoutMs: number) => Promise<string | null>): Promise<TurnHandshake> => {
            // Readiness probe: drain up to the first parseable record so the extension startup
            // has begun before the first turn is written. Any parseable protocol record proves
            // the process is alive and speaking JSONL; startup noise is not otherwise needed.
            for (let seen = 0; seen < 32; seen += 1) {
                const line = await pull(2_000);
                if (line === null) return null; // EOF before the process spoke
                try {
                    JSON.parse(line) as PiRecord;
                    return {};
                } catch {}
            }
            return null;
        },
    };
}
