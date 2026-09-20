import { describe, expect, test } from 'bun:test';
import { createDecisionMaker } from '../../src/decision/decision-maker';
import { DecisionBackendError, DecisionRequestError } from '../../src/decision/errors';
import type { Answer, Question } from '../../src/decision/types';
import { q } from '../../src/decision/types';
import { createTypesafeDriver } from '../../src/decision/typesafe-driver';

const choice = q.choice('route?', { accept: null, repair: null });
const answer = { kind: 'choice', label: 'accept', confidence: 0.8, probabilities: { accept: 0.8, repair: 0.2 } };

describe('decision boundary validation', () => {
    test('rejects malformed caller questions before contacting any driver', async () => {
        let calls = 0;
        const dm = createDecisionMaker({
            driver: {
                name: 'fake',
                async ask() {
                    calls++;
                    return {};
                },
            },
        });
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        for (const questions of [
            null,
            [],
            {},
            { x: null },
            { x: { kind: 'unknown' } },
            { x: { kind: 'choice', labels: [] } },
            { x: q.choice(null, {}) },
            { x: { kind: 'score', rubric: {} } },
            { x: { kind: 'score', rubric: [null] } },
            { x: q.noul(42 as never) },
            { x: q.noul(cyclic as never) },
            { x: q.noul(null, { yes: false as never }) },
        ]) {
            await expect(
                dm.ask({ state: null, questions: questions as Record<string, Question> }),
            ).rejects.toBeInstanceOf(DecisionRequestError);
        }
        expect(calls).toBe(0);
    });

    test('rejects missing, extra, mistyped, incomplete and out-of-range custom answers', async () => {
        for (const answers of [
            null,
            [],
            {},
            { wrong: answer },
            { x: answer, extra: answer },
            { x: null },
            { x: { kind: 'noul', probability: 0.5 } },
            { x: { ...answer, label: 'unknown' } },
            { x: { ...answer, confidence: NaN } },
            { x: { ...answer, confidence: 1.1 } },
            { x: { ...answer, probabilities: {} } },
            { x: { ...answer, probabilities: { accept: -0.1, repair: 1.1 } } },
        ]) {
            const dm = createDecisionMaker({
                driver: {
                    name: 'fake',
                    async ask() {
                        return answers as Record<string, Answer>;
                    },
                },
            });
            await expect(dm.ask({ state: null, questions: { x: choice } })).rejects.toBeInstanceOf(
                DecisionBackendError,
            );
        }
    });

    test('score bounds use zero-indexed rubric levels and permit expected fractional scores', async () => {
        const score = {
            kind: 'score',
            score: 0.8,
            confidence: 0.9,
            legend: { 0: 'low', 1: 'high' },
            probabilities: { 0: 0.2, 1: 0.8 },
        };
        for (const value of [score, { ...score, score: 0 }, { ...score, score: 1 }]) {
            const dm = createDecisionMaker({
                driver: {
                    name: 'fake',
                    async ask() {
                        return { question: value } as Record<string, Answer>;
                    },
                },
            });
            expect((await dm.score(null, null, ['low', 'high'])).score).toBe(value.score);
        }
        for (const value of [
            { ...score, score: 2 },
            { ...score, score: Infinity },
            { ...score, legend: {} },
            { ...score, probabilities: { 0: 1 } },
            { kind: 'noul', probability: -0.1 },
            { kind: 'noul', probability: Infinity },
        ]) {
            const dm = createDecisionMaker({
                driver: {
                    name: 'fake',
                    async ask() {
                        return { question: value } as Record<string, Answer>;
                    },
                },
            });
            await expect(
                dm.ask({
                    state: null,
                    questions: { question: value.kind === 'noul' ? q.noul() : q.score(null, ['low', 'high']) },
                }),
            ).rejects.toBeInstanceOf(DecisionBackendError);
        }
    });

    test('default driver rejects malformed successful wire responses', async () => {
        for (const payload of [
            null,
            {},
            { answers: [] },
            { answers: { x: null } },
            { answers: { x: { type: 'unknown' } } },
            { answers: { x: { type: 'noul', noul: 0.5 } } },
            { answers: {} },
        ]) {
            const driver = createTypesafeDriver({
                apiKey: 'test',
                maxRetries: 0,
                fetch: (async (_input: Parameters<typeof fetch>[0]) => Response.json(payload)) as typeof fetch,
            });
            await expect(driver.ask({ state: null, questions: { x: choice } })).rejects.toBeInstanceOf(
                DecisionBackendError,
            );
        }
    });

    test('invalid builder inputs yield package errors without fetching', async () => {
        let calls = 0;
        const driver = createTypesafeDriver({
            apiKey: 'test',
            fetch: (async (_input: Parameters<typeof fetch>[0]) => {
                calls++;
                return Response.json({});
            }) as typeof fetch,
        });
        await expect(
            driver.ask({ state: null, questions: { x: { kind: 'score', rubric: {} } as Question } }),
        ).rejects.toBeInstanceOf(DecisionRequestError);
        expect(calls).toBe(0);
    });

    test('preserves __proto__ question and label keys on the wire and in answers', async () => {
        let sent: unknown;
        const driver = createTypesafeDriver({
            apiKey: 'test',
            fetch: (async (_input, init) => {
                sent = JSON.parse(String(init?.body));
                return Response.json({
                    answers: {
                        ['__proto__']: {
                            type: 'choice',
                            choice: '__proto__',
                            confidence: 1,
                            probabilities: { ['__proto__']: 1 },
                        },
                    },
                });
            }) as typeof fetch,
        });
        const questions = { ['__proto__']: q.choice(null, { ['__proto__']: null }) };
        const answers = await driver.ask({ state: null, questions });
        expect(Object.keys(answers)).toEqual(['__proto__']);
        expect(answers.__proto__).toEqual({
            kind: 'choice',
            label: '__proto__',
            confidence: 1,
            probabilities: { ['__proto__']: 1 },
        });
        expect(sent).toMatchObject({
            questions: { ['__proto__']: { type: 'choice', criteria: { ['__proto__']: null } } },
        });
    });
});
