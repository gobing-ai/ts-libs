import { describe, expect, it } from 'bun:test';
import {
    type ChoiceAnswer,
    createDecisionMaker,
    DecisionBackendError,
    type NoulAnswer,
    q,
    type ScoreAnswer,
} from '@gobing-ai/ts-ai-runner';
import { createLayaDriver, mapWorkerAnswer } from '../src/driver';
import { LayaWorkerClient } from '../src/worker-client';

describe('Laya decision driver answer mapping (task 0078)', () => {
    describe('R1, AC1 — DecisionDriver contract without sugar', () => {
        it('returns a DecisionDriver with readonly name and single ask method', () => {
            const driver = createLayaDriver({
                platform: 'darwin',
                arch: 'arm64',
            });
            expect(driver.name).toBe('laya-local');
            expect(typeof driver.ask).toBe('function');
            // R1: exposes no choice/score/noul sugar on the driver
            const rawDriver = driver as unknown as Record<string, unknown>;
            expect(rawDriver.choice).toBeUndefined();
            expect(rawDriver.score).toBeUndefined();
            expect(rawDriver.noul).toBeUndefined();
        });

        it('is substitutable in createDecisionMaker from ts-ai-runner', async () => {
            const client = new LayaWorkerClient({
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const driver = createLayaDriver({ client, platform: 'darwin', arch: 'arm64' });
            const dm = createDecisionMaker({ driver });
            const res = await dm.ask({
                state: 'user prompt',
                questions: {
                    sentiment: q.choice('Rate sentiment', { pos: 'Positive', neg: 'Negative' }),
                    quality: q.score('Score code', ['poor', 'fair', 'good']),
                    approved: q.noul('Should deploy?'),
                },
            });
            expect(res.sentiment.kind).toBe('choice');
            expect(res.quality.kind).toBe('score');
            expect(res.approved.kind).toBe('noul');
            client.dispose();
        });
    });

    describe('R2 — Choice answer mapping', () => {
        it('maps choice answers with label, confidence, and probabilities per label', () => {
            const question = q.choice('Select color', { red: 'Red color', blue: 'Blue color' });
            const raw = {
                type: 'choice',
                choice: 'red',
                confidence: 0.88,
                probabilities: { red: 0.88, blue: 0.12 },
                action: { act_probability: 0.99 },
            };
            const answer = mapWorkerAnswer(question, raw) as ChoiceAnswer<'red' | 'blue'>;
            expect(answer.kind).toBe('choice');
            expect(answer.label).toBe('red');
            expect(answer.confidence).toBe(0.88);
            expect(answer.probabilities).toEqual({ red: 0.88, blue: 0.12 });
            // R5: action probability is dropped
            expect((answer as Record<string, unknown>).action).toBeUndefined();
            expect((answer as Record<string, unknown>).act_probability).toBeUndefined();
        });
    });

    describe('R3 — Score answer mapping', () => {
        it('maps score answers with score, confidence, legend, and probabilities per rubric index', () => {
            const question = q.score('Code review', ['buggy', 'acceptable', 'flawless']);
            const raw = {
                type: 'score',
                score: 2,
                confidence: 0.91,
                legend: { '0': 'buggy', '1': 'acceptable', '2': 'flawless' },
                probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 },
                action: { act_probability: 0.75 },
            };
            const answer = mapWorkerAnswer(question, raw) as ScoreAnswer;
            expect(answer.kind).toBe('score');
            expect(answer.score).toBe(2);
            expect(answer.confidence).toBe(0.91);
            expect(answer.legend).toEqual({ 0: 'buggy', 1: 'acceptable', 2: 'flawless' });
            expect(answer.probabilities).toEqual({ 0: 0.05, 1: 0.15, 2: 0.8 });
            // R5: action probability is dropped
            expect((answer as Record<string, unknown>).action).toBeUndefined();
            expect((answer as Record<string, unknown>).act_probability).toBeUndefined();
        });

        it('derives the categorical score as argmax of probabilities when the runtime reports an expectation', () => {
            // Live-run finding (0081): the runtime reports score as the probability-weighted
            // expectation (e.g. 1.8451); the neutral contract is the 0-indexed rubric category.
            const question = q.score('Urgency', ['not urgent', 'soon', 'critical']);
            const raw = {
                type: 'score',
                score: 1.8451,
                confidence: 0.85,
                probabilities: { '0': 0.02, '1': 0.13, '2': 0.85 },
            };
            const answer = mapWorkerAnswer(question, raw) as ScoreAnswer;
            expect(answer.kind).toBe('score');
            expect(answer.score).toBe(2);
            expect(answer.probabilities).toEqual({ 0: 0.02, 1: 0.13, 2: 0.85 });
        });
    });

    describe('R4, R5 — Noul answer mapping and field stripping', () => {
        it('carries only yes-probability, with no confidence or action probability present', () => {
            const question = q.noul('Is production ready?');
            const raw = {
                type: 'noul',
                noul: 0.82,
                confidence: 0.82,
                action: { act_probability: 0.95 },
            };
            const answer = mapWorkerAnswer(question, raw) as NoulAnswer;
            expect(answer.kind).toBe('noul');
            expect(answer.probability).toBe(0.82);
            // R4: confidence must NOT be present or synthesized on noul answers
            expect((answer as Record<string, unknown>).confidence).toBeUndefined();
            // R5: action probability is dropped
            expect((answer as Record<string, unknown>).action).toBeUndefined();
            expect((answer as Record<string, unknown>).act_probability).toBeUndefined();
        });
    });

    describe('malformed worker answers', () => {
        it('rejects instead of silently defaulting fields', () => {
            expect(() =>
                mapWorkerAnswer(q.choice('Pick', { a: 'A', b: 'B' }), { type: 'choice', confidence: 0.5 }),
            ).toThrow(DecisionBackendError);
            expect(() => mapWorkerAnswer(q.score('Rate', ['x', 'y']), { type: 'score' })).toThrow(DecisionBackendError);
            expect(() => mapWorkerAnswer(q.noul('Go?'), { type: 'noul' })).toThrow(DecisionBackendError);
            expect(() => mapWorkerAnswer(q.noul('Go?'), { type: 'noul', noul: Number.NaN })).toThrow(
                DecisionBackendError,
            );
        });
    });

    describe('R6 — All answers keyed by question name in caller question set', () => {
        it('driver returns answers corresponding to every question in the caller set', async () => {
            const client = new LayaWorkerClient({
                module: 'tests.fixtures.stub_laya',
                platform: 'darwin',
                arch: 'arm64',
            });
            const driver = createLayaDriver({ client, platform: 'darwin', arch: 'arm64' });
            const questions = {
                decisionA: q.choice('Pick A', { opt1: 'Option 1', opt2: 'Option 2' }),
                decisionB: q.score('Score B', ['low', 'high']),
                decisionC: q.noul('Confirm C?'),
            };
            const answers = await driver.ask({
                state: 'context state',
                questions,
            });
            expect(Object.keys(answers).sort()).toEqual(['decisionA', 'decisionB', 'decisionC']);
            expect(answers.decisionA?.kind).toBe('choice');
            expect(answers.decisionB?.kind).toBe('score');
            expect(answers.decisionC?.kind).toBe('noul');
            client.dispose();
        });
    });
});
