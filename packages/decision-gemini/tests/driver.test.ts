import { describe, expect, test } from 'bun:test';
import {
    DecisionAuthError,
    DecisionBackendError,
    DecisionConfigError,
    DecisionConnectionError,
    DecisionRateLimitError,
    DecisionRequestError,
    DecisionTimeoutError,
    type Question,
    q,
} from '@gobing-ai/ts-ai-runner';
import { createGeminiDecisionDriver, type GeminiDecisionDriverOptions } from '../src/driver';

/** Bun's `typeof fetch` carries a `preconnect` static a plain async stub does not. */
type StubFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>;

/** Shape of the wire request body this driver sends; mirror of the hosted contract. */
interface WireQuestion {
    type: string;
    instructions: unknown;
    criteria?: unknown;
}
interface WireBody {
    model: string;
    input: unknown;
    questions: Record<string, WireQuestion>;
}

const VALID_KEY = 'google_api_key_secret';

/** Parse the captured request body into the wire shape. */
function wireBody(init?: RequestInit): WireBody {
    return JSON.parse(String(init?.body)) as WireBody;
}

function makeValidResponse(answers: Record<string, unknown>): Response {
    return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** Records the last request and answers from a per-test script; never a real socket. */
function recordingFetch(respond: (wire: WireBody) => Response): {
    fetcher: StubFetch;
    wire: () => WireBody;
    url: () => string;
    headers: () => Record<string, string>;
    callCount: () => number;
} {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: WireBody = { model: '', input: null, questions: {} };
    let calls = 0;
    const fetcher: StubFetch = async (input, init) => {
        calls += 1;
        capturedUrl = String(input);
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        capturedBody = wireBody(init);
        return respond(capturedBody);
    };
    return {
        fetcher,
        wire: () => capturedBody,
        url: () => capturedUrl,
        headers: () => capturedHeaders,
        callCount: () => calls,
    };
}

/** Answer every requested question with a valid answer of its own kind. */
function genericAnswers(body: WireBody): Response {
    const answers: Record<string, unknown> = {};
    for (const [key, question] of Object.entries(body.questions)) {
        if (question.type === 'choice') {
            const labels = Object.keys(question.criteria as Record<string, unknown>);
            const probabilities: Record<string, number> = {};
            labels.forEach((label, index) => {
                probabilities[label] = index === 0 ? 1 : 0;
            });
            answers[key] = { type: 'choice', choice: labels[0], confidence: 1, probabilities };
        } else if (question.type === 'score') {
            const levels = question.criteria as unknown[];
            const legend: Record<string, string> = {};
            const probabilities: Record<string, number> = {};
            levels.forEach((_level, index) => {
                legend[index] = `L${index}`;
                probabilities[index] = index === 0 ? 1 : 0;
            });
            answers[key] = { type: 'score', score: 0, confidence: 1, legend, probabilities };
        } else {
            answers[key] = { type: 'noul', noul: 0.5 };
        }
    }
    return makeValidResponse(answers);
}

function driverWith(overrides?: Partial<GeminiDecisionDriverOptions>): {
    driver: ReturnType<typeof createGeminiDecisionDriver>;
    ctx: ReturnType<typeof recordingFetch>;
} {
    const ctx = recordingFetch(genericAnswers);
    const driver = createGeminiDecisionDriver({
        apiKey: VALID_KEY,
        fetch: ctx.fetcher as typeof fetch,
        ...overrides,
    });
    return { driver, ctx };
}

/** A minimal valid question set, one of each kind. */
function oneEach(): Record<string, Question> {
    return {
        pick: q.choice('Pick one', { yes: 'Yes', no: 'No' }),
        grade: q.score('Grade it', ['low', 'high']),
        go: q.noul('Proceed?'),
    };
}

describe('createGeminiDecisionDriver — construction (R1)', () => {
    test('exposes the gemini-decision driver name and answers over the default endpoint', async () => {
        const { driver, ctx } = driverWith();
        expect(driver.name).toBe('gemini-decision');
        const answers = await driver.ask({ state: null, questions: { go: q.noul() } });
        expect(answers.go).toEqual({ kind: 'noul', probability: 0.5 });
        expect(ctx.url()).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
        expect(ctx.headers()['x-goog-api-key']).toBe(VALID_KEY);
        expect(ctx.headers()['Content-Type']).toBe('application/json');
        expect(ctx.callCount()).toBe(1);
    });

    test('rejects missing or invalid options at construction', () => {
        expect(() => createGeminiDecisionDriver(null as never)).toThrow(DecisionConfigError);
        for (const apiKey of [undefined, '', '   ', 'key\twith\ttabs', 'key\nline', 'key\x00null', 'key\x7fdel']) {
            try {
                createGeminiDecisionDriver({
                    ...(apiKey === undefined ? {} : { apiKey }),
                    fetch: async () => new Response(''),
                } as unknown as GeminiDecisionDriverOptions);
                expect.unreachable(`apiKey ${JSON.stringify(apiKey)} must be rejected`);
            } catch (error) {
                expect(error).toBeInstanceOf(DecisionConfigError);
                expect((error as DecisionConfigError).variable).toBe('apiKey');
            }
        }
    });

    test('rejects invalid baseURLs at construction', () => {
        for (const baseURL of [
            'not a url',
            'ftp://example.com',
            'https://user:pass@example.com',
            'https://example.com/?q=1',
            'https://example.com/#frag',
        ]) {
            try {
                createGeminiDecisionDriver({ apiKey: VALID_KEY, baseURL });
                expect.unreachable(`baseURL ${baseURL} must be rejected`);
            } catch (error) {
                expect(error).toBeInstanceOf(DecisionConfigError);
                expect((error as DecisionConfigError).variable).toBe('baseURL');
            }
        }
    });

    test('accepts an http baseURL with a trailing slash, without double slashes on the wire', async () => {
        const { driver, ctx } = driverWith({ baseURL: 'http://localhost:8787/' });
        await driver.ask({ state: null, questions: { go: q.noul() } });
        expect(ctx.url()).toBe('http://localhost:8787/v1beta/decisions');
    });

    test('rejects invalid timeoutMs and model at construction', () => {
        for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
            expect(() => createGeminiDecisionDriver({ apiKey: VALID_KEY, timeoutMs })).toThrow(DecisionConfigError);
        }
        expect(() => createGeminiDecisionDriver({ apiKey: VALID_KEY, model: 'other' as never })).toThrow(
            DecisionConfigError,
        );
    });

    test('valid model selectors pass construction', () => {
        expect(() => createGeminiDecisionDriver({ apiKey: VALID_KEY })).not.toThrow();
        expect(() => createGeminiDecisionDriver({ apiKey: VALID_KEY, model: 'gemini-decision-1' })).not.toThrow();
    });
});

