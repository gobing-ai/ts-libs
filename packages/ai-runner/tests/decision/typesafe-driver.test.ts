import { describe, expect, test } from 'bun:test';
import { removeEnvVar, setEnvVar } from '@gobing-ai/ts-utils';
import { TypeSafeError } from '@typesafe-ai/sdk';
import {
    DecisionAuthError,
    DecisionBackendError,
    DecisionConnectionError,
    DecisionError,
    DecisionRateLimitError,
    DecisionRequestError,
    DecisionTimeoutError,
} from '../../src/decision/errors';
import type { ChoiceAnswer, NoulAnswer, ScoreAnswer } from '../../src/decision/types';
import { q } from '../../src/decision/types';
import { createTypesafeDriver, type TypesafeDriverConfig } from '../../src/decision/typesafe-driver';

/** A captured wire request: URL, fetch init, and the JSON-parsed body. */
interface WireCall {
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
    questions: Record<string, Record<string, unknown>>;
}

/** Injected fetch that records every call and answers from `respond`. */
function recordedFetch(respond: (call: WireCall) => Response): { fetch: typeof fetch; calls: WireCall[] } {
    const calls: WireCall[] = [];
    type FetchInput = Parameters<typeof fetch>[0];
    const fake = (async (input: FetchInput, init?: RequestInit) => {
        // The driver under test only ever serializes here, so a JSON parse of
        // `init.body` is the wire shape, not a re-derivation of it.
        const body = init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>);
        const call: WireCall = {
            url: String(input),
            init: init ?? {},
            body,
            questions: body.questions as Record<string, Record<string, unknown>>,
        };
        calls.push(call);
        return respond(call);
    }) as typeof fetch;
    return { fetch: fake, calls };
}

/** Driver over a recorded fetch; retries off so error tests stay single-call and sleep-free. */
function driver(respond: (call: WireCall) => Response, overrides: Partial<TypesafeDriverConfig> = {}) {
    const wire = recordedFetch(respond);
    return {
        wire,
        driver: createTypesafeDriver({ apiKey: 'test-key', fetch: wire.fetch, maxRetries: 0, ...overrides }),
    };
}

/** The single recorded call — throws (failing the test) when there is none. */
function firstCall(wire: { calls: WireCall[] }): WireCall {
    const call = wire.calls[0];
    if (!call) throw new Error('no wire call was recorded');
    return call;
}

