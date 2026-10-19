/**
 * TypeSafe driver wire validation (moved from ai-runner's validation suite with the
 * driver in task 0116 R1): the shared neutral validators still run inside the driver,
 * so malformed wire answers are rejected there before any caller sees them.
 */
import { describe, expect, test } from 'bun:test';
import {
    type Answer,
    createDecisionMaker,
    DecisionBackendError,
    DecisionRequestError,
    type Question,
    q,
} from '@gobing-ai/ts-ai-runner';
import { createTypesafeDriver } from '../src/typesafe-driver';

const choice = q.choice('route?', { accept: null, repair: null });

/**
 * A stream-backed JSON response: SDK 0.7.0 buffers each attempt through `response.clone()`'s
 * reader, which on Bun leaves a string/`Response.json()` body disturbed.
 */
function json(payload: unknown, status = 200): Response {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    return new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(bytes);
                controller.close();
            },
        }),
        { status, headers: { 'content-type': 'application/json' } },
    );
}

describe('TypeSafe driver wire validation', () => {
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
                        json({ answers: { x: wireAnswer } })) as typeof fetch,
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
                fetch: (async (_input: Parameters<typeof fetch>[0]) => json(payload)) as typeof fetch,
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
                return json({});
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
                return json({
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
        // noProto: the `__proto__` key is the subject of this test (an answer keyed
        // `__proto__` must survive), so read it as the own property it is (asserted above by
        // Object.keys) rather than through the deprecated accessor.
        expect(Object.getOwnPropertyDescriptor(answers, '__proto__')?.value).toEqual({
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
