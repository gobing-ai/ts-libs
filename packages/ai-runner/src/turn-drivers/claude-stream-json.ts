/**
 * Claude Code stream-json turn-session driver (task 1276, design `fleet-task-turn-execution.md`
 * §5). Speaks the protocol observed on the installed 2.1.308 binary (captured 2026-10-22, fixtures
 * under `tests/fixtures/turn-drivers/claude`):
 *
 * - `claude -p --input-format stream-json --output-format stream-json --verbose` keeps ONE process
 *   alive reading user-message JSONL envelopes; each turn ends with exactly one `result` record.
 * - Startup noise (`system hook_started/hook_response` rows, every record carrying the constant
 *   `session_id`) precedes a `system init`; every later turn repeats `init → … → result`.
 * - `result.is_error` carries failure — API errors keep `subtype: 'success'` with `is_error: true`
 *   (exit 1); interrupts answer an interrupt control request with `error_during_execution`.
 *
 * Records echo no runner turn id, so `decode` stamps the facade-provided `context.turnId` on every
 * frame; the first turn's `init` may be consumed as pre-session noise, in which case acceptance is
 * inferred from the first frame of an unaccepted turn (see `TurnDecodeContext`).
 */
import type { AgentName } from '../agents/shims';
import { claudeStreamJsonFrame } from '../agents/shims';
import type {
    TurnBinary,
    TurnDecodeContext,
    TurnHandshake,
    TurnSessionDriver,
    TurnSessionPolicy,
    TurnWireEvent,
    TurnWireTerminal,
} from '../turn-session';

/** Claude Code version this driver's protocol was qualified against (probed, never fabricated). */
export const CLAUDE_TURN_VERIFIED_VERSION = '2.1.308';

/** Upper bound on startup rows scanned for a session id before the handshake gives up. */
export const HANDSHAKE_MAX_LINES = 64;

interface ClaudeRecord {
    type?: string;
    subtype?: string;
    session_id?: string;
    is_error?: boolean;
    result?: string;
}

/**
 * Build the driver. `spawn` overrides the child argv for tests (the registry instance spawns the
 * real `claude` binary); production callers use `TURN_SESSION_DRIVERS.get('claude')`.
 */
export function createClaudeTurnSessionDriver(
    options: { spawn?: { command: string; args: string[] } } = {},
): TurnSessionDriver {
    return {
        agent: 'claude' as AgentName,
        qualify: (binary: TurnBinary) =>
            binary.version === CLAUDE_TURN_VERIFIED_VERSION
                ? { qualified: true }
                : {
                      qualified: false,
                      reason: `claude ${binary.version ?? '<no version>'} is not the qualified stream-json version ${CLAUDE_TURN_VERIFIED_VERSION}`,
                  },
        spawnArgv: (_binary: TurnBinary, policy: TurnSessionPolicy) =>
            options.spawn ?? {
                command: 'claude',
                args: [
                    '-p',
                    '--input-format',
                    'stream-json',
                    '--output-format',
                    'stream-json',
                    // stream-json output refuses to start without --verbose (observed 2.1.308).
                    '--verbose',
                    ...(policy.model !== undefined ? ['--model', policy.model] : []),
                    ...(policy.role !== undefined ? ['--append-system-prompt', policy.role] : []),
                ],
            },
        handshake: async (pull: (timeoutMs: number) => Promise<string | null>): Promise<TurnHandshake> => {
            // Startup rows (hook noise, init) all carry the constant session id; the first record
            // that has one is enough. Leave everything else on the stream for the pump so the
            // first turn still sees its `init` (acceptance) if handshake stopped before it.
            for (let seen = 0; seen < HANDSHAKE_MAX_LINES; seen += 1) {
                const line = await pull(2_000);
                if (line === null) return null; // EOF or timeout before any session evidence
                let record: ClaudeRecord;
                try {
                    record = JSON.parse(line) as ClaudeRecord;
                } catch {
                    continue; // pre-protocol noise; the pump's decoder is the strict one
                }
                if (typeof record.session_id === 'string') return { nativeSessionId: record.session_id };
            }
            return null;
        },
        encodeTurn: (input: { turnId: string; prompt: string; correlation: { runId: string } }) =>
            claudeStreamJsonFrame(input.prompt),
        decode: (line: string, context?: TurnDecodeContext): TurnWireEvent[] => {
            let record: ClaudeRecord;
            try {
                record = JSON.parse(line) as ClaudeRecord;
            } catch {
                // Plain Error, not TurnProtocolError: importing the class would make this module
                // a runtime dependency of turn-session.ts (which registers this driver). The pump
                // settles contract-violation for ANY decoder throw, which is the real contract.
                const error = new Error(`claude stream-json: malformed JSON line: ${line.slice(0, 80)}`);
                error.name = 'TurnProtocolError';
                throw error;
            }
            const turnId = context?.turnId ?? null;
            const events: TurnWireEvent[] = [];
            if (record.type === 'system' && record.subtype === 'init' && context !== undefined && !context.accepted) {
                events.push({ turnId, type: 'accepted' });
            }
            if (record.type === 'assistant') {
                // A turn whose boundary init was consumed still accepts on its first output. (The
                // init branch above is the only accepted source, and it never fires for this record.)
                if (context !== undefined && !context.accepted) {
                    events.push({ turnId, type: 'accepted' });
                }
                events.push({ turnId, type: 'output', data: record });
                return events;
            }
            if (record.type === 'result') {
                const terminal: TurnWireTerminal = {
                    kind: record.is_error === true ? 'failure' : 'success',
                    ...(typeof record.session_id === 'string' ? { nativeSessionId: record.session_id } : {}),
                    ...(typeof record.result === 'string' ? { finalText: record.result } : {}),
                    ...(record.is_error === true
                        ? { reason: `claude result subtype '${record.subtype ?? 'unknown'}' reported an error` }
                        : {}),
                };
                events.push({ turnId, type: 'terminal', terminal });
                return events;
            }
            return events; // system/rate_limit_event/control_response/unknown — tolerated noise
        },
        encodeCancel: (reason: string) =>
            // Interrupt control request (observed 2.1.308): acknowledged with a `control_response`,
            // then the interrupted turn settles with a `result error_during_execution` record.
            `${JSON.stringify({ type: 'control_request', request_id: `cancel-${reason}`, request: { subtype: 'interrupt' } })}\n`,
    };
}
