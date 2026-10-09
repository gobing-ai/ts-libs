import { describe, expect, test } from 'bun:test';
import {
    createDecisionMaker,
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
import { type ClefDriverOptions, createClefDriver } from '../src/driver';

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
    state: unknown;
    questions: Record<string, WireQuestion>;
}

const VALID_ACCOUNT = '0123456789abcdef0123456789abcdef';
const VALID_TOKEN = 'secret_token_abc123';

/** Parse the captured request body into the wire shape. */
function wireBody(init?: RequestInit): WireBody {
    return JSON.parse(String(init?.body)) as WireBody;
}

function makeValidResponse(answers: Record<string, unknown>, model = 'clef-flash-model-echo'): Response {
    return new Response(makeValidResponseEnvelope(answers, model), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

/** The REST envelope as a string, for cases that must not go through `Response`. */
function makeValidResponseEnvelope(answers: Record<string, unknown>, model = 'clef-flash-model-echo'): string {
    return JSON.stringify({ success: true, result: { model, answers } });
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
    let capturedBody: WireBody = { model: '', state: null, questions: {} };
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

/** A driver whose fetch is a recording stub answering every question by kind. */
function clefWithOptions(overrides: Partial<ClefDriverOptions> = {}) {
    const rec = recordingFetch((wire) => genericAnswers(wire));
    const driver = createClefDriver({
        accountId: VALID_ACCOUNT,
        apiToken: VALID_TOKEN,
        fetch: rec.fetcher as unknown as typeof fetch,
        ...overrides,
    });
    return { driver, rec };
}

describe('createClefDriver configuration validation', () => {
    test('rejects missing or invalid options at construction', () => {
        const badOptions: unknown[] = [
            undefined,
            null,
            {},
            { accountId: '', apiToken: VALID_TOKEN },
            { accountId: '12345', apiToken: VALID_TOKEN },
            { accountId: `${VALID_ACCOUNT}ZZ`, apiToken: VALID_TOKEN },
            { accountId: VALID_ACCOUNT, apiToken: '' },
            { accountId: VALID_ACCOUNT, apiToken: 'token with space' },
            { accountId: VALID_ACCOUNT, apiToken: 'token\nnewline' },
            { accountId: VALID_ACCOUNT, apiToken: 'token\u0000null' },
            { accountId: VALID_ACCOUNT, apiToken: VALID_TOKEN, timeoutMs: -1 },
            { accountId: VALID_ACCOUNT, apiToken: VALID_TOKEN, timeoutMs: 0 },
            { accountId: VALID_ACCOUNT, apiToken: VALID_TOKEN, timeoutMs: 1.5 },
            { accountId: VALID_ACCOUNT, apiToken: VALID_TOKEN, model: 'gpt-4' },
        ];
        for (const options of badOptions) {
            expect(() => createClefDriver(options as ClefDriverOptions)).toThrow(DecisionConfigError);
        }
    });

    test('config error messages name the field and omit the offending value', () => {
        try {
            createClefDriver({ accountId: 'bad_account', apiToken: VALID_TOKEN });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(DecisionConfigError);
            expect((err as DecisionConfigError).variable).toBe('accountId');
            expect((err as Error).message).not.toContain('bad_account');
        }

        try {
            createClefDriver({ accountId: VALID_ACCOUNT, apiToken: 'bad token with space' });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(DecisionConfigError);
            expect((err as DecisionConfigError).variable).toBe('apiToken');
            expect((err as Error).message).not.toContain('bad token');
        }

        for (const [field, options] of [
            ['timeoutMs', { accountId: VALID_ACCOUNT, apiToken: VALID_TOKEN, timeoutMs: -1 }],
            ['model', { accountId: VALID_ACCOUNT, apiToken: VALID_TOKEN, model: 'gpt-4' }],
        ] as const) {
            try {
                createClefDriver(options as ClefDriverOptions);
                expect.unreachable();
            } catch (err) {
                expect((err as DecisionConfigError).variable).toBe(field);
            }
        }
    });

    test('constructs cleanly with valid options and defaults', () => {
        const { driver } = clefWithOptions();
        expect(driver.name).toBe('clef');
    });
});

describe('Clef driver routing, model selection and auth', () => {
    test('default route is clef-flash and the body model matches the route', async () => {
        const { driver, rec } = clefWithOptions();
        const answers = await driver.ask({
            state: { context: 'test' },
            questions: { q1: q.choice('test prompt', { yes: 'desc', no: 'desc' }) },
        });

        expect(rec.url()).toBe(
            `https://api.cloudflare.com/client/v4/accounts/${VALID_ACCOUNT}/ai/run/@cf/cloudflare/clef-flash`,
        );
        expect(rec.headers().Authorization).toBe(`Bearer ${VALID_TOKEN}`);
        expect(rec.headers()['Content-Type']).toBe('application/json');
        expect(rec.wire().model).toBe('clef-flash');
        expect(rec.wire().state).toEqual({ context: 'test' });
        expect(answers.q1).toMatchObject({ kind: 'choice' });
    });

    test('configured model selects the matching route and body model', async () => {
        const { driver, rec } = clefWithOptions({ model: 'clef' });
        await driver.ask({ state: null, questions: { q1: q.noul('prompt') } });

        expect(rec.url()).toContain('/@cf/cloudflare/clef');
        expect(rec.wire().model).toBe('clef');
    });

    test('per-call model override wins over the configured model', async () => {
        const { driver, rec } = clefWithOptions({ model: 'clef-flash' });
        await driver.ask({ state: null, questions: { q1: q.noul('prompt') }, model: 'clef' });

        expect(rec.url()).toContain('/@cf/cloudflare/clef');
        expect(rec.wire().model).toBe('clef');
    });

    test('rejects an invalid per-call model selector before any transport', async () => {
        const { driver, rec } = clefWithOptions();
        await expect(driver.ask({ state: null, questions: { q1: q.noul() }, model: 'unsupported' })).rejects.toThrow(
            DecisionRequestError,
        );
        expect(rec.callCount()).toBe(0);
    });

    test('makes exactly one request per ask', async () => {
        const { driver, rec } = clefWithOptions();
        await driver.ask({ state: null, questions: { q1: q.noul('prompt') } });
        expect(rec.callCount()).toBe(1);
    });
});

describe('Question mapping and provider limits', () => {
    test('maps all three kinds and falls back to the question ID as instructions', async () => {
        const answers = {
            choiceQ: { type: 'choice', choice: 'c1', confidence: 0.9, probabilities: { c1: 0.9, c2: 0.1 } },
            scoreQ: {
                type: 'score',
                score: 1.5,
                confidence: 0.85,
                legend: { 0: 'L0', 1: 'L1', 2: 'L2' },
                probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 },
            },
            noulQ: { type: 'noul', noul: 0.75 },
            noulWithOutcomes: { type: 'noul', noul: 0.4 },
        };
        const recHolder = recordingFetch(() => makeValidResponse(answers));
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: recHolder.fetcher as unknown as typeof fetch,
        });

        const result = await driver.ask({
            state: 'state string',
            questions: {
                choiceQ: q.choice(null, { c1: 'first', c2: 'second' }),
                scoreQ: q.score('   ', ['L0', 'L1', 'L2']),
                noulQ: q.noul(),
                noulWithOutcomes: q.noul('prompt text', { yes: 'sure', no: null }),
            },
        });

        const questions = recHolder.wire().questions;
        // Undescribed/blank prompts fall back to the question ID.
        expect(questions.choiceQ?.instructions).toBe('choiceQ');
        expect(questions.scoreQ?.instructions).toBe('scoreQ');
        expect(questions.noulQ?.instructions).toBe('noulQ');
        expect(questions.noulWithOutcomes?.instructions).toBe('prompt text');
        // Criteria mapping per kind.
        expect(questions.choiceQ?.criteria).toEqual({ c1: 'first', c2: 'second' });
        expect(questions.scoreQ?.criteria).toEqual(['L0', 'L1', 'L2']);
        expect(questions.noulQ?.criteria).toBeUndefined();
        expect(questions.noulWithOutcomes?.criteria).toEqual({ true: 'sure', false: null });

        // Fractional score and provider confidence are preserved verbatim.
        const score = result.scoreQ;
        expect(score?.kind).toBe('score');
        if (score?.kind === 'score') {
            expect(score.score).toBe(1.5);
            expect(score.confidence).toBe(0.85);
        }

        // Noul keeps the bare probability — no invented confidence.
        const noul = result.noulQ;
        expect(noul?.kind).toBe('noul');
        if (noul?.kind === 'noul') {
            expect(noul.probability).toBe(0.75);
            expect(Object.hasOwn(noul, 'confidence')).toBe(false);
        }
    });

    test('preserves __proto__ question and option IDs end to end', async () => {
        const recHolder = recordingFetch(() =>
            makeValidResponse({
                ['__proto__']: {
                    type: 'choice',
                    choice: '__proto__',
                    confidence: 1,
                    probabilities: { ['__proto__']: 1, other: 0 },
                },
            }),
        );
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: recHolder.fetcher as unknown as typeof fetch,
        });

        const answers = await driver.ask({
            state: null,
            questions: {
                ['__proto__']: q.choice(null, { ['__proto__']: 'proto label', other: 'other label' }),
            },
        });

        expect(Object.hasOwn(answers, '__proto__')).toBe(true);
        expect(answers['__proto__']).toMatchObject({ kind: 'choice' });
        expect(Object.hasOwn(recHolder.wire().questions, '__proto__')).toBe(true);
    });

    test('accepts the 1 and 64 question endpoints', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                const body = wireBody(init);
                const answers: Record<string, unknown> = {};
                for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.5 };
                return Promise.resolve(makeValidResponse(answers));
            }) as unknown as typeof fetch,
        });

        const one = await driver.ask({ state: null, questions: { q1: q.noul() } });
        expect(Object.keys(one)).toHaveLength(1);

        const many: Record<string, Question> = {};
        for (let i = 1; i <= 64; i++) many[`q${i}`] = q.noul();
        const sixtyFour = await driver.ask({ state: null, questions: many });
        expect(Object.keys(sixtyFour)).toHaveLength(64);
    });

    test('rejects 65 questions, and 0 questions, before transport', async () => {
        const { driver, rec } = clefWithOptions();

        const many: Record<string, Question> = {};
        for (let i = 1; i <= 65; i++) many[`q${i}`] = q.noul();
        await expect(driver.ask({ state: null, questions: many })).rejects.toThrow(DecisionRequestError);

        // An empty question map is rejected by the shared validator.
        await expect(driver.ask({ state: null, questions: {} })).rejects.toThrow(DecisionRequestError);

        expect(rec.callCount()).toBe(0);
    });

    test('enforces the 2..255 option limit and rejects empty option IDs', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                const [key] = Object.keys(wireBody(init).questions);
                const probabilities: Record<string, number> = {};
                const labels = Object.keys(wireBody(init).questions[key as string]?.criteria as object);
                for (const label of labels) probabilities[label] = label === labels[0] ? 1 : 0;
                return Promise.resolve(
                    makeValidResponse({
                        [key as string]: {
                            type: 'choice',
                            choice: labels[0],
                            confidence: 1,
                            probabilities,
                        },
                    }),
                );
            }) as unknown as typeof fetch,
        });

        const labels255: Record<string, string> = {};
        for (let i = 1; i <= 255; i++) labels255[`opt${i}`] = `desc${i}`;
        const accepted = await driver.ask({ state: null, questions: { q1: q.choice(null, labels255) } });
        expect(accepted.q1).toMatchObject({ kind: 'choice' });

        const labels256: Record<string, string> = { ...labels255, opt256: 'desc256' };
        await expect(driver.ask({ state: null, questions: { q1: q.choice(null, labels256) } })).rejects.toThrow(
            DecisionRequestError,
        );

        await expect(driver.ask({ state: null, questions: { q1: q.choice(null, { only: 'one' }) } })).rejects.toThrow(
            DecisionRequestError,
        );

        await expect(
            driver.ask({ state: null, questions: { q1: q.choice(null, { '': 'empty key', opt2: 'desc' }) } }),
        ).rejects.toThrow(DecisionRequestError);
    });

    test('enforces the 2..10 score level limit', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                const [key] = Object.keys(wireBody(init).questions);
                const levels = wireBody(init).questions[key as string]?.criteria as unknown[];
                const legend: Record<string, string> = {};
                const probabilities: Record<string, number> = {};
                levels.forEach((_level, index) => {
                    legend[index] = `L${index}`;
                    probabilities[index] = index === 0 ? 1 : 0;
                });
                return Promise.resolve(
                    makeValidResponse({
                        [key as string]: { type: 'score', score: 0, confidence: 1, legend, probabilities },
                    }),
                );
            }) as unknown as typeof fetch,
        });

        const ten = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9'] as const;
        const accepted = await driver.ask({ state: null, questions: { q1: q.score(null, ten) } });
        expect(accepted.q1).toMatchObject({ kind: 'score' });

        const eleven = [...ten, 'L10'] as unknown as readonly [string, string, ...string[]];
        await expect(driver.ask({ state: null, questions: { q1: q.score(null, eleven) } })).rejects.toThrow(
            DecisionRequestError,
        );
    });

    test('validates question ID characters and length', async () => {
        const { driver, rec } = clefWithOptions();

        for (const badId of ['has space', 'bad/slash', 'a'.repeat(101)]) {
            await expect(driver.ask({ state: null, questions: { [badId]: q.noul() } })).rejects.toThrow(
                DecisionRequestError,
            );
        }
        expect(rec.callCount()).toBe(0);
    });
});

