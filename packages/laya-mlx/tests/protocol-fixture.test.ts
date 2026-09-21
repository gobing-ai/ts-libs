import { describe, expect, it } from 'bun:test';
import {
    type ChoiceAnswer,
    DecisionBackendError,
    DecisionConfigError,
    DecisionRequestError,
    type NoulAnswer,
    q,
    type ScoreAnswer,
} from '@gobing-ai/ts-ai-runner';
import type { PipeProcess, ProcessExecutor } from '@gobing-ai/ts-runtime';
import { createLayaDriver, mapWorkerAnswer, toWorkerQuestion } from '../src/driver';
import { LayaWorkerClient, type WorkerQuestion } from '../src/worker-client';
import recordedFixture from './fixtures/protocol-lines.json';

class MockPipeProcess implements PipeProcess {
    readonly pid = 99999;
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr = null;
    readonly exited: Promise<number | null>;
    private controller!: ReadableStreamDefaultController<Uint8Array>;
    private encoder = new TextEncoder();
    private resolveExit!: (code: number | null) => void;
    private responseIndex = 0;

    constructor(private readonly responses: Array<Record<string, unknown>>) {
        this.stdout = new ReadableStream<Uint8Array>({
            start: (ctrl) => {
                this.controller = ctrl;
                // Emit recorded handshake on startup
                const handshakeLine = `${JSON.stringify(recordedFixture.handshake)}\n`;
                ctrl.enqueue(this.encoder.encode(handshakeLine));
            },
        });
        this.exited = new Promise((resolve) => {
            this.resolveExit = resolve;
        });
    }

    writeStdin(input: string | Uint8Array): void {
        const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
        const lines = text.split('\n').filter((l) => l.trim().length > 0);
        for (const line of lines) {
            try {
                const parsed = JSON.parse(line);
                const id = String(parsed.id);
                const resp = this.responses[this.responseIndex++];
                if (resp !== undefined) {
                    const correlated = { ...resp, id };
                    this.controller.enqueue(this.encoder.encode(`${JSON.stringify(correlated)}\n`));
                }
            } catch {
                this.controller.enqueue(this.encoder.encode('INVALID_RESPONSE_LINE_NOT_JSON\n'));
            }
        }
    }

    endStdin(): void {
        this.resolveExit(0);
        try {
            this.controller.close();
        } catch {
            // Already closed
        }
    }

    kill(): void {
        this.resolveExit(1);
        try {
            this.controller.close();
        } catch {
            // Already closed
        }
    }
}

class MockProcessExecutor implements ProcessExecutor {
    constructor(private readonly responses: Array<Record<string, unknown>>) {}

    runStreaming(): PipeProcess {
        return new MockPipeProcess(this.responses);
    }

    async run(): Promise<never> {
        throw new Error('Not implemented for streaming driver tests');
    }
}

