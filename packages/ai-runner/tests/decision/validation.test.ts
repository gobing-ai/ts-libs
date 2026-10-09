import { describe, expect, test } from 'bun:test';
import { createDecisionMaker } from '../../src/decision/decision-maker';
import { DecisionBackendError, DecisionRequestError } from '../../src/decision/errors';
import type { Answer, Question } from '../../src/decision/types';
import { q } from '../../src/decision/types';
import { createTypesafeDriver } from '../../src/decision/typesafe-driver';

const choice = q.choice('route?', { accept: null, repair: null });
const answer = {
    kind: 'choice' as const,
    label: 'accept',
    confidence: 0.8,
    probabilities: { accept: 0.8, repair: 0.2 },
};

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

    test('choice and score reject invalid mass through ask and sugar, including a mixed response', async () => {
        for (const kind of ['choice', 'score'] as const) {
            const question = kind === 'choice' ? choice : q.score(null, ['low', 'high']);
            const keys = kind === 'choice' ? ['accept', 'repair'] : ['0', '1'];
            for (const mass of [0, 0.5, 2, 1 - 2e-6, 1 + 2e-6]) {
                const value = {
                    ...(kind === 'choice'
                        ? answer
                        : { kind, score: 0.8, confidence: 0.9, legend: { 0: 'low', 1: 'high' } }),
                    probabilities: Object.fromEntries(keys.map((key) => [key, mass / 2])),
                } as Answer;
                const dm = createDecisionMaker({
                    driver: {
                        name: 'fake',
                        async ask({ questions }) {
                            return Object.fromEntries(
                                Object.keys(questions).map((name) => [name, name === 'valid' ? answer : value]),
                            );
                        },
                    },
                });
                for (const invoke of [
                    () => dm.ask({ state: null, questions: { x: question } }),
                    () =>
                        kind === 'choice'
                            ? dm.choice(null, null, choice.labels)
                            : dm.score(null, null, ['low', 'high']),
                    () => dm.ask({ state: null, questions: { valid: choice, x: question } }),
                ]) {
                    const request = invoke();
                    await expect(request).rejects.toBeInstanceOf(DecisionBackendError);
                    await expect(request).rejects.toThrow(/Invalid decision response: (x|question)$/);
                }
            }
        }
    });

    test('accepts raw tolerance on both sides without changing answers or fractional scores', async () => {
        for (const kind of ['choice', 'score'] as const) {
            const question = kind === 'choice' ? choice : q.score(null, ['low', 'high']);
            const keys = kind === 'choice' ? ['accept', 'repair'] : ['0', '1'];
            // These adjacent representable totals straddle the lower bound without a second epsilon.
            for (const mass of [1, 1 - 0.5e-6, 1 + 0.5e-6, 1 + 1e-6, 0.9999990000000001, 0.999999]) {
                const probabilities = Object.freeze(Object.fromEntries(keys.map((key) => [key, mass / 2])));
                const value = Object.freeze({
                    ...(kind === 'choice'
                        ? answer
                        : { kind, score: 0.8, confidence: 0.9, legend: { 0: 'low', 1: 'high' } }),
                    probabilities,
                }) as Answer;
                const answers = Object.freeze({ question: value });
                const dm = createDecisionMaker({
                    driver: {
                        name: 'fake',
                        async ask() {
                            return answers;
                        },
                    },
                });
                const request = dm.ask({ state: null, questions: { question } });
                if (Math.abs(mass - 1) > 1e-6) {
                    await expect(request).rejects.toBeInstanceOf(DecisionBackendError);
                    continue;
                }
                expect((await request) === answers).toBe(true);
                const result =
                    kind === 'choice'
                        ? await dm.choice(null, null, choice.labels)
                        : await dm.score(null, null, ['low', 'high']);
                expect(result === value).toBe(true);
                expect(result.probabilities).toBe(probabilities);
            }
        }
        for (const probability of [0, 0.5, 1]) {
            const value = { kind: 'noul', probability } as const;
            const dm = createDecisionMaker({
                driver: {
                    name: 'fake',
                    async ask() {
                        return { question: value };
                    },
                },
            });
            expect(await dm.noul(null, null)).toBe(value);
        }
    });

    test('direct and facade-wrapped TypeSafe choice and score validate wire mass', async () => {
        for (const kind of ['choice', 'score'] as const) {
            const question = kind === 'choice' ? choice : q.score(null, ['low', 'high']);
            const keys = kind === 'choice' ? ['accept', 'repair'] : ['0', '1'];
            for (const mass of [0, 0.5, 2, 1 - 2e-6, 1 + 2e-6, 1, 1 - 0.5e-6, 1 + 0.5e-6]) {
                const wireAnswer = {
                    type: kind,
                    ...(kind === 'choice' ? { choice: 'accept' } : { score: 0.8, legend: { 0: 'low', 1: 'high' } }),
                    confidence: 0.8,
                    probabilities: Object.fromEntries(keys.map((key) => [key, mass / 2])),
                };
                const driver = createTypesafeDriver({
                    apiKey: 'test',
                    maxRetries: 0,
                    fetch: (async (_input: Parameters<typeof fetch>[0]) =>
                        Response.json({ answers: { x: wireAnswer } })) as typeof fetch,
                });
                for (const maker of [driver, createDecisionMaker({ driver })]) {
                    const request = maker.ask({ state: null, questions: { x: question } });
                    if (Math.abs(mass - 1) > 1e-6) {
                        await expect(request).rejects.toBeInstanceOf(DecisionBackendError);
                        await expect(request).rejects.toThrow('Invalid decision response: x');
                    } else {
                        expect(await request).toEqual({
                            x: {
                                kind,
                                ...(kind === 'choice'
                                    ? { label: 'accept' }
                                    : { score: 0.8, legend: { 0: 'low', 1: 'high' } }),
                                confidence: 0.8,
                                probabilities: wireAnswer.probabilities,
                            } as Answer,
                        });
                    }
                }
            }
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

    test('validateQuestions and validateAnswers are exported from ai-runner main barrel', async () => {
        const barrel = await import('../../src/index');
        expect(typeof barrel.validateQuestions).toBe('function');
        expect(typeof barrel.validateAnswers).toBe('function');
    });
});
