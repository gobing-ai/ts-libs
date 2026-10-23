/**
 * Fixture-replay child for claude driver tests (task 1276). A REAL child process that replays a
 * captured claude stream-json transcript (`argv[2]`, absolute path) across the process boundary:
 * the k-th user frame on stdin emits the k-th turn group of the fixture, one JSONL line at a time.
 * Test-only — never imported by library code.
 *
 * - `argv[3]`: process exit code (default 0) — used when the fixture has no turn groups.
 * - `argv[4]`: `linger` — after the last group, stay alive until stdin closes (the interrupt test
 *   needs the process alive while the parent cancels mid-turn).
 *
 * Emission is asynchronous on purpose: Bun buffers synchronous `process.stdout.write` calls that
 * follow a top-level `readFileSync` when stdout is a pipe (observed bun 1.4.3) — the prelude must
 * leave the same tick or the parent's handshake sees nothing. Groups are delimited by
 * `system init` records; rows before the first `init` are startup noise emitted once at startup.
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

function isRecord(line: string, type: string, subtype?: string): boolean {
    try {
        const record = JSON.parse(line) as { type?: string; subtype?: string };
        return record.type === type && (subtype === undefined || record.subtype === subtype);
    } catch {
        return false;
    }
}

// Startup noise = every row before the FIRST `init` (hook records, may span any number of rows);
// emitted at startup so the handshake has session evidence before any turn starts. Turn groups
// then begin at each `init`.
const firstInit = allLines.findIndex((line) => isRecord(line, 'system', 'init'));
const prelude: string[] = firstInit === -1 ? [] : allLines.slice(0, firstInit);
const turns: string[][] = [];
let current: string[] = [];
for (const line of firstInit === -1 ? [] : allLines.slice(firstInit)) {
    if (isRecord(line, 'system', 'init') && current.length > 0) {
        turns.push(current);
        current = [];
    }
    current.push(line);
}
if (current.length > 0) turns.push(current);

function send(lines: string[]): void {
    for (const line of lines) process.stdout.write(`${line}\n`);
}

let servedTurns = 0;
/** Exit once every group is served — except in linger mode (cancel must beat the fixture's end). */
function maybeFinish(): void {
    if (linger || servedTurns < turns.length) return;
    setTimeout(() => process.exit(exitCode), 150);
}

if (turns.length === 0) {
    // Empty capture (child killed before any record): emit a synthetic init so the parent's
    // handshake can complete, then die with the recorded exit code (mid-startup kill).
    setTimeout(() => {
        send(['{"type":"system","subtype":"init","session_id":"replay-dead","cwd":"/tmp/spur-claude-fixture"}']);
        setTimeout(() => process.exit(exitCode), 100);
    }, 10);
} else {
    // Captures that start mid-session (e.g. the interrupt fixture opens with a control_response
    // ack) have no startup session evidence — prepend a synthetic init, mirroring the real
    // binary whose startup init predates the capture window.
    const hasSessionEvidence = prelude.some((line) => {
        try {
            return typeof (JSON.parse(line) as { session_id?: string }).session_id === 'string';
        } catch {
            return false;
        }
    });
    setTimeout(() => {
        send(
            hasSessionEvidence
                ? prelude
                : [
                      '{"type":"system","subtype":"init","session_id":"replay-startup","cwd":"/tmp/spur-claude-fixture"}',
                      ...prelude,
                  ],
        );
    }, 10);
}

// One sequential pump: every served group's lines join a shared queue written one per tick, so a
// new user frame arriving while a group is still pacing never overlaps intervals (turn N's outcome
// settles on its `result` row before the group's last noise row is written — the next frame must
// queue, not race).
const queue: string[] = [];
const pump = setInterval(() => {
    const line = queue.shift();
    if (line !== undefined) {
        process.stdout.write(`${line}\n`);
        return;
    }
    if (servedTurns >= turns.length && turns.length > 0) {
        clearInterval(pump);
        maybeFinish();
    }
}, 60);

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
    if (!isRecord(line, 'user')) return;
    const group = turns[servedTurns];
    if (group === undefined) return;
    servedTurns += 1;
    queue.push(...group);
});
rl.on('close', () => {
    process.exit(exitCode);
});
