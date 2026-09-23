import { describe, expect, test } from 'bun:test';
import { type ChoiceAnswer, type NoulAnswer, q, type ScoreAnswer } from '@gobing-ai/ts-ai-runner';
import { NodeProcessExecutor } from '@gobing-ai/ts-runtime';
import { createFmDriver } from '../src/driver';
import { availableArgv } from '../src/fm-process';

/**
 * R10: the live suite runs only on a capable host — darwin/arm64 with the
 * system model available (`fm available --model system` exits 0). Everywhere
 * else it skips with a stated reason and never fails because the host lacks
 * fm (AC9: Linux CI passes without fm).
 */
async function fmSystemModelAvailable(): Promise<boolean> {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return false;
    try {
        const result = await new NodeProcessExecutor().run({ command: 'fm', args: availableArgv() });
        return result.exitCode === 0;
    } catch {
        return false;
    }
}

const fmReady = await fmSystemModelAvailable();

describe.skipIf(!fmReady)('fm live driver (task 0084 R10 — darwin + system model available only)', () => {
    const QUESTIONS = {
        sentiment: q.choice('Sentiment of the customer message', {
            positive: 'Praise, satisfaction',
            negative: 'Complaint, frustration',
        }),
        priority: q.score('Priority for the support queue', [
            'Routine — handle within the normal SLA',
            'Critical — customer is blocked or losing money',
        ]),
        refund: q.noul('Should the double charge be refunded?', {
            yes: 'The charge is a duplicate',
            no: 'The charge is legitimate',
        }),
    };
    const STATE = 'Customer was billed twice for invoice INV-42 and opened a complaint.';

    test('answers choice, score and noul over a real system model', async () => {
        const driver = createFmDriver({ samples: 3, requestTimeoutMs: 60_000 });
        expect(driver.name).toBe('fm-local');
        expect(driver.estimator).toEqual({ kind: 'sample-frequency', samples: 3, greedy: false });

        const answers = await driver.ask({ state: STATE, questions: QUESTIONS });

        const sentiment = answers.sentiment as ChoiceAnswer<string>;
        expect(sentiment.kind).toBe('choice');
        expect(['positive', 'negative']).toContain(sentiment.label);
        expect((sentiment.probabilities.positive ?? 0) + (sentiment.probabilities.negative ?? 0)).toBeCloseTo(1, 12);

        const priority = answers.priority as ScoreAnswer;
        expect(priority.kind).toBe('score');
        expect([0, 1]).toContain(priority.score);
        expect(priority.legend[1]).toContain('Critical');

        const refund = answers.refund as NoulAnswer;
        expect(refund).toEqual({ kind: 'noul', probability: expect.any(Number) });
        expect(refund.probability).toBeGreaterThanOrEqual(0);
        expect(refund.probability).toBeLessThanOrEqual(1);
    });

    test('a real fm accepts the generated schema (x-order present)', async () => {
        // Without x-order fm rejects the schema outright, so three valid
        // samples prove the generated schema is conformant.
        const driver = createFmDriver({ samples: 3, requestTimeoutMs: 60_000 });
        const answers = await driver.ask({ state: STATE, questions: QUESTIONS });
        expect(Object.keys(answers).sort()).toEqual(['priority', 'refund', 'sentiment']);
    });

    test('deterministic mode answers one-hot in a single greedy call', async () => {
        const driver = createFmDriver({ deterministic: true, requestTimeoutMs: 60_000 });
        expect(driver.estimator).toEqual({ kind: 'sample-frequency', samples: 1, greedy: true });
        const answers = await driver.ask({ state: STATE, questions: QUESTIONS });
        const sentiment = answers.sentiment as ChoiceAnswer<string>;
        expect(Object.values(sentiment.probabilities).sort()).toEqual([0, 1]);
        expect(sentiment.confidence).toBe(1);
    });
});
