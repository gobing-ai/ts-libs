/**
 * Fixture-replay child for the codex app-server driver tests (task 1278). A REAL child process
 * that speaks the captured app-server JSONL dialect across the process boundary (`argv[2]` is the
 * absolute fixture path):
 *
 * - bootstrap rows (initialize/thread responses + `thread/started` + warnings) are served when the
 *   matching request arrives, echoing the PARENT's request id (the driver's ids differ from the
 *   captured ones);
 * - the k-th `turn/start` serves the k-th capture segment; for an interrupt capture the segment is
 *   split at its interrupt response (`{id, result: {}}`) so the rest only arrives on
 *   `turn/interrupt` — that is what makes the cancel path a real one;
 * - native thread/turn ids are replayed verbatim: they are the evidence under test.
 *
 * Test-only — never imported by library code.
 */
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

type Row = Record<string, unknown> & { id?: string | number; method?: string; result?: unknown };

const fixturePath = process.argv[2];
const rows: Row[] = (fixturePath === undefined ? '' : readFileSync(fixturePath, 'utf8'))
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row);

const emit = (row: Row): void => {
    process.stdout.write(`${JSON.stringify(row)}\n`);
};

const turnStatus = (row: Row): string | undefined =>
    (
        (row.result as { turn?: { status?: string } } | undefined)?.turn ??
        (row.params as { turn?: { status?: string } } | undefined)?.turn
    )?.status;

/** A turn-start response carries a `result.turn`; the thread response (id 2) shares the shape. */
const isTurnStart = (row: Row): boolean => row.method === undefined && turnStatus(row) === 'inProgress' && row.id !== 2;
/** The interrupt response is the only id-carrying row with an empty result. */
const isInterruptResponse = (row: Row): boolean =>
    row.method === undefined && row.result !== undefined && Object.keys(row.result as object).length === 0;

const firstTurn = rows.findIndex(isTurnStart);
const bootstrap = rows.slice(0, firstTurn);
const segments: Row[][] = [];
for (const row of rows.slice(firstTurn)) {
    if (isTurnStart(row)) segments.push([row]);
    else segments.at(-1)?.push(row);
}

let turnIndex = 0;
let pending: Row[] = [];

const serve = (frame: Row): void => {
    if (frame.method === 'turn/start') {
        const segment = segments[turnIndex] ?? [];
        turnIndex += 1;
        const splitAt = Math.max(segment.findIndex(isInterruptResponse), -1);
        const head = splitAt === -1 ? segment : segment.slice(0, splitAt);
        pending = splitAt === -1 ? [] : segment.slice(splitAt);
        head.forEach((row, index) => {
            emit(index === 0 ? { ...row, id: frame.id } : row);
        });
        return;
    }
    if (frame.method === 'turn/interrupt') {
        for (const row of pending) emit(isInterruptResponse(row) ? { ...row, id: frame.id } : row);
        pending = [];
        return;
    }
    for (const row of bootstrap) {
        if (row.method !== undefined) emit(row);
        else if (frame.method === 'initialize' && row.id === 1) emit({ ...row, id: frame.id });
        else if ((frame.method === 'thread/start' || frame.method === 'thread/resume') && row.id === 2)
            emit({ ...row, id: frame.id });
    }
};

createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '') return;
    try {
        serve(JSON.parse(line) as Row);
    } catch {
        // Malformed parent frame: nothing to serve.
    }
});