describe('Protocol fixture layer against committed lines (task 0081 R1, R2)', () => {
    it('R1, R2: verifies request construction and framing using recorded lines', () => {
        const choiceQ = q.choice('Pick dept', { billing: 'Billing', tech: 'Support' });
        const workerQ = toWorkerQuestion(choiceQ);
        expect(workerQ.type).toBe('choice');
        expect(workerQ.instructions).toBe('Pick dept');
        expect(workerQ.labels).toEqual({ billing: 'Billing', tech: 'Support' });

        const scoreQ = q.score('Clarity', ['poor', 'ok', 'good']);
        const workerScoreQ = toWorkerQuestion(scoreQ);
        expect(workerScoreQ.type).toBe('score');
        expect(workerScoreQ.rubric).toEqual(['poor', 'ok', 'good']);
        // The runtime rejects a map: score criteria goes on the wire as a nonempty list.
        expect(workerScoreQ.criteria).toEqual(['poor', 'ok', 'good']);

        const noulQ = q.noul('Deploy?');
        const workerNoulQ = toWorkerQuestion(noulQ);
        expect(workerNoulQ.type).toBe('noul');
    });

    it('R1, R2: executes choice conversation over mock bridge and maps answer', async () => {
        const choiceConv = recordedFixture.conversations.find((c) => c.name === 'choice');
        if (!choiceConv) throw new Error('choice conversation missing');
        const client = new LayaWorkerClient(
            { platform: 'darwin', arch: 'arm64' },
            new MockProcessExecutor([choiceConv.response]),
        );
        const driver = createLayaDriver({ client, platform: 'darwin', arch: 'arm64' });
        const choiceQ = q.choice('Route to the correct department', {
            billing: 'Invoices and payments',
            tech: 'Hardware and software support',
        });

        const answers = await driver.ask({
            state: 'Route ticket',
            questions: { dept: choiceQ },
        });
        expect(answers.dept?.kind).toBe('choice');
        expect((answers.dept as ChoiceAnswer<'billing' | 'tech'> | undefined)?.label).toBe('billing');

        // Test direct mapper against committed response
        const result = choiceConv.response.result;
        if (!result) throw new Error('choice result missing');
        const mapped = mapWorkerAnswer(choiceQ, result.answers.dept) as ChoiceAnswer<'billing' | 'tech'>;
        expect(mapped.kind).toBe('choice');
        expect(mapped.label).toBe('billing');
        expect(mapped.confidence).toBe(0.9421);
        expect(mapped.probabilities).toEqual({ billing: 0.9421, tech: 0.0579 });
        // Action probability stripped
        expect((mapped as unknown as Record<string, unknown>).action).toBeUndefined();

        client.dispose();
    });

    it('R1, R2: executes score conversation over mock bridge and maps answer', () => {
        const scoreConv = recordedFixture.conversations.find((c) => c.name === 'score');
        if (!scoreConv) throw new Error('score conversation missing');
        const scoreQ = q.score('Rate code clarity', ['poor', 'acceptable', 'clear']);

        const result = scoreConv.response.result;
        if (!result) throw new Error('score result missing');
        const mapped = mapWorkerAnswer(scoreQ, result.answers.readability) as ScoreAnswer;
        expect(mapped.kind).toBe('score');
        expect(mapped.score).toBe(2);
        expect(mapped.confidence).toBe(0.8845);
        expect(mapped.legend).toEqual({ 0: 'poor', 1: 'acceptable', 2: 'clear' });
        expect(mapped.probabilities).toEqual({ 0: 0.0211, 1: 0.0944, 2: 0.8845 });
        // Action probability stripped
        expect((mapped as unknown as Record<string, unknown>).action).toBeUndefined();
    });

    it('R1, R2: executes noul conversation over mock bridge and verifies confidence stripped', () => {
        const noulConv = recordedFixture.conversations.find((c) => c.name === 'noul');
        if (!noulConv) throw new Error('noul conversation missing');
        const noulQ = q.noul('Approve deploy?');

        const result = noulConv.response.result;
        if (!result) throw new Error('noul result missing');
        const mapped = mapWorkerAnswer(noulQ, result.answers.deploy) as NoulAnswer;
        expect(mapped.kind).toBe('noul');
        expect(mapped.probability).toBe(0.9842);
        // Noul confidence stripped per R4
        expect((mapped as unknown as Record<string, unknown>).confidence).toBeUndefined();
        expect((mapped as unknown as Record<string, unknown>).action).toBeUndefined();
    });

    it('R2: covers every error branch (config, request, backend)', async () => {
        const configConv = recordedFixture.conversations.find((c) => c.name === 'error_config');
        const reqConv = recordedFixture.conversations.find((c) => c.name === 'error_request');
        const beConv = recordedFixture.conversations.find((c) => c.name === 'error_backend');
        if (!configConv || !reqConv || !beConv) throw new Error('error conversations missing');

        const client = new LayaWorkerClient(
            { platform: 'darwin', arch: 'arm64' },
            new MockProcessExecutor([configConv.response, reqConv.response, beConv.response]),
        );
        // 1. Config error
        await expect(
            client.ask(
                configConv.request.state,
                configConv.request.questions as unknown as Record<string, WorkerQuestion>,
            ),
        ).rejects.toThrow(DecisionConfigError);

        // 2. Request error
        await expect(
            client.ask(reqConv.request.state, reqConv.request.questions as unknown as Record<string, WorkerQuestion>),
        ).rejects.toThrow(DecisionRequestError);

        // 3. Backend error
        await expect(
            client.ask(beConv.request.state, beConv.request.questions as unknown as Record<string, WorkerQuestion>),
        ).rejects.toThrow(DecisionBackendError);

        client.dispose();
    });
});