describe('JSON serialization and size limits', () => {
    test('rejects un-serializable state before transport', async () => {
        const { driver, rec } = clefWithOptions();

        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        const sparse: unknown[] = [1, 2];
        sparse[5] = 10;

        // A symbol key is invisible to Object.keys and dropped by JSON.stringify.
        const symbolKeyed = { visible: 1, [Symbol('hidden')]: 2 };
        const arrayWithExtraProp: unknown[] & { extra?: number } = [1, 2];
        arrayWithExtraProp.extra = 3;
        const nonEnumerableHolder: Record<string, unknown> = { visible: 1 };
        Object.defineProperty(nonEnumerableHolder, 'hidden', { value: 2, enumerable: false });

        const badStates: unknown[] = [
            circular,
            symbolKeyed,
            arrayWithExtraProp,
            nonEnumerableHolder,
            { num: BigInt(42) },
            { fn: () => undefined },
            { sym: Symbol('s') },
            { missing: undefined },
            sparse,
            { date: new Date() },
            { nan: Number.NaN },
            { inf: Number.POSITIVE_INFINITY },
        ];

        for (const state of badStates) {
            await expect(driver.ask({ state: state as never, questions: { q1: q.noul() } })).rejects.toThrow(
                DecisionRequestError,
            );
        }
        expect(rec.callCount()).toBe(0);
    });

    test('rejects an unserializable description in the request body, not only in state', async () => {
        const { driver, rec } = clefWithOptions();
        await expect(
            driver.ask({
                state: null,
                questions: { q1: q.noul({ bad: () => undefined } as never) },
            }),
        ).rejects.toThrow(DecisionRequestError);
        expect(rec.callCount()).toBe(0);
    });

    test('enforces the UTF-8 13 MiB request cap before transport', async () => {
        const { driver, rec } = clefWithOptions();
        await expect(driver.ask({ state: 'é'.repeat(7 * 1024 * 1024), questions: { q1: q.noul() } })).rejects.toThrow(
            DecisionRequestError,
        );
        expect(rec.callCount()).toBe(0);
    });

    test('rejects a response that exceeds the 8 MiB cap', async () => {
        // The body must be *valid* JSON above the cap: a truncated body would fail JSON.parse and
        // mask a removed `maxResponseBytes`/`truncated` guard. Under the cap this envelope parses
        // and answers normally, so the size-specific message is what proves the cap fired.
        const filler = 'z'.repeat(9 * 1024 * 1024);
        const oversize = JSON.stringify({
            success: true,
            result: { model: 'clef-flash', padding: filler, answers: { q1: { type: 'noul', noul: 0.5 } } },
        });
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () => new Response(oversize, { status: 200 })) as unknown as typeof fetch,
        });
        await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(/8 MiB/);
    });
});

