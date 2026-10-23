/**
 * Scripted fake turn agent for turn-session tests (task 1284). A REAL child process: it speaks a
 * JSONL protocol over stdin/stdout, replaying a script passed as `argv[2]` (JSON array). Only for
 * tests via `./testing` — never imported by library code.
 *
 * Protocol (parent → child):
 *   {"type":"turn","turnId":...,"prompt":...,"correlation":{...}}   start replaying the script
 *   {"type":"cancel","reason":...}                                  flush pending sleeps (unless ignored)
 * Protocol (child → parent):
 *   {"ctl":"ready","nativeSessionId":...}                           handshake (auto-emitted at startup)
 *   {"turn":T,"type":"accepted"} | {"turn":T,"type":"output","data":...}
 *   {"turn":T,"type":"terminal","kind":"success"|"failure"|"not-started",...}
 *   {"ctl":"exit"} echoes are the raw scripted `stray` lines.
 */
import { createInterface } from 'node:readline';

interface FakeAction {
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

const script: FakeAction[] = JSON.parse(process.argv[2] ?? '[]');
const readyAction = script.find((action) => action.op === 'ready');
const turnActions = script.filter((action) => action.op !== 'ready');
/** Skip the startup ready frame when the script dies immediately (broken-agent handshake test). */
const startsWithExit = script[0]?.op === 'exit';

let currentTurnId: string | null = null;
let ignoreCancel = false;
let flushing = false;
/** Pending sleep timers mapped to their resolvers so a cancel can wake them (not just clear them). */
const sleepers = new Map<NodeJS.Timeout, () => void>();

function send(line: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify(line)}\n`);
}

// Parent may drop stdout (kill/close) while frames are in flight — exit instead of crashing on EPIPE.
process.stdout.on('error', () => process.exit(0));

// Handshake: explicit ready action first (nativeSessionId control), else the default.
if (readyAction !== undefined) {
    send({
        ctl: 'ready',
        ...(readyAction.nativeSessionId !== undefined ? { nativeSessionId: readyAction.nativeSessionId } : {}),
    });
} else if (!startsWithExit) {
    send({ ctl: 'ready', nativeSessionId: 'fake-session-1' });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            sleepers.delete(timer);
            resolve();
        }, ms);
        sleepers.set(timer, resolve);
        if (flushing) {
            clearTimeout(timer);
            sleepers.delete(timer);
            resolve();
        }
    });
}

async function replay(): Promise<void> {
    for (const action of turnActions) {
        if (action.op === 'accept') send({ turn: currentTurnId, type: 'accepted' });
        else if (action.op === 'output') send({ turn: currentTurnId, type: 'output', data: action.data ?? '' });
        else if (action.op === 'terminal')
            send({
                turn: currentTurnId,
                type: 'terminal',
                kind: action.kind ?? 'success',
                ...(action.nativeTurnId !== undefined ? { nativeTurnId: action.nativeTurnId } : {}),
                ...(action.finalText !== undefined ? { finalText: action.finalText } : {}),
            });
        else if (action.op === 'stray' && action.line !== undefined) send(action.line);
        else if (action.op === 'flood')
            // Written by the child so the >1MiB line never passes through argv (macOS E2BIG limit).
            send({ turn: currentTurnId, type: 'output', data: 'x'.repeat(1024 * 1024 + 64) });
        else if (action.op === 'sleep') await sleep(action.ms ?? 0);
        else if (action.op === 'ignore-cancel') ignoreCancel = true;
        else if (action.op === 'exit') process.exit(action.code ?? 0);
    }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (raw) => {
    let frame: Record<string, unknown>;
    try {
        frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return;
    }
    if (frame.type === 'turn' && typeof frame.turnId === 'string') {
        currentTurnId = frame.turnId;
        flushing = false;
        void replay();
    } else if (frame.type === 'cancel') {
        if (ignoreCancel) return;
        // Answering cancel: wake pending sleeps so the scripted terminal arrives promptly.
        flushing = true;
        for (const [timer, resolve] of sleepers) {
            clearTimeout(timer);
            resolve();
        }
        sleepers.clear();
    }
});
rl.on('close', () => {
    process.exit(0);
});
// Scripts that lead with `exit` run at startup (direct child drives and handshake tests);
// turn-dependent actions replay with a null turnId in that mode.
if (startsWithExit) void replay();
