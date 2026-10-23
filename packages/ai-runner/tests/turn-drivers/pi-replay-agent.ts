/**
 * Fixture-replay child for pi driver tests (task 1277). A REAL child process that replays a
 * captured pi rpc transcript (`argv[2]`, absolute path) across the process boundary: the k-th
 * prompt command on stdin emits the k-th turn group of the fixture, one JSONL line at a time.
 * Test-only — never imported by library code.
 *
 * - `argv[3]`: process exit code (default 0) — used when the fixture has no turn groups.
 * - `argv[4]`: `linger` — after the last group, stay alive until stdin closes (the cancel test
 *   needs the process alive while the parent aborts mid-turn).
 *
 * Emission is asynchronous on purpose (see claude's replay-agent.ts): Bun buffers synchronous
 * `process.stdout.write` calls that follow a top-level `readFileSync` when stdout is a pipe.
 * Groups are delimited by `prompt` command `response` records (the acceptance echo); rows before
 * the first response are startup noise (extension_ui_request) emitted once at startup; a capture
 * with no response rows at all is emitted wholesale. The replay rewrites the echo id on the
 * fixture's prompt `response` rows to the id of the incoming command (test-harness substitution,
 * like claude's synthetic init — the captured shape is verbatim, the id is per-session).
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const fixturePath = process.argv[2];
const exitCode = Number(process.argv[3] ?? '0');
const linger = process.argv[4] === 'linger';
const allLines =
    fixturePath === undefined
        ? []
        : readFileSync(fixturePath, 'utf8')
              .split('\n')
              .filter((line) => line.trim() !== '');

function isPromptResponse(line: string): boolean {
    try {
        const record = JSON.parse(line) as { type?: string; command?: string };
        return record.type === 'response' && record.command === 'prompt';
    } catch {
        return false;
    }
}

const firstResponse = allLines.findIndex((line) => isPromptResponse(line));
const prelude: string[] = firstResponse === -1 ? allLines : allLines.slice(0, firstResponse);
const turns: string[][] = [];
let current: string[] = [];
for (const line of firstResponse === -1 ? [] : allLines.slice(firstResponse)) {
    if (isPromptResponse(line) && current.length > 0) {
        turns.push(current);
        current = [];
    }
    current.push(line);
}
if (current.length > 0) turns.push(current);

function send(lines: string[]): void {
    for (const line of lines) process.stdout.write(`${line}\n`);
}

/** Substitutes the captured echo id with the live turn id on prompt response rows. */
function reId(line: string, turnId: string): string {
    if (!isPromptResponse(line)) return line;
    try {
        const record = JSON.parse(line) as Record<string, unknown>;
        record.id = turnId;
        return JSON.stringify(record);
    } catch {
        return line;
    }
}

let servedTurns = 0;
/** Exit once every group is served — except in linger mode (cancel must beat the fixture's end). */
function maybeFinish(): void {
    if (linger) return;
    if (servedTurns >= turns.length) setTimeout(() => process.exit(exitCode), 150); // let stdout flush
}

if (turns.length === 0) {
    // Empty capture (child killed before any record): emit one synthetic startup-noise row so the
    // parent's handshake can complete, then die with the recorded exit code (mid-startup kill).
    setTimeout(() => {
        send(['{"type":"extension_ui_request","id":"replay-dead","method":"setStatus","statusKey":"replay"}']);
        setTimeout(() => process.exit(exitCode), 100);
    }, 10);
} else {
    send(prelude);
    void (async () => {
        const input = createInterface({ input: process.stdin });
        input.on('line', (raw) => {
            let parsed: { id?: string } = {};
            try {
                parsed = JSON.parse(raw) as { id?: string };
            } catch {
                parsed = {};
            }
            const group = turns[servedTurns];
            servedTurns += 1;
            if (group === undefined) return;
            // Asynchronous emission so the parent's reader has attached (mirrors the real binary).
            setTimeout(() => {
                send(group.map((line) => reId(line, parsed.id ?? 'replay')));
                maybeFinish();
            }, 10);
        });
        input.on('close', () => process.exit(exitCode));
    })();
}