describe('Response envelope, mapping and error taxonomy', () => {
    test('accepts a nonempty response model whose spelling differs from the request selector', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () =>
                makeValidResponse(
                    { q1: { type: 'noul', noul: 0.9 } },
                    '@cf/cloudflare/clef-flash-v2-full',
                )) as unknown as typeof fetch,
        });

        const answers = await driver.ask({ state: null, questions: { q1: q.noul() } });
        expect(answers.q1).toMatchObject({ kind: 'noul' });
    });

    test('rejects an empty or non-string response model', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () => makeValidResponse({ q1: { type: 'noul', noul: 0.9 } }, '')) as unknown as typeof fetch,
        });
        await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(DecisionBackendError);
    });

    test('maps malformed JSON, a failed envelope and a missing result to DecisionBackendError', async () => {
        const bodies = [
            'not json',
            JSON.stringify({ success: false, errors: [{ message: 'upstream' }] }),
            JSON.stringify({ success: true }),
        ];
        for (const body of bodies) {
            const driver = createClefDriver({
                accountId: VALID_ACCOUNT,
                apiToken: VALID_TOKEN,
                fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
            });
            await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(
                DecisionBackendError,
            );
        }
    });

    test('maps HTTP statuses onto the decision error taxonomy', async () => {
        const cases: Array<[number, new (...args: never[]) => Error, Record<string, string>?]> = [
            [401, DecisionAuthError],
            [403, DecisionAuthError],
            [429, DecisionRateLimitError],
            [400, DecisionRequestError],
            [404, DecisionRequestError],
            [500, DecisionBackendError],
            [503, DecisionBackendError],
            [302, DecisionBackendError, { Location: '/other' }],
        ];
        for (const [status, ErrorClass, headers] of cases) {
            const driver = createClefDriver({
                accountId: VALID_ACCOUNT,
                apiToken: VALID_TOKEN,
                fetch: (async () => new Response('upstream text', { status, headers })) as unknown as typeof fetch,
            });
            await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(ErrorClass);
        }
    });

    test('preserves numeric and HTTP-date Retry-After, leaves invalid hints undefined', async () => {
        const numeric = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () =>
                new Response('slow down', {
                    status: 429,
                    headers: { 'Retry-After': '120' },
                })) as unknown as typeof fetch,
        });
        try {
            await numeric.ask({ state: null, questions: { q1: q.noul() } });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(DecisionRateLimitError);
            expect((err as DecisionRateLimitError).retryAfterMs).toBe(120_000);
        }

        const httpDate = new Date(Date.now() + 10_000).toUTCString();
        const dated = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () =>
                new Response('slow down', {
                    status: 429,
                    headers: { 'Retry-After': httpDate },
                })) as unknown as typeof fetch,
        });
        try {
            await dated.ask({ state: null, questions: { q1: q.noul() } });
            expect.unreachable();
        } catch (err) {
            const retryAfterMs = (err as DecisionRateLimitError).retryAfterMs;
            expect(retryAfterMs).toBeDefined();
            expect(retryAfterMs as number).toBeGreaterThanOrEqual(0);
        }

        for (const header of [undefined, 'not-a-date']) {
            const invalid = createClefDriver({
                accountId: VALID_ACCOUNT,
                apiToken: VALID_TOKEN,
                fetch: (async () =>
                    new Response('slow down', {
                        status: 429,
                        ...(header ? { headers: { 'Retry-After': header } } : {}),
                    })) as unknown as typeof fetch,
            });
            try {
                await invalid.ask({ state: null, questions: { q1: q.noul() } });
                expect.unreachable();
            } catch (err) {
                expect((err as DecisionRateLimitError).retryAfterMs).toBeUndefined();
            }
        }
    });

    test('maps a request timeout to DecisionTimeoutError via the real APIClient', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            timeoutMs: 50,
            fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('The operation was aborted.', 'AbortError')),
                    );
                })) as unknown as typeof fetch,
        });

        await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(DecisionTimeoutError);
    });

    test('maps a network failure to DecisionConnectionError', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () => {
                throw new TypeError('fetch failed');
            }) as unknown as typeof fetch,
        });
        await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(DecisionConnectionError);
    });

    test('redacts credentials, state and upstream text from public errors', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () =>
                new Response('SQL syntax error in internal table users', { status: 400 })) as unknown as typeof fetch,
        });

        try {
            await driver.ask({
                state: { secretPassphrase: 'super-secret-password-123' },
                questions: { q1: q.noul() },
            });
            expect.unreachable();
        } catch (err) {
            const message = (err as Error).message;
            expect(message).not.toContain(VALID_TOKEN);
            expect(message).not.toContain('super-secret-password-123');
            expect(message).not.toContain('SQL syntax error');
            expect((err as Error).cause).toBeUndefined();
        }
    });

    test('transport errors carry no cause, message or upstream text', async () => {
        const timeoutDriver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            timeoutMs: 30,
            fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () =>
                        reject(new DOMException('The operation was aborted.', 'AbortError')),
                    );
                })) as unknown as typeof fetch,
        });
        try {
            await timeoutDriver.ask({ state: null, questions: { q1: q.noul() } });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(DecisionTimeoutError);
            expect((err as Error).cause).toBeUndefined();
            expect((err as Error).message).not.toContain(VALID_ACCOUNT);
            expect((err as Error).message).not.toContain(VALID_TOKEN);
        }

        const connectionDriver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () => {
                throw new TypeError('fetch failed: ECONNREFUSED 10.0.0.1:443');
            }) as unknown as typeof fetch,
        });
        try {
            await connectionDriver.ask({ state: null, questions: { q1: q.noul() } });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(DecisionConnectionError);
            expect((err as Error).cause).toBeUndefined();
            expect((err as Error).message).not.toContain('ECONNREFUSED');
            expect((err as Error).message).not.toContain('10.0.0.1');
        }
    });

    test('rejects an absent answers map and a non-object answer', async () => {
        const envelopes = [
            JSON.stringify({ success: true, result: { model: 'clef-flash' } }), // no answers
            makeValidResponseEnvelope({ q1: 'not an object' }),
        ];
        for (const body of envelopes) {
            const driver = createClefDriver({
                accountId: VALID_ACCOUNT,
                apiToken: VALID_TOKEN,
                fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof fetch,
            });
            await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toThrow(
                DecisionBackendError,
            );
        }
    });

    test('rejects malformed choice and score answer bodies', async () => {
        const malformed: Array<Record<string, unknown>> = [
            { q1: { type: 'choice', choice: 'opt1', confidence: 0.9 } }, // no probabilities
            { q1: { type: 'choice', choice: 'opt1', probabilities: { opt1: 1, opt2: 0 } } }, // no confidence
            { q1: { type: 'choice', confidence: 0.9, probabilities: { opt1: 1, opt2: 0 } } }, // no choice
            { q1: { type: 'score', score: 0, confidence: 1, probabilities: { 0: 1, 1: 0 } } }, // no legend
            { q1: { type: 'score', confidence: 1, legend: { 0: 'a', 1: 'b' }, probabilities: { 0: 1, 1: 0 } } },
        ];
        for (const answers of malformed) {
            const driver = createClefDriver({
                accountId: VALID_ACCOUNT,
                apiToken: VALID_TOKEN,
                fetch: (async () => makeValidResponse(answers)) as unknown as typeof fetch,
            });
            await expect(driver.ask({ state: null, questions: { q1: q.score(null, ['a', 'b']) } })).rejects.toThrow(
                DecisionBackendError,
            );
        }
    });

    test('rejects answer correspondence, an unknown answer kind and unnormalized mass', async () => {
        const badResponses: Array<Record<string, unknown>> = [
            { otherQuestion: { type: 'noul', noul: 0.5 } }, // names do not match
            { q1: { type: 'noul' } }, //    missing probability
            { q1: { type: 'unknown' } }, // unknown answer kind
            { q1: { type: 'choice', choice: 'opt1', confidence: 0.5, probabilities: { opt1: 0.5, opt2: 0.3 } } },
        ];
        for (const answers of badResponses) {
            const driver = createClefDriver({
                accountId: VALID_ACCOUNT,
                apiToken: VALID_TOKEN,
                fetch: (async () => makeValidResponse(answers)) as unknown as typeof fetch,
            });
            await expect(
                driver.ask({ state: null, questions: { q1: q.choice(null, { opt1: 'a', opt2: 'b' }) } }),
            ).rejects.toThrow(DecisionBackendError);
        }
    });

    test('never fabricates an answer when the backend fails', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch,
        });
        await expect(driver.ask({ state: null, questions: { q1: q.noul() } })).rejects.toBeInstanceOf(
            DecisionBackendError,
        );
    });
});