describe('createGeminiDecisionDriver — request shape (R2)', () => {
    test('sends the hosted wire body with model, input and per-kind question criteria', async () => {
        const { driver, ctx } = driverWith();
        await driver.ask({
            state: { ticket: 'T-1' },
            questions: oneEach(),
        });
        const wire = ctx.wire();
        expect(wire.model).toBe('gemini-decision-1');
        expect(wire.input).toEqual({ ticket: 'T-1' });
        expect(Object.keys(wire.questions).sort()).toEqual(['go', 'grade', 'pick']);
        expect(wire.questions.pick).toEqual({
            type: 'choice',
            instructions: 'Pick one',
            criteria: { yes: 'Yes', no: 'No' },
        });
        expect(wire.questions.grade).toEqual({ type: 'score', instructions: 'Grade it', criteria: ['low', 'high'] });
        expect(wire.questions.go).toEqual({ type: 'noul', instructions: 'Proceed?' });
    });

    test('omitted, null and blank prompts fall back to the question ID', async () => {
        const { driver, ctx } = driverWith();
        await driver.ask({
            state: null,
            questions: {
                bare: q.noul(),
                nulled: q.noul(null),
                blank: q.choice('   ', { a: 'A', b: 'B' }),
            },
        });
        const wire = ctx.wire();
        expect(wire.questions['bare']).toEqual({ type: 'noul', instructions: 'bare' });
        expect(wire.questions['nulled']).toEqual({ type: 'noul', instructions: 'nulled' });
        expect(wire.questions['blank']).toEqual({
            type: 'choice',
            instructions: 'blank',
            criteria: { a: 'A', b: 'B' },
        });
    });

    test('per-call model overrides the configured default on the wire', async () => {
        const { driver, ctx } = driverWith({ model: 'gemini-decision-1' });
        await driver.ask({ state: null, questions: { go: q.noul() }, model: 'gemini-decision-1' });
        expect(ctx.wire().model).toBe('gemini-decision-1');
    });

    test('rejects an invalid per-call model selector before any transport', async () => {
        const { driver, ctx } = driverWith();
        await expect(driver.ask({ state: null, questions: { go: q.noul() }, model: 'unsupported' })).rejects.toThrow(
            DecisionRequestError,
        );
        expect(ctx.callCount()).toBe(0);
    });

    test('enforces the 1..1000 question limit before transport', async () => {
        const { driver, ctx } = driverWith();
        const many: Record<string, Question> = {};
        for (let i = 0; i < 1001; i++) many[`q${i}`] = q.noul();
        await expect(driver.ask({ state: null, questions: many })).rejects.toThrow(DecisionRequestError);
        await expect(driver.ask({ state: null, questions: {} })).rejects.toThrow(DecisionRequestError);
        expect(ctx.callCount()).toBe(0);
    });

    test('enforces the 2..255 choice-label limit and rejects empty choice IDs', async () => {
        const { driver, ctx } = driverWith();
        const labels255: Record<string, string> = {};
        for (let i = 0; i < 255; i++) labels255[`l${i}`] = `L${i}`;
        await expect(driver.ask({ state: null, questions: { q1: q.choice(null, labels255) } })).resolves.toBeDefined();
        const labels256: Record<string, string> = { ...labels255, extra: 'E' };
        await expect(driver.ask({ state: null, questions: { q1: q.choice(null, labels256) } })).rejects.toThrow(
            DecisionRequestError,
        );
        await expect(driver.ask({ state: null, questions: { q1: q.choice(null, { only: 'one' }) } })).rejects.toThrow(
            DecisionRequestError,
        );
        await expect(
            driver.ask({ state: null, questions: { q1: q.choice(null, { ok: 'A', '': 'empty' }) } }),
        ).rejects.toThrow(DecisionRequestError);
        expect(ctx.callCount()).toBe(1); // only the 255-label request reached transport
    });

    test('enforces the 2..255 score-level limit', async () => {
        const { driver, ctx } = driverWith();
        const two = ['a', 'b'] as const;
        await expect(driver.ask({ state: null, questions: { q1: q.score(null, two) } })).resolves.toBeDefined();
        const levels256 = Array.from({ length: 256 }, (_v, i) => `L${i}`) as [string, string, ...string[]];
        await expect(driver.ask({ state: null, questions: { q1: q.score(null, levels256) } })).rejects.toThrow(
            DecisionRequestError,
        );
        expect(ctx.callCount()).toBe(1);
    });

    test('enforces the question ID pattern ^[A-Za-z0-9_.-]{1,100}$', async () => {
        const { driver, ctx } = driverWith();
        for (const badId of ['has space', 'emoji🚀', '', 'a'.repeat(101), 'slash/away']) {
            await expect(driver.ask({ state: null, questions: { [badId]: q.noul() } })).rejects.toThrow(
                DecisionRequestError,
            );
        }
        await expect(driver.ask({ state: null, questions: { 'Ok.Id_1-x': q.noul() } })).resolves.toBeDefined();
        expect(ctx.callCount()).toBe(1);
    });

    test('rejects un-serializable state before transport', async () => {
        const { driver, ctx } = driverWith();
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        await expect(driver.ask({ state: circular as never, questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionRequestError,
        );

        class Foreign {}
        Object.setPrototypeOf(Foreign.prototype, null);
        await expect(driver.ask({ state: new Foreign() as never, questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionRequestError,
        );

        const withAccessor = {};
        Object.defineProperty(withAccessor, 'x', { get: () => 1, enumerable: true });
        await expect(driver.ask({ state: withAccessor, questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionRequestError,
        );

        const withSymbol: Record<string | symbol, unknown> = { ok: 1 };
        const symbolKey = Symbol('hidden');
        withSymbol[symbolKey] = 2;
        await expect(driver.ask({ state: withSymbol as never, questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionRequestError,
        );

        const sparse = new Array(3);
        sparse[1] = 'x';
        await expect(driver.ask({ state: sparse, questions: { q1: q.noul() } })).rejects.toThrow(DecisionRequestError);

        await expect(driver.ask({ state: { n: Number.NaN } as never, questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionRequestError,
        );
        await expect(driver.ask({ state: { big: 1n } as never, questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionRequestError,
        );
        expect(ctx.callCount()).toBe(0);
    });

    test('treats absent state exactly like null state on the wire', async () => {
        const { driver, ctx } = driverWith();
        await driver.ask({ state: undefined as never, questions: { go: q.noul() } });
        expect(ctx.wire().input).toBe('');
    });

    test('rejects an unserializable description in the request body, not only in state', async () => {
        const { driver, ctx } = driverWith();
        await expect(
            driver.ask({
                state: null,
                questions: { q1: q.choice({ bad: 1n } as never, { a: 'A', b: 'B' }) },
            }),
        ).rejects.toThrow(DecisionRequestError);
        expect(ctx.callCount()).toBe(0);
    });

    test('rejects a request body that exceeds the 13 MiB cap', async () => {
        const { driver, ctx } = driverWith();
        await expect(driver.ask({ state: 'é'.repeat(7 * 1024 * 1024), questions: { q1: q.noul() } })).rejects.toThrow(
            /13 MiB/,
        );
        expect(ctx.callCount()).toBe(0);
    });
});

describe('createGeminiDecisionDriver — transport and status mapping (R3)', () => {
    const driver = createGeminiDecisionDriver({
        apiKey: VALID_KEY,
        timeoutMs: 50,
        fetch: (async () =>
            new Promise<Response>((_resolve, reject) => {
                setTimeout(() => reject(new DOMException('The operation was aborted.', 'AbortError')), 500);
            })) as unknown as typeof fetch,
    });

    test('maps a request timeout to DecisionTimeoutError via the real APIClient', async () => {
        const error = await driver.ask({ state: null, questions: { q1: q.noul() } }).then(
            () => expect.unreachable('timeout must throw'),
            (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(DecisionTimeoutError);
        expect((error as DecisionTimeoutError).timeoutMs).toBe(50);
    });

    test('maps a network failure to DecisionConnectionError', async () => {
        const failing = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () => {
                throw new TypeError('fetch failed');
            }) as unknown as typeof fetch,
        });
        await expect(failing.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionConnectionError,
        );
    });

    test('maps HTTP statuses onto the driver error taxonomy', async () => {
        const cases: [number, new (...args: never[]) => Error, string][] = [
            [401, DecisionAuthError, '401'],
            [403, DecisionAuthError, '403'],
            [400, DecisionRequestError, '400'],
            [404, DecisionRequestError, '404'],
            [422, DecisionRequestError, '422'],
            [500, DecisionBackendError, '500'],
            [503, DecisionBackendError, '503'],
            [302, DecisionBackendError, 'redirect'],
        ];
        for (const [status, errorClass, needle] of cases) {
            const stubbed = createGeminiDecisionDriver({
                apiKey: VALID_KEY,
                fetch: (async () => new Response('nope', { status })) as unknown as typeof fetch,
            });
            await expect(stubbed.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(errorClass);
            const err = await stubbed.ask({ state: null, questions: { q1: q.noul() } }).then(
                () => expect.unreachable(),
                (e: unknown) => e as Error,
            );
            expect(err.message).toContain(needle);
        }
    });

    test('maps 429 to DecisionRateLimitError with a parsed Retry-After', async () => {
        const seconds = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response('', { status: 429, headers: { 'Retry-After': '30' } })) as unknown as typeof fetch,
        });
        const err = await seconds.ask({ state: null, questions: { q1: q.noul() } }).then(
            () => expect.unreachable(),
            (e: unknown) => e as DecisionRateLimitError,
        );
        expect(err).toBeInstanceOf(DecisionRateLimitError);
        expect(err.retryAfterMs).toBe(30_000);

        const httpDate = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response('', {
                    status: 429,
                    headers: { 'Retry-After': new Date(Date.now() + 65_000).toUTCString() },
                })) as unknown as typeof fetch,
        });
        const dateErr = await httpDate.ask({ state: null, questions: { q1: q.noul() } }).then(
            () => expect.unreachable(),
            (e: unknown) => e as DecisionRateLimitError,
        );
        expect(dateErr.retryAfterMs).toBeGreaterThan(0);

        const bare = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () => new Response('', { status: 429 })) as unknown as typeof fetch,
        });
        const bareErr = await bare.ask({ state: null, questions: { q1: q.noul() } }).then(
            () => expect.unreachable(),
            (e: unknown) => e as DecisionRateLimitError,
        );
        expect(bareErr.retryAfterMs).toBeUndefined();
    });

    test('rejects a response that exceeds the 8 MiB cap', async () => {
        // APIClient truncates bodies beyond maxResponseBytes; the driver must fail closed.
        const huge = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () => new Response('x'.repeat(9 * 1024 * 1024), { status: 200 })) as unknown as typeof fetch,
        });
        await expect(huge.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(/8 MiB/);
    });
});

describe('createGeminiDecisionDriver — response parsing (R4)', () => {
    test('accepts the { result: { answers } } envelope', async () => {
        const stubbed = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response(JSON.stringify({ result: { answers: { q1: { type: 'noul', noul: 0.75 } } } }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })) as unknown as typeof fetch,
        });
        const answers = await stubbed.ask({ state: null, questions: { q1: q.noul() } });
        expect(answers.q1).toEqual({ kind: 'noul', probability: 0.75 });
    });

    test('accepts array-form answers and array-form probability distributions', async () => {
        const stubbed = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response(
                    JSON.stringify({
                        answers: [
                            {
                                name: 'pick',
                                type: 'choice',
                                choice: 'yes',
                                confidence: 0.9,
                                probabilities: [
                                    { value: 'yes', probability: 0.9 },
                                    { value: 'no', probability: 0.1 },
                                ],
                            },
                        ],
                    }),
                    { status: 200 },
                )) as unknown as typeof fetch,
        });
        const answers = await stubbed.ask({
            state: null,
            questions: { pick: q.choice('Pick', { yes: 'Y', no: 'N' }) },
        });
        expect(answers.pick).toEqual({
            kind: 'choice',
            label: 'yes',
            confidence: 0.9,
            probabilities: { yes: 0.9, no: 0.1 },
        });
    });

    test('accepts `label` as an alias for `choice` on choice answers', async () => {
        const stubbed = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response(
                    JSON.stringify({
                        answers: {
                            pick: { type: 'choice', label: 'no', confidence: 1, probabilities: { no: 1, yes: 0 } },
                        },
                    }),
                    { status: 200 },
                )) as unknown as typeof fetch,
        });
        const answers = await stubbed.ask({
            state: null,
            questions: { pick: q.choice('Pick', { yes: 'Y', no: 'N' }) },
        });
        expect((answers.pick as { label: string }).label).toBe('no');
    });

    test('defaults a missing score legend to the request rubric, indexed 0-based', async () => {
        const stubbed = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response(
                    JSON.stringify({
                        answers: {
                            grade: {
                                type: 'score',
                                score: 1,
                                confidence: 0.8,
                                probabilities: { 0: 0.2, 1: 0.8 },
                            },
                        },
                    }),
                    { status: 200 },
                )) as unknown as typeof fetch,
        });
        const answers = await stubbed.ask({ state: null, questions: { grade: q.score('Grade', ['low', 'high']) } });
        expect(answers.grade).toEqual({
            kind: 'score',
            score: 1,
            confidence: 0.8,
            legend: { 0: 'low', 1: 'high' },
            probabilities: { 0: 0.2, 1: 0.8 },
        });
    });

    test('keeps only the bare probability on noul answers, ignoring a wire confidence', async () => {
        const stubbed = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response(
                    JSON.stringify({ answers: { q1: { type: 'noul', probability: 0.4, confidence: 0.99 } } }),
                    { status: 200 },
                )) as unknown as typeof fetch,
        });
        const answers = await stubbed.ask({ state: null, questions: { q1: q.noul() } });
        expect(answers.q1).toEqual({ kind: 'noul', probability: 0.4 });
    });

    test('rejects refusal and unknown answer types with DecisionBackendError', async () => {
        for (const answer of [
            { type: 'refusal', reason: 'cannot comply' },
            { type: 'poem', text: 'roses' },
        ]) {
            const stubbed = createGeminiDecisionDriver({
                apiKey: VALID_KEY,
                fetch: (async () =>
                    new Response(JSON.stringify({ answers: { q1: answer } }), {
                        status: 200,
                    })) as unknown as typeof fetch,
            });
            await expect(stubbed.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(
                DecisionBackendError,
            );
        }
    });

    test('rejects a malformed JSON body, a non-object envelope and an absent answers map', async () => {
        for (const body of ['not json{', '{"model":"m"}', '{"answers":"nope"}', '{"result":{"other":1}}']) {
            const stubbed = createGeminiDecisionDriver({
                apiKey: VALID_KEY,
                fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
            });
            await expect(stubbed.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(
                DecisionBackendError,
            );
        }
    });

    test('rejects malformed choice and score answer bodies', async () => {
        const cases = [
            { answers: { q1: { type: 'choice', confidence: 1, probabilities: { a: 1, b: 0 } } } }, // no label
            { answers: { q1: { type: 'choice', choice: 'a', probabilities: { a: 1, b: 0 } } } }, // no confidence
            { answers: { q1: { type: 'choice', choice: 'a', confidence: 1, probabilities: 'flat' } } }, // bad distribution
            { answers: { q1: { type: 'score', confidence: 1, probabilities: { 0: 1, 1: 0 } } } }, // no score
            { answers: { q1: { type: 'noul' } } }, // no probability
        ];
        for (const envelope of cases) {
            const stubbed = createGeminiDecisionDriver({
                apiKey: VALID_KEY,
                fetch: (async () => new Response(JSON.stringify(envelope), { status: 200 })) as unknown as typeof fetch,
            });
            const questions: Record<string, Question> = {
                q1: q.choice('Pick', { a: 'A', b: 'B' }),
            };
            await expect(stubbed.ask({ state: null, questions })).rejects.toThrow(DecisionBackendError);
        }
    });

    test('rejects correspondence mismatches, wrong labels and unnormalized mass via validateAnswers', async () => {
        const cases = [
            { answers: { q1: { type: 'noul', noul: 0.5 }, extra: { type: 'noul', noul: 0.5 } } }, // extra answer
            { answers: { q1: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 1, b: 0 } } } }, // kind mismatch (noul question)
            { answers: { q1: { type: 'choice', choice: 'ghost', confidence: 1, probabilities: { a: 1, b: 0 } } } }, // unknown label
            { answers: { q1: { type: 'noul', noul: 1.5 } } }, // out of bounds
        ];
        for (const envelope of cases) {
            const stubbed = createGeminiDecisionDriver({
                apiKey: VALID_KEY,
                fetch: (async () => new Response(JSON.stringify(envelope), { status: 200 })) as unknown as typeof fetch,
            });
            const questions: Record<string, Question> = { q1: q.noul() };
            await expect(stubbed.ask({ state: null, questions })).rejects.toThrow(DecisionBackendError);
        }
        const mass = createGeminiDecisionDriver({
            apiKey: VALID_KEY,
            fetch: (async () =>
                new Response(
                    JSON.stringify({
                        answers: {
                            pick: { type: 'choice', choice: 'a', confidence: 1, probabilities: { a: 0.5, b: 0.2 } },
                        },
                    }),
                    { status: 200 },
                )) as unknown as typeof fetch,
        });
        await expect(
            mass.ask({ state: null, questions: { pick: q.choice('Pick', { a: 'A', b: 'B' }) } }),
        ).rejects.toThrow(DecisionBackendError);
    });

    test('routes every answer of a mixed batch through the full normalization path', async () => {
        const { driver, ctx } = driverWith();
        const answers = await driver.ask({ state: { src: 'test' }, questions: oneEach() });
        expect(answers.pick).toEqual({
            kind: 'choice',
            label: 'yes',
            confidence: 1,
            probabilities: { yes: 1, no: 0 },
        });
        expect(answers.grade).toEqual({
            kind: 'score',
            score: 0,
            confidence: 1,
            legend: { 0: 'L0', 1: 'L1' },
            probabilities: { 0: 1, 1: 0 },
        });
        expect(answers.go).toEqual({ kind: 'noul', probability: 0.5 });
        expect(ctx.callCount()).toBe(1);
    });
});