function json(payload: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

/** Canned /v1/systemone success body, keyed like the three-question ask below. */
const SYSTEM_ONE = {
    model: 'jev-latest',
    usage: { input_tokens: 10, output_tokens: 5 },
    answers: {
        tier: { type: 'choice', choice: 'basic', confidence: 0.9, probabilities: { basic: 0.9, pro: 0.1 } },
        urgency: {
            type: 'score',
            score: 1.5,
            confidence: 0.8,
            legend: { 0: 'low', 1: 'high' },
            probabilities: { 0: 0.2, 1: 0.8 },
        },
        refund: { type: 'noul', noul: 0.75 },
    },
};

/** The error a promise rejects with, or null when it resolves. */
const rejection = (p: Promise<unknown>): Promise<unknown> =>
    p.then(
        () => null,
        (err) => err,
    );

describe('createTypesafeDriver (0072: client wiring and mapping)', () => {
    test('R1/R2 — driver named "typesafe"; explicit key reaches the wire; baseURL forwarded', async () => {
        const { wire, driver: d } = driver(() => json(SYSTEM_ONE), {
            apiKey: 'explicit-key',
            baseURL: 'https://ts.example/v0',
        });
        expect(d.name).toBe('typesafe');
        await d.ask({ state: 's', questions: { a: q.noul('yes?') } });
        expect(wire.calls.length).toBe(1);
        expect(firstCall(wire).url).toBe('https://ts.example/v0/v1/systemone');
        // The key is the configured one. With no TYPESAFE_API_KEY in the test
        // environment, a driver that dropped the explicit key would fail at
        // construction instead of producing this header — so this assertion
        // pins "passed explicitly, never self-resolved".
        expect(new Headers(firstCall(wire).init.headers).get('authorization')).toBe('Bearer explicit-key');
    });

    test('R1 — config.model becomes defaultModel when ask omits model', async () => {
        const { wire, driver: d } = driver(() => json(SYSTEM_ONE), { model: 'cfg-model' });
        await d.ask({ state: 's', questions: { a: q.noul('yes?') } });
        expect(firstCall(wire).body.model).toBe('cfg-model');
    });

    test('R3 — exactly one request regardless of question count', async () => {
        const respond = () => json(SYSTEM_ONE);
        const one = driver(respond);
        await one.driver.ask({ state: 's', questions: { a: q.noul('yes?') } });
        const three = driver(respond);
        await three.driver.ask({
            state: 's',
            questions: {
                a: q.noul('yes?'),
                b: q.score('how?', ['low', 'high']),
                c: q.choice('which?', { x: null, y: null }),
            },
        });
        expect(one.wire.calls.length).toBe(1);
        expect(three.wire.calls.length).toBe(1);
    });

    test('R2/R4 — wire body: state once, questions keyed by caller names in SDK shape', async () => {
        const { wire, driver: d } = driver(() => json(SYSTEM_ONE));
        const state = { ticket: 'T-1', text: 'charged twice' };
        await d.ask({
            state,
            model: 'jev-pro',
            questions: {
                tier: q.choice('Which tier?', { basic: null, pro: 'paying' }),
                urgency: q.score('How urgent?', ['low', 'high']),
                refund: q.noul('Refund?', { yes: 'wants money back', no: 'keep' }),
            },
        });
        const { init, body } = firstCall(wire);
        expect(init.method).toBe('POST');
        expect(body.state).toEqual(state);
        expect(body.model).toBe('jev-pro');
        expect(firstCall(wire).questions).toEqual({
            tier: { type: 'choice', instructions: 'Which tier?', criteria: { basic: null, pro: 'paying' } },
            urgency: { type: 'score', instructions: 'How urgent?', criteria: ['low', 'high'] },
            refund: { type: 'noul', instructions: 'Refund?', criteria: { true: 'wants money back', false: 'keep' } },
        });
    });

    test('R4 — undescribed prompts become null; a bare noul sends no criteria', async () => {
        const { wire, driver: d } = driver(() => json(SYSTEM_ONE));
        await d.ask({ state: null, questions: { bare: q.noul(), pick: q.choice(null, { a: 'x' }) } });
        expect(firstCall(wire).body.state).toBeNull();
        // Parsed from the serialized body, so an absent key really is absent on the wire.
        expect(firstCall(wire).questions).toEqual({
            bare: { type: 'noul', instructions: null },
            pick: { type: 'choice', instructions: null, criteria: { a: 'x' } },
        });
    });

    test('R5/R6/R8 — answers keyed by caller names, mapped per kind, noul carries no confidence', async () => {
        const { driver: d } = driver(() => json(SYSTEM_ONE));
        const answers = await d.ask({
            state: 's',
            questions: {
                tier: q.choice('t?', { basic: null, pro: null }),
                urgency: q.score('u?', ['low', 'high']),
                refund: q.noul('r?'),
            },
        });
        expect(Object.keys(answers)).toEqual(['tier', 'urgency', 'refund']);
        const tier = answers.tier as ChoiceAnswer<string>;
        const urgency = answers.urgency as ScoreAnswer;
        const refund = answers.refund as NoulAnswer;
        expect(tier).toEqual({
            kind: 'choice',
            label: 'basic',
            confidence: 0.9,
            probabilities: { basic: 0.9, pro: 0.1 },
        });
        expect(urgency).toEqual({
            kind: 'score',
            score: 1.5,
            confidence: 0.8,
            legend: { 0: 'low', 1: 'high' },
            probabilities: { 0: 0.2, 1: 0.8 },
        });
        // The load-bearing asymmetry: noul is exactly kind + probability.
        expect(refund).toEqual({ kind: 'noul', probability: 0.75 });
        expect(Object.keys(refund)).toEqual(['kind', 'probability']);
        // R8: result-level model/usage stay behind.
        expect(answers).not.toHaveProperty('usage');
        expect(answers).not.toHaveProperty('model');
    });

    test('R7 — each HTTP failure maps into the taxonomy, never an SDK class', async () => {
        const cases = [
            { status: 401, expected: DecisionAuthError },
            { status: 403, expected: DecisionAuthError },
            { status: 400, expected: DecisionRequestError },
            { status: 404, expected: DecisionRequestError },
            { status: 422, expected: DecisionRequestError },
            { status: 429, expected: DecisionRateLimitError },
            { status: 500, expected: DecisionBackendError },
            { status: 503, expected: DecisionBackendError },
        ];
        for (const { status, expected } of cases) {
            const { driver: d } = driver(() => json({ detail: 'upstream said no' }, status));
            const err = await rejection(d.ask({ state: 's', questions: { a: q.noul('y?') } }));
            expect(err, `status ${status}`).toBeInstanceOf(expected);
            expect(err, `status ${status}`).toBeInstanceOf(DecisionError);
            expect(err, `status ${status}`).not.toBeInstanceOf(TypeSafeError);
        }
    });

    test('R7 — auth, rate-limit, request, and backend errors carry their detail', async () => {
        const rate = driver(() => json({ detail: 'slow down' }, 429, { 'retry-after-ms': '1500' }));
        const rateErr = (await rejection(
            rate.driver.ask({ state: 's', questions: { a: q.noul('y?') } }),
        )) as DecisionRateLimitError;
        expect(rateErr.status).toBe(429);
        expect(rateErr.retryAfterMs).toBe(1500);

        const auth = driver(() => json({ detail: 'bad key' }, 401));
        const authErr = (await rejection(
            auth.driver.ask({ state: 's', questions: { a: q.noul('y?') } }),
        )) as DecisionAuthError;
        expect(authErr.status).toBe(401);

        const bad = driver(() => json({ detail: 'malformed' }, 400));
        const badErr = (await rejection(
            bad.driver.ask({ state: 's', questions: { a: q.noul('y?') } }),
        )) as DecisionRequestError;
        expect(badErr.status).toBe(400);
        expect(badErr.bodySummary).toContain('malformed');

        const backend = driver(() => json({ detail: 'on fire' }, 503));
        const backendErr = (await rejection(
            backend.driver.ask({ state: 's', questions: { a: q.noul('y?') } }),
        )) as DecisionBackendError;
        expect(backendErr.status).toBe(503);
    });

    test('R7 — transport failure maps to DecisionConnectionError with the cause', async () => {
        const { driver: d } = driver(() => {
            throw new Error('dns broke');
        });
        const err = (await rejection(d.ask({ state: 's', questions: { a: q.noul('y?') } }))) as DecisionConnectionError;
        expect(err).toBeInstanceOf(DecisionConnectionError);
        // SDK wraps the fetch rejection; the cause chain keeps the original.
        expect((err.cause as Error).message).toContain('dns broke');
    });

    test('R7 — timeout maps to DecisionTimeoutError carrying the configured timeoutMs', async () => {
        const hang = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new Error('aborted by the SDK timer')));
            })) as typeof fetch;
        const d = createTypesafeDriver({ apiKey: 'test-key', fetch: hang, maxRetries: 0, timeoutMs: 25 });
        const err = (await rejection(d.ask({ state: 's', questions: { a: q.noul('y?') } }))) as DecisionTimeoutError;
        expect(err).toBeInstanceOf(DecisionTimeoutError);
        expect(err.timeoutMs).toBe(25);
    });

    test('R7 — local SDK rejections land in the taxonomy before any fetch', async () => {
        const { wire, driver: d } = driver(() => json(SYSTEM_ONE));
        const err = await rejection(d.ask({ state: 's', questions: {} }));
        expect(err).toBeInstanceOf(DecisionRequestError);
        expect(err).not.toBeInstanceOf(TypeSafeError);
        expect(wire.calls.length).toBe(0);
    });

    test('R7 — client-construction failures land in the taxonomy too', () => {
        const { fetch } = recordedFetch(() => json(SYSTEM_ONE));
        let caught: unknown;
        try {
            createTypesafeDriver({ apiKey: 'test-key', fetch, timeoutMs: 0 });
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeInstanceOf(DecisionError);
        expect(caught).not.toBeInstanceOf(TypeSafeError);
    });

    test('R7 — a non-SDK Error thrown inside ask passes through untouched', async () => {
        class ForeignError extends Error {}
        const foreign = new ForeignError('parser blew up');
        // The transport wraps fetch rejections, but a body-read failure in the
        // SDK's response parsing reaches the driver raw — the path that pins
        // translateError's foreign-error fall-through.
        const { driver: d } = driver(() => {
            const res = json(SYSTEM_ONE);
            Object.defineProperty(res, 'text', { value: () => Promise.reject(foreign) });
            return res;
        });
        const err = await rejection(d.ask({ state: 's', questions: { a: q.noul('y?') } }));
        expect(err).toBe(foreign);
        expect(err).not.toBeInstanceOf(DecisionError);
    });

    test('R1 — explicit baseURL reaches the client even under ambient TYPESAFE_BASE_URL', async () => {
        setEnvVar('TYPESAFE_BASE_URL', 'https://ambient.example');
        try {
            const { wire, driver: d } = driver(() => json(SYSTEM_ONE), { baseURL: 'https://explicit.example/v1' });
            await d.ask({ state: 's', questions: { a: q.noul('yes?') } });
            expect(firstCall(wire).url).toBe('https://explicit.example/v1/v1/systemone');
        } finally {
            removeEnvVar('TYPESAFE_BASE_URL');
        }
    });
});