describe('Facade composition and convenience methods', () => {
    test('choice, score and noul sugar all route through the Clef driver', async () => {
        const driver = createClefDriver({
            accountId: VALID_ACCOUNT,
            apiToken: VALID_TOKEN,
            fetch: ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
                const body = wireBody(init);
                const key = Object.keys(body.questions)[0] as string;
                const type = body.questions[key]?.type;
                if (type === 'choice') {
                    return Promise.resolve(
                        makeValidResponse({
                            [key]: {
                                type: 'choice',
                                choice: 'approve',
                                confidence: 0.95,
                                probabilities: { approve: 0.95, reject: 0.05 },
                            },
                        }),
                    );
                }
                if (type === 'score') {
                    return Promise.resolve(
                        makeValidResponse({
                            [key]: {
                                type: 'score',
                                score: 2,
                                confidence: 0.9,
                                legend: { 0: 'low', 1: 'med', 2: 'high' },
                                probabilities: { 0: 0.05, 1: 0.05, 2: 0.9 },
                            },
                        }),
                    );
                }
                return Promise.resolve(makeValidResponse({ [key]: { type: 'noul', noul: 0.88 } }));
            }) as unknown as typeof fetch,
        });

        const dm = createDecisionMaker({ driver });
        expect(dm.driver).toBe('clef');

        const choice = await dm.choice('state', 'prompt', { approve: 'good', reject: 'bad' });
        expect(choice.label).toBe('approve');
        expect(choice.confidence).toBe(0.95);

        const score = await dm.score('state', 'prompt', ['low', 'med', 'high']);
        expect(score.score).toBe(2);
        expect(score.confidence).toBe(0.9);

        const noul = await dm.noul('state', 'prompt');
        expect(noul.probability).toBe(0.88);
    });
});
