import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { nodeBunFactory } from '@gobing-ai/ts-runtime';

/**
 * Worker protocol fixture (task 0075): drives worker/laya_worker.py over the same
 * ProcessExecutor.runStreaming seam the TypeScript client (0076) will use, against
 * the stub runtime module so the default test lane needs no MLX and no checkpoint.
 * Covers handshake-first, id correlation, error classification, and oversized-batch
 * chunking — the framing contract every later task consumes.
 */

const PKG_ROOT = join(import.meta.dir, '..');
const STUB_MODULE = 'tests.fixtures.stub_laya';

interface LineReader {
    next(): Promise<string>;
}

function makeLineReader(stream: ReadableStream<Uint8Array> | null): LineReader {
    const queued: string[] = [];
    const waiters: Array<(line: string) => void> = [];
    let buffer = '';
    let closed = false;
    if (stream) {
        void (async () => {
            const decoder = new TextDecoder();
            for await (const chunk of stream) {
                buffer += decoder.decode(chunk, { stream: true });
                let newlineAt = buffer.indexOf('\n');
                while (newlineAt !== -1) {
                    const line = buffer.slice(0, newlineAt);
                    buffer = buffer.slice(newlineAt + 1);
                    const waiter = waiters.shift();
                    if (waiter) waiter(line);
                    else queued.push(line);
                    newlineAt = buffer.indexOf('\n');
                }
            }
            closed = true;
            while (waiters.length > 0) {
                const waiter = waiters.shift();
                if (waiter) waiter('');
            }
        })();
    } else {
        closed = true;
    }
    return {
        next(): Promise<string> {
            const line = queued.shift();
            if (line !== undefined) return Promise.resolve(line);
            if (closed) return Promise.resolve('');
            return new Promise((resolve) => waiters.push(resolve));
        },
    };
}

interface WorkerError {
    kind: string;
    message: string;
}

// Parsed lines are open-ended (the handshake carries model/revision/maxLen), so the
// envelope keeps an index signature; known fields stay typed for callers.
interface WorkerLine {
    id?: string | number;
    ready?: boolean;
    ok?: boolean;
    result?: unknown;
    error?: WorkerError;
    [key: string]: unknown;
}

function spawnWorker(...extraArgs: string[]) {
    const executor = nodeBunFactory.createProcessExecutor();
    return executor.runStreaming({
        command: 'python3',
        args: [join('worker', 'laya_worker.py'), '--module', STUB_MODULE, ...extraArgs],
        cwd: PKG_ROOT,
        label: 'laya-worker-protocol-fixture',
    });
}

async function sendAndRead(
    proc: ReturnType<ReturnType<typeof nodeBunFactory.createProcessExecutor>['runStreaming']>,
    reader: LineReader,
    payload: unknown,
): Promise<WorkerLine> {
    proc.writeStdin(`${JSON.stringify(payload)}\n`);
    const line = await reader.next();
    expect(line).not.toBe('');
    return JSON.parse(line) as WorkerLine;
}

describe('laya_worker.py JSON-lines protocol', () => {
    it('emits the handshake before serving any request', async () => {
        const proc = spawnWorker();
        const reader = makeLineReader(proc.stdout);
        const handshake = JSON.parse(await reader.next()) as WorkerLine;
        expect(handshake).toEqual({ ready: true, model: 'stub/laya', revision: null, maxLen: 512 });
        proc.endStdin();
        expect(await proc.exited).toBe(0);
    });

    it('correlates responses to request ids and passes answers through keyed by question name', async () => {
        const proc = spawnWorker();
        const reader = makeLineReader(proc.stdout);
        await reader.next(); // handshake
        const first = await sendAndRead(proc, reader, {
            id: 'a',
            state: 'state text',
            questions: { q1: { type: 'choice', instructions: 'pick', criteria: ['x', 'y'] } },
        });
        expect(first.id).toBe('a');
        expect(first.ok).toBe(true);
        const result = first.result as { model: string; answers: Record<string, unknown> };
        expect(result.model).toBe('stub-laya');
        expect(Object.keys(result.answers)).toEqual(['q1']);

        const second = await sendAndRead(proc, reader, {
            id: 'b',
            state: 'state text',
            questions: { q2: { type: 'noul', instructions: 'yes?' } },
        });
        expect(second.id).toBe('b');
        expect(second.ok).toBe(true);
        proc.endStdin();
        expect(await proc.exited).toBe(0);
    });

    it('classifies malformed lines and bad questions as request errors without killing the worker', async () => {
        const proc = spawnWorker();
        const reader = makeLineReader(proc.stdout);
        await reader.next(); // handshake

        proc.writeStdin('this is not json\n');
        const malformed = JSON.parse(await reader.next()) as WorkerLine;
        expect(malformed.id).toBe('');
        expect(malformed.ok).toBe(false);
        expect(malformed.error?.kind).toBe('request');

        const badQuestion = await sendAndRead(proc, reader, {
            id: 'e1',
            state: 's',
            questions: { q: { type: 'quantum', instructions: 'impossible' } },
        });
        expect(badQuestion.id).toBe('e1');
        expect(badQuestion.ok).toBe(false);
        expect(badQuestion.error?.kind).toBe('request');

        const backend = await sendAndRead(proc, reader, {
            id: 'e2',
            state: 's',
            questions: { q: { type: 'choice', instructions: 'boom', criteria: ['a'] } },
        });
        expect(backend.id).toBe('e2');
        expect(backend.ok).toBe(false);
        expect(backend.error?.kind).toBe('backend');
        expect(backend.error?.message).toContain('Non-finite');

        // The worker survived every failure and still serves the next request.
        const after = await sendAndRead(proc, reader, {
            id: 'ok-1',
            state: 's',
            questions: { q: { type: 'noul', instructions: 'fine' } },
        });
        expect(after.id).toBe('ok-1');
        expect(after.ok).toBe(true);
        proc.endStdin();
        expect(await proc.exited).toBe(0);
    });

    it('answers a question set larger than the batch size in chunks with no dropped questions', async () => {
        const proc = spawnWorker('--batch-size', '2');
        const reader = makeLineReader(proc.stdout);
        await reader.next(); // handshake
        const questions: Record<string, unknown> = {};
        for (let i = 0; i < 5; i++) questions[`q${i}`] = { type: 'noul', instructions: `question ${i}` };
        const response = await sendAndRead(proc, reader, { id: 'big', state: 's', questions });
        expect(response.ok).toBe(true);
        const result = response.result as { answers: Record<string, unknown>; usage: { chunks: number } };
        expect(Object.keys(result.answers).sort()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
        expect(result.usage.chunks).toBe(3);
        proc.endStdin();
        expect(await proc.exited).toBe(0);
    });

    it('reports construction failures as a config error handshake and exits nonzero', async () => {
        const proc = spawnWorker('--dtype', 'float8');
        const reader = makeLineReader(proc.stdout);
        const handshake = JSON.parse(await reader.next()) as WorkerLine;
        expect(handshake.ready).toBe(false);
        expect(handshake.error?.kind).toBe('config');
        expect(await proc.exited).toBe(1);
    });
});
